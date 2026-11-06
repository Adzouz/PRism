import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  boardSettings,
  prLabel,
  type BoardPr,
  type BoardSettings,
  type BoardStage,
  type PrDetail,
  type ReviewThread,
} from '@shared/domain'
import { prFlags, prs, repos } from '../db/schema'
import { getSetting, setSetting } from '../db/settings'
import type { Ctx } from './context'
import type { GithubApi } from './gh-api'
import { getRepo } from './repos'
import { ciOfChecks, fetchChecks } from './checks'
import { stageAllowedIn, stageBasis, tabOf } from './pr-stage'
import {
  boardRunFor,
  dismissRunsForPr,
  latestBoardRuns,
  type BoardRunInfo,
  type PrRuns,
} from './runs'

const labelList = z.array(prLabel)

function parseLabels(json: string) {
  try {
    return labelList.parse(JSON.parse(json))
  } catch {
    return []
  }
}

function selectBoard(ctx: Ctx) {
  return ctx.db
    .select({ pr: prs, flags: prFlags, owner: repos.owner, name: repos.name })
    .from(prs)
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .leftJoin(prFlags, eq(prFlags.prId, prs.id))
}

type BoardRow = Awaited<ReturnType<ReturnType<typeof selectBoard>['all']>>[number]

const boardRunOf = (run: BoardRunInfo): BoardPr['run'] => ({
  id: run.id,
  stage: run.stage,
  status: run.status,
  progress: run.progress,
  error: run.error,
  verdict: run.verdict,
  findings: run.findings,
  ask: run.ask,
})

function toBoardPr({ pr, flags, owner, name }: BoardRow, set?: PrRuns): BoardPr {
  const derived = pr.derivedStage as BoardStage
  const manual = (flags?.manualStage as BoardStage | null | undefined) ?? null
  const tab = tabOf(pr.myRole)
  const picked = set ? boardRunFor(tab, set, { state: pr.state, myReviewAt: pr.myReviewAt }) : null
  const overlay = picked?.stage ?? null
  return {
    id: pr.id,
    repoId: pr.repoId,
    repo: `${owner}/${name}`,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    authorAvatar: pr.authorAvatar,
    isDraft: pr.isDraft,
    state: pr.state,
    ciState: pr.ciState,
    labels: parseLabels(pr.labelsJson),
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    unresolvedThreads: pr.unresolvedThreads,
    reviewRequested: pr.reviewRequested,
    requestedTeam: pr.requestedTeam,
    myReviewState: pr.myReviewState,
    role: pr.myRole,
    tab,
    derivedStage: derived,
    stage: overlay ?? manual ?? derived,
    manual: overlay === null && manual !== null,
    stageSince: pr.stageSince,
    updatedAt: pr.updatedAt,
    closedAt: pr.closedAt,
    starred: flags?.starred ?? false,
    hidden: flags?.hidden ?? false,
    archivedAt: flags?.archivedAt ?? null,
    run: picked ? boardRunOf(picked.run) : null,
  }
}

export function listPrs(ctx: Ctx) {
  const latest = latestBoardRuns(ctx)
  return selectBoard(ctx)
    .all()
    .map((row) => toBoardPr(row, latest.get(row.pr.id)))
}

export function getPr(ctx: Ctx, id: number) {
  const row = selectBoard(ctx).where(eq(prs.id, id)).get()
  if (!row) throw new Error(`Pull request ${id} not found`)
  return toBoardPr(row, latestBoardRuns(ctx).get(id))
}

function upsertFlags(ctx: Ctx, prId: number, set: Partial<typeof prFlags.$inferInsert>) {
  ctx.db
    .insert(prFlags)
    .values({ prId, ...set })
    .onConflictDoUpdate({ target: prFlags.prId, set })
    .run()
}

export function setPrFlags(
  ctx: Ctx,
  input: { id: number; starred?: boolean; hidden?: boolean; archived?: boolean },
) {
  const set: Partial<typeof prFlags.$inferInsert> = {}
  if (input.starred !== undefined) set.starred = input.starred
  if (input.hidden !== undefined) set.hidden = input.hidden
  if (input.archived !== undefined) {
    set.archivedAt = input.archived ? Date.now() : null
    set.restoredAt = input.archived ? null : Date.now()
  }
  if (Object.keys(set).length > 0) upsertFlags(ctx, input.id, set)
  return getPr(ctx, input.id)
}

export function setPrStage(ctx: Ctx, input: { id: number; stage: BoardStage | null }) {
  const row = ctx.db.select().from(prs).where(eq(prs.id, input.id)).get()
  if (!row) throw new Error(`Pull request ${input.id} not found`)
  const tab = tabOf(row.myRole)
  const stage = input.stage === row.derivedStage ? null : input.stage
  if (stage && !stageAllowedIn(tab, stage)) throw new Error('That column is not on this board')
  const basis = stageBasis({
    state: row.state,
    isDraft: row.isDraft,
    reviewDecision: row.reviewDecision,
    headOid: row.headOid,
    reviewRequested: row.reviewRequested,
    myReview: row.myReviewState
      ? { state: row.myReviewState, oid: row.myReviewOid, at: row.myReviewAt ?? 0 }
      : null,
    unresolvedThreads: row.unresolvedThreads,
    role: row.myRole,
  })
  dismissRunsForPr(ctx, row.id)
  upsertFlags(ctx, row.id, { manualStage: stage, manualStageBasis: stage ? basis : null })
  ctx.db.update(prs).set({ stageSince: Date.now() }).where(eq(prs.id, row.id)).run()
  return getPr(ctx, row.id)
}

export function getBoardSettings(ctx: Ctx): BoardSettings {
  return getSetting(ctx.db, 'board', boardSettings, { autoArchiveDone: true })
}

export function setBoardSettings(ctx: Ctx, value: BoardSettings) {
  setSetting(ctx.db, 'board', value)
  return value
}

const detailQuery = `
  query Detail($id: ID!) {
    node(id: $id) { ... on PullRequest {
      bodyHTML headRefName baseRefName createdAt mergeable
      headRepositoryOwner { login }
      commits { totalCount }
      labels(first: 30) { nodes { name color } }
      closingIssuesReferences(first: 10) { nodes { number title url state } }
      reviewRequests(first: 30) { nodes { requestedReviewer {
        __typename ... on User { login avatarUrl } ... on Team { slug avatarUrl }
      } } }
      latestOpinionatedReviews(first: 30) { nodes { state author { login avatarUrl } } }
    } }
  }
`

type DetailNode = {
  bodyHTML: string
  headRefName: string
  baseRefName: string
  createdAt: string
  mergeable: string | null
  headRepositoryOwner: { login: string } | null
  commits: { totalCount: number }
  labels: { nodes: { name: string; color: string }[] }
  closingIssuesReferences: {
    nodes: { number: number; title: string; url: string; state: string }[]
  }
  reviewRequests: {
    nodes: {
      requestedReviewer: {
        __typename: string
        login?: string
        slug?: string
        avatarUrl?: string
      } | null
    }[]
  }
  latestOpinionatedReviews: {
    nodes: { state: string; author: { login: string; avatarUrl: string } | null }[]
  }
}

export async function prDetail(ctx: Ctx, api: GithubApi, id: number): Promise<PrDetail> {
  const row = ctx.db
    .select({ nodeId: prs.nodeId, repoId: prs.repoId })
    .from(prs)
    .where(eq(prs.id, id))
    .get()
  if (!row) throw new Error(`Pull request ${id} not found`)
  const ignored = getRepo(ctx, row.repoId).ignoredChecks
  const [{ node }, checks] = await Promise.all([
    api.graphql<{ node: DetailNode | null }>(detailQuery, { id: row.nodeId }),
    fetchChecks(api, row.nodeId, ignored),
  ])
  if (!node) throw new Error('Pull request not found on GitHub')
  checks.sort((a, b) => Number(a.ignored) - Number(b.ignored) || a.name.localeCompare(b.name))

  const reviewers = [
    ...node.latestOpinionatedReviews.nodes.map((review) => ({
      name: review.author?.login ?? 'ghost',
      avatar: review.author?.avatarUrl ?? null,
      kind: 'user' as const,
      state: review.state,
    })),
    ...node.reviewRequests.nodes.flatMap(({ requestedReviewer: reviewer }) =>
      reviewer
        ? [
            {
              name: reviewer.login ?? reviewer.slug ?? 'unknown',
              avatar: reviewer.avatarUrl ?? null,
              kind: reviewer.__typename === 'Team' ? ('team' as const) : ('user' as const),
              state: 'REQUESTED',
            },
          ]
        : [],
    ),
  ]

  return {
    id,
    bodyHtml: node.bodyHTML,
    headRef: node.headRefName,
    baseRef: node.baseRefName,
    headOwner: node.headRepositoryOwner?.login ?? null,
    commits: node.commits.totalCount,
    createdAt: Date.parse(node.createdAt),
    mergeable: node.mergeable,
    labels: node.labels.nodes,
    linkedIssues: node.closingIssuesReferences.nodes,
    reviewers,
    checks,
    ciState: ciOfChecks(checks),
  }
}

const threadsQuery = `
  query Threads($id: ID!) {
    node(id: $id) { ... on PullRequest {
      reviewThreads(first: 100) { nodes {
        id isResolved isOutdated path line originalLine
        comments(first: 30) { totalCount nodes {
          id body createdAt url author { login avatarUrl }
        } }
      } }
    } }
  }
`

type ThreadNode = {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  originalLine: number | null
  comments: {
    totalCount: number
    nodes: {
      id: string
      body: string
      createdAt: string
      url: string
      author: { login: string; avatarUrl: string } | null
    }[]
  }
}

export async function prThreads(ctx: Ctx, api: GithubApi, id: number): Promise<ReviewThread[]> {
  const row = ctx.db.select({ nodeId: prs.nodeId }).from(prs).where(eq(prs.id, id)).get()
  if (!row) throw new Error(`Pull request ${id} not found`)
  const { node } = await api.graphql<{
    node: { reviewThreads: { nodes: ThreadNode[] } } | null
  }>(threadsQuery, { id: row.nodeId })
  if (!node) throw new Error('Pull request not found on GitHub')
  return node.reviewThreads.nodes.map((thread) => ({
    id: thread.id,
    path: thread.path,
    line: thread.line ?? thread.originalLine,
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    totalComments: thread.comments.totalCount,
    comments: thread.comments.nodes.map((comment) => ({
      id: comment.id,
      author: comment.author?.login ?? 'ghost',
      avatar: comment.author?.avatarUrl ?? null,
      body: comment.body,
      createdAt: Date.parse(comment.createdAt),
      url: comment.url,
    })),
  }))
}
