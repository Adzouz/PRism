import { and, eq, isNotNull, isNull, lt, ne } from 'drizzle-orm'
import type { CiState, PrLabel, Repo, SyncStatus } from '@shared/domain'
import { prFlags, prs, snapshots } from '../db/schema'
import type { Ctx } from './context'
import type { GithubApi } from './gh-api'
import {
  checkCountsFields,
  ciFromCounts,
  ciOfChecks,
  fetchChecks,
  type CheckCounts,
} from './checks'
import { deriveStage, stageBasis, tabOf, type PrFacts } from './pr-stage'
import { getBoardSettings } from './prs'
import { listRepos } from './repos'

export type GqlPr = {
  id: string
  number: number
  title: string
  url: string
  isDraft: boolean
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  createdAt: string
  updatedAt: string
  closedAt: string | null
  author: { login: string; avatarUrl: string } | null
  headRefName: string
  headRefOid: string
  baseRefName: string
  baseRefOid: string
  reviewDecision: string | null
  additions: number
  deletions: number
  changedFiles: number
  labels: { nodes: PrLabel[] }
  reviewRequests: {
    nodes: { requestedReviewer: { __typename: string; login?: string; slug?: string } | null }[]
  }
  reviews: {
    nodes: { state: string; submittedAt: string | null; commit: { oid: string } | null }[]
  }
  reviewThreads: { nodes: { isResolved: boolean }[] }
  commits: { nodes: { commit: { statusCheckRollup: { contexts: CheckCounts } | null } }[] }
  recent?: {
    nodes: {
      commit: {
        parents: { totalCount: number }
        committer: { user: { login: string } | null } | null
        authors: { nodes: { user: { login: string } | null }[] }
      }
    }[]
  }
}

const prFields = `
  id number title url isDraft state createdAt updatedAt closedAt
  author { login avatarUrl }
  headRefName headRefOid baseRefName baseRefOid reviewDecision additions deletions changedFiles
  labels(first: 20) { nodes { name color } }
  reviewRequests(first: 30) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
  }
  reviews(last: 1, author: $login, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) {
    nodes { state submittedAt commit { oid } }
  }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { statusCheckRollup { ${checkCountsFields} } } } }
`

const searchQuery = `
  query Board($login: String!, $req: String!, $rev: String!, $auth: String!, $inv: String!) {
    req: search(query: $req, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${prFields} } } }
    rev: search(query: $rev, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${prFields} } } }
    auth: search(query: $auth, type: ISSUE, first: 50) { nodes { ... on PullRequest { ${prFields} } } }
    inv: search(query: $inv, type: ISSUE, first: 30) { nodes { ... on PullRequest {
      ${prFields}
      recent: commits(last: 20) { nodes { commit {
        parents { totalCount }
        committer { user { login } }
        authors(first: 3) { nodes { user { login } } }
      } } }
    } } }
  }
`

const nodesQuery = `
  query Refresh($login: String!, $ids: [ID!]!) {
    nodes(ids: $ids) { ... on PullRequest { ${prFields} } }
  }
`

const countsQuery = `
  query Counts($a: String!, $b: String!, $c: String!, $d: String!, $e: String!, $f: String!, $g: String!) {
    openPrs: search(query: $a, type: ISSUE, first: 0) { issueCount }
    openIssues: search(query: $b, type: ISSUE, first: 0) { issueCount }
    awaitingMe: search(query: $c, type: ISSUE, first: 0) { issueCount }
    myOpen: search(query: $d, type: ISSUE, first: 0) { issueCount }
    opened: search(query: $e, type: ISSUE, first: 0) { issueCount }
    merged: search(query: $f, type: ISSUE, first: 0) { issueCount }
    closed: search(query: $g, type: ISSUE, first: 0) { issueCount }
  }
`

type Search = { nodes: (GqlPr | Record<string, never> | null)[] }

const isPr = (node: GqlPr | Record<string, never> | null): node is GqlPr =>
  !!node && 'id' in node && typeof node.number === 'number'

const time = (value: string | null) => (value ? Date.parse(value) : null)

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase()

async function ciOf(api: GithubApi, repo: Repo, pr: GqlPr) {
  const counts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts
  const ci = ciFromCounts(counts)
  if (ci !== 'failure' || repo.ignoredChecks.length === 0 || pr.state !== 'OPEN') return ci
  return ciOfChecks(await fetchChecks(api, pr.id, repo.ignoredChecks))
}

export function hasTakeoverCommits(pr: GqlPr, login: string) {
  return (pr.recent?.nodes ?? []).some(
    ({ commit }) =>
      commit.parents.totalCount === 1 &&
      same(commit.committer?.user?.login, login) &&
      commit.authors.nodes.some((author) => same(author.user?.login, login)),
  )
}

type Row = typeof prs.$inferSelect
type FlagRow = typeof prFlags.$inferSelect

export function applyPr(
  ctx: Ctx,
  repo: Repo,
  pr: GqlPr,
  options: {
    login: string
    inRequestSearch: boolean
    refreshed: boolean
    takeover: boolean
    ci: CiState
    now: number
  },
) {
  const { login, now } = options
  const prev = ctx.db.select().from(prs).where(eq(prs.nodeId, pr.id)).get()
  const flags = prev
    ? ctx.db.select().from(prFlags).where(eq(prFlags.prId, prev.id)).get()
    : undefined

  const requests = pr.reviewRequests.nodes.map((node) => node.requestedReviewer).filter(Boolean)
  const direct = requests.some((reviewer) => same(reviewer?.login, login))
  const teams = requests.flatMap((reviewer) =>
    reviewer?.__typename === 'Team' && reviewer.slug ? [reviewer.slug] : [],
  )
  const review = pr.reviews.nodes[0]
  const myReview =
    review && review.submittedAt
      ? { state: review.state, oid: review.commit?.oid ?? null, at: Date.parse(review.submittedAt) }
      : null
  const teamRequestKept =
    options.refreshed &&
    teams.length > 0 &&
    !!prev?.reviewRequested &&
    (myReview?.at ?? null) === prev.myReviewAt
  const reviewRequested = direct || options.inRequestSearch || teamRequestKept
  const author = pr.author?.login ?? 'ghost'
  const role = same(author, login)
    ? 'author'
    : options.takeover || (!pr.recent && prev?.myRole === 'takeover')
      ? 'takeover'
      : 'reviewer'
  const facts: PrFacts = {
    state: pr.state,
    isDraft: pr.isDraft,
    reviewDecision: pr.reviewDecision,
    headOid: pr.headRefOid,
    reviewRequested,
    myReview,
    unresolvedThreads: pr.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    role,
  }
  const derivedStage = deriveStage(facts)
  const basis = stageBasis(facts)
  const manualKept =
    flags?.manualStage && flags.manualStageBasis === basis ? flags.manualStage : null
  const effective = manualKept ?? derivedStage
  const prevEffective = prev ? (flags?.manualStage ?? prev.derivedStage) : null

  const values = {
    repoId: repo.id,
    nodeId: pr.id,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author,
    authorAvatar: pr.author?.avatarUrl ?? null,
    isDraft: pr.isDraft,
    state: pr.state,
    headRef: pr.headRefName,
    headOid: pr.headRefOid,
    baseRef: pr.baseRefName,
    baseOid: pr.baseRefOid,
    reviewDecision: pr.reviewDecision,
    ciState: options.ci,
    labelsJson: JSON.stringify(pr.labels.nodes.map(({ name, color }) => ({ name, color }))),
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    unresolvedThreads: facts.unresolvedThreads,
    reviewRequested,
    requestedTeam: reviewRequested && !direct ? (teams[0] ?? null) : null,
    myReviewState: myReview?.state ?? null,
    myReviewOid: myReview?.oid ?? null,
    myReviewAt: myReview?.at ?? null,
    myRole: role,
    derivedStage,
    stageSince: prev
      ? prevEffective === effective
        ? prev.stageSince
        : now
      : Math.max(Date.parse(pr.createdAt), myReview?.at ?? 0, time(pr.closedAt) ?? 0),
    createdAt: Date.parse(pr.createdAt),
    updatedAt: Date.parse(pr.updatedAt),
    closedAt: time(pr.closedAt),
    syncedAt: now,
  } satisfies Omit<Row, 'id'>

  const row = ctx.db
    .insert(prs)
    .values(values)
    .onConflictDoUpdate({ target: prs.nodeId, set: values })
    .returning()
    .get()
  if (flags?.manualStage && !manualKept) {
    ctx.db
      .update(prFlags)
      .set({ manualStage: null, manualStageBasis: null })
      .where(eq(prFlags.prId, row.id))
      .run()
  }
  return { row, facts, flags }
}

function shouldTrack(flags: FlagRow | undefined, facts: PrFacts) {
  if (facts.state !== 'OPEN' || tabOf(facts.role) === 'mine') return true
  if (facts.reviewRequested || facts.myReview) return true
  return !!flags?.starred || !!flags?.archivedAt
}

const repoSlug = (repo: Repo) => `${repo.owner}/${repo.name}`

const today = (now: number) => new Date(now).toISOString().slice(0, 10)

async function writeSnapshot(ctx: Ctx, api: GithubApi, repo: Repo, now: number) {
  const day = today(now)
  const existing = ctx.db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.repoId, repo.id), eq(snapshots.day, day)))
    .get()
  if (existing && now - existing.takenAt < 30 * 60_000) return
  const r = `repo:${repoSlug(repo)}`
  const data = await api.graphql<Record<string, { issueCount: number }>>(countsQuery, {
    a: `${r} is:pr is:open`,
    b: `${r} is:issue is:open`,
    c: `${r} is:pr is:open review-requested:@me`,
    d: `${r} is:pr is:open author:@me`,
    e: `${r} is:pr created:${day}`,
    f: `${r} is:pr merged:${day}`,
    g: `${r} is:pr is:unmerged closed:${day}`,
  })
  const count = (key: string) => data[key]?.issueCount ?? 0
  const values = {
    repoId: repo.id,
    day,
    openPrs: count('openPrs'),
    openIssues: count('openIssues'),
    awaitingMe: count('awaitingMe'),
    myOpen: count('myOpen'),
    opened: count('opened'),
    merged: count('merged'),
    closed: count('closed'),
    latencyMedianS: null,
    takenAt: now,
  }
  ctx.db
    .insert(snapshots)
    .values(values)
    .onConflictDoUpdate({ target: [snapshots.repoId, snapshots.day], set: values })
    .run()
}

export async function syncRepo(
  ctx: Ctx,
  api: GithubApi,
  repo: Repo,
  login: string,
  options: { lightCheck?: boolean; now?: number } = {},
) {
  const now = options.now ?? Date.now()
  const r = `repo:${repoSlug(repo)} is:pr is:open`
  const data = await api.graphql<Record<'req' | 'rev' | 'auth' | 'inv', Search>>(searchQuery, {
    login,
    req: `${r} review-requested:@me`,
    rev: `${r} reviewed-by:@me -author:@me`,
    auth: `${r} author:@me`,
    inv: `${r} involves:@me -author:@me`,
  })
  const requested = new Set(data.req.nodes.filter(isPr).map((pr) => pr.id))
  const found = new Map<string, { pr: GqlPr; takeover: boolean; refreshed?: boolean }>()
  for (const key of ['req', 'rev', 'auth'] as const) {
    for (const pr of data[key].nodes.filter(isPr)) found.set(pr.id, { pr, takeover: false })
  }
  for (const pr of data.inv.nodes.filter(isPr)) {
    const takeover = hasTakeoverCommits(pr, login)
    const tracked = ctx.db.select({ id: prs.id }).from(prs).where(eq(prs.nodeId, pr.id)).get()
    if (takeover || tracked || found.has(pr.id)) found.set(pr.id, { pr, takeover })
  }

  const archived = new Set(
    ctx.db
      .select({ id: prs.nodeId })
      .from(prs)
      .innerJoin(prFlags, eq(prFlags.prId, prs.id))
      .where(and(eq(prs.repoId, repo.id), isNotNull(prFlags.archivedAt)))
      .all()
      .map((row) => row.id),
  )
  const stale = ctx.db
    .select({ nodeId: prs.nodeId })
    .from(prs)
    .where(and(eq(prs.repoId, repo.id), eq(prs.state, 'OPEN')))
    .all()
    .map((row) => row.nodeId)
    .filter((id) => !found.has(id) && (options.lightCheck || !archived.has(id)))
  for (let index = 0; index < stale.length; index += 50) {
    const ids = stale.slice(index, index + 50)
    const refreshed = await api.graphql<{ nodes: (GqlPr | null)[] }>(nodesQuery, { login, ids })
    for (const pr of refreshed.nodes.filter(isPr)) {
      found.set(pr.id, { pr, takeover: false, refreshed: true })
    }
  }

  const entries = [...found.values()]
  const cis = await Promise.all(entries.map(({ pr }) => ciOf(api, repo, pr)))
  for (const [index, { pr, takeover, refreshed }] of entries.entries()) {
    const { row, facts, flags } = applyPr(ctx, repo, pr, {
      login,
      inRequestSearch: requested.has(pr.id),
      refreshed: refreshed ?? false,
      takeover,
      ci: cis[index] ?? 'none',
      now,
    })
    if (!shouldTrack(flags, facts)) ctx.db.delete(prs).where(eq(prs.id, row.id)).run()
  }

  await writeSnapshot(ctx, api, repo, now)

  const rows = ctx.db
    .select({ role: prs.myRole })
    .from(prs)
    .leftJoin(prFlags, eq(prFlags.prId, prs.id))
    .where(and(eq(prs.repoId, repo.id), eq(prs.state, 'OPEN'), isNull(prFlags.archivedAt)))
    .all()
  return {
    reviews: rows.filter((row) => row.role === 'reviewer').length,
    mine: rows.filter((row) => row.role !== 'reviewer').length,
  }
}

export function autoArchiveDone(ctx: Ctx, now = Date.now()) {
  if (!getBoardSettings(ctx).autoArchiveDone) return 0
  const due = ctx.db
    .select({ id: prs.id })
    .from(prs)
    .leftJoin(prFlags, eq(prFlags.prId, prs.id))
    .where(
      and(
        ne(prs.state, 'OPEN'),
        lt(prs.closedAt, now - 24 * 3600_000),
        isNull(prFlags.archivedAt),
        isNull(prFlags.restoredAt),
      ),
    )
    .all()
    .map((row) => row.id)
  if (due.length === 0) return 0
  for (const prId of due) {
    ctx.db
      .insert(prFlags)
      .values({ prId, archivedAt: now })
      .onConflictDoUpdate({ target: prFlags.prId, set: { archivedAt: now } })
      .run()
  }
  return due.length
}

export type SyncHooks = {
  status: (status: SyncStatus) => void
  changed: () => void
  login: () => Promise<string | null>
  enabled: () => boolean
}

const fullEvery = 5 * 60_000
const fullWhilePending = 2 * 60_000
const lightEvery = 10 * 60_000
const focusEvery = 60_000

function hasPendingCi(ctx: Ctx) {
  return !!ctx.db
    .select({ id: prs.id })
    .from(prs)
    .leftJoin(prFlags, eq(prFlags.prId, prs.id))
    .where(and(eq(prs.state, 'OPEN'), eq(prs.ciState, 'pending'), isNull(prFlags.archivedAt)))
    .get()
}

export function createSyncService(ctx: Ctx, api: GithubApi, hooks: SyncHooks) {
  let status: SyncStatus = {
    running: false,
    lastSyncAt: null,
    lastError: null,
    rate: null,
    repos: [],
  }
  let current: Promise<SyncStatus> | null = null
  let currentForced = false
  let followUp: Promise<SyncStatus> | null = null
  let timer: NodeJS.Timeout | null = null
  let lastFullAt = 0
  let lastLightAt = 0

  function publish(patch: Partial<SyncStatus>) {
    status = { ...status, ...patch, rate: api.rate() ?? status.rate }
    hooks.status(status)
  }

  function setRepo(repoId: number, patch: Partial<SyncStatus['repos'][number]>) {
    publish({
      repos: status.repos.map((entry) =>
        entry.repoId === repoId ? { ...entry, ...patch } : entry,
      ),
    })
  }

  async function runOnce(force: boolean) {
    const login = await hooks.login()
    if (!login) {
      publish({ lastError: 'GitHub is not connected' })
      return
    }
    const now = Date.now()
    const full =
      force ||
      now - lastFullAt > fullEvery ||
      (now - lastFullAt > fullWhilePending && hasPendingCi(ctx))
    const lightCheck = now - lastLightAt > lightEvery
    const repoList = listRepos(ctx)
    const previous = new Map(status.repos.map((entry) => [entry.repoId, entry]))
    publish({
      running: true,
      lastError: null,
      repos: repoList.map((repo) => ({
        repoId: repo.id,
        repo: repoSlug(repo),
        state: 'syncing',
        error: null,
        reviews: previous.get(repo.id)?.reviews ?? 0,
        mine: previous.get(repo.id)?.mine ?? 0,
      })),
    })
    let failed: string | null = null
    for (const repo of repoList) {
      try {
        const path = `/repos/${repoSlug(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=1`
        const probe = await api.probe(path).catch(() => null)
        if (!full && probe?.unchanged) {
          setRepo(repo.id, { state: 'skipped' })
          continue
        }
        const counts = await syncRepo(ctx, api, repo, login, { lightCheck, now })
        probe?.commit()
        setRepo(repo.id, { state: 'done', ...counts })
      } catch (error) {
        failed = error instanceof Error ? error.message : String(error)
        setRepo(repo.id, { state: 'error', error: failed })
      }
      hooks.changed()
    }
    autoArchiveDone(ctx)
    if (full) lastFullAt = now
    if (lightCheck) lastLightAt = now
    publish({ running: false, lastSyncAt: Date.now(), lastError: failed })
    hooks.changed()
  }

  function syncNow(force = false): Promise<SyncStatus> {
    if (current) {
      if (!force || currentForced) return current
      followUp ??= current.then(() => {
        followUp = null
        return syncNow(true)
      })
      return followUp
    }
    currentForced = force
    current = runOnce(force)
      .catch((error: unknown) =>
        publish({
          running: false,
          lastError: error instanceof Error ? error.message : String(error),
        }),
      )
      .then(() => status)
      .finally(() => {
        current = null
      })
    return current
  }

  function budgetAllows(now: number) {
    const rate = api.rate()
    if (!rate || now > rate.resetAt) return true
    if (rate.remaining < 200) return false
    if (rate.remaining < 1000) return !status.lastSyncAt || now - status.lastSyncAt >= fullEvery
    return true
  }

  return {
    status: () => status,
    syncNow,
    tick() {
      if (hooks.enabled() && budgetAllows(Date.now())) void syncNow(false)
    },
    focus() {
      if (!hooks.enabled()) return
      if (Date.now() - lastFullAt < focusEvery) return
      if (budgetAllows(Date.now())) void syncNow(true)
    },
    start(intervalMs = 60_000) {
      timer ??= setInterval(() => this.tick(), intervalMs)
      this.tick()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

export type SyncService = ReturnType<typeof createSyncService>
