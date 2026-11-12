import { randomBytes } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  aiTag,
  findingComment,
  gateKindOf,
  gateReply,
  postMode,
  postModeLabels,
  verdict as verdictSchema,
  type Finding,
  type GateCheck,
  type GateKind,
  type GatePatch,
  type GateReply,
  type GateWorktree,
  type PostGate,
  type PostMode,
  type BoardStage,
  type Run,
} from '@shared/domain'
import { redactText } from '../agents/redact'
import { postGates, prs } from '../db/schema'
import { getSetting, setSetting } from '../db/settings'
import { run as exec } from '../system/exec'
import type { Ctx } from './context'
import { diffMap, isCommentable, type DiffMap } from './diff'
import type { GithubApi } from './gh-api'
import { reviewDirection } from './pr-stage'
import { clearManualStage, markApproved } from './prs'
import { getRepo } from './repos'
import { activeRunFor, getRun, getRunRow, linkFinding, listFindings } from './runs'

type Verdict = z.infer<typeof verdictSchema>
type GateRow = typeof postGates.$inferSelect

export type GitResult = { code: number; stdout: string; stderr: string }
export type GitExec = (
  cwd: string,
  args: string[],
  env?: Record<string, string>,
) => Promise<GitResult>

const defaultGit: GitExec = (cwd, args, env = {}) =>
  exec('git', ['-C', cwd, ...args], {
    env: { GIT_TERMINAL_PROMPT: '0', ...env },
    timeout: 300_000,
  })

export type ActionDeps = {
  ctx: Ctx
  api: GithubApi
  emit: { prsChanged: () => void }
  git?: GitExec
  sleep?: (ms: number) => Promise<void>
  verifyAttempts?: number
}

export const getPostMode = (ctx: Ctx): PostMode => getSetting(ctx.db, 'postMode', postMode, 'draft')

export function setPostMode(ctx: Ctx, mode: PostMode) {
  setSetting(ctx.db, 'postMode', mode)
  return mode
}

const gateQuery = `
  query Gate($id: ID!) {
    node(id: $id) { ... on PullRequest {
      headRefOid viewerDidAuthor
      reviews(states: PENDING, first: 1) { nodes { id body url } }
    } }
  }
`

type PendingReview = { id: string; body: string; url: string }

type GateNode = {
  headRefOid: string
  viewerDidAuthor: boolean
  reviews: { nodes: PendingReview[] }
}

const addReviewMutation = `
  mutation AddReview($input: AddPullRequestReviewInput!) {
    addPullRequestReview(input: $input) {
      pullRequestReview { id url comments(first: 100) { nodes { id path } } }
    }
  }
`

const addThreadMutation = `
  mutation AddThread($input: AddPullRequestReviewThreadInput!) {
    addPullRequestReviewThread(input: $input) { thread { comments(first: 1) { nodes { id } } } }
  }
`

const submitMutation = `
  mutation SubmitReview($input: SubmitPullRequestReviewInput!) {
    submitPullRequestReview(input: $input) { pullRequestReview { id url } }
  }
`

const updateReviewMutation = `
  mutation UpdateReview($input: UpdatePullRequestReviewInput!) {
    updatePullRequestReview(input: $input) { pullRequestReview { id url } }
  }
`

const replyMutation = `
  mutation Reply($input: AddPullRequestReviewThreadReplyInput!) {
    addPullRequestReviewThreadReply(input: $input) { comment { id url } }
  }
`

const eventEnum: Record<Verdict, string> = {
  approve: 'APPROVE',
  comment: 'COMMENT',
  request_changes: 'REQUEST_CHANGES',
}

const eventLabels: Record<Verdict, string> = {
  approve: 'Approve',
  comment: 'Comment',
  request_changes: 'Request changes',
}

const allEvents: Verdict[] = ['approve', 'comment', 'request_changes']

export const defaultCommitMessage = 'fix: address review comments'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const short = (oid: string | null) => (oid ? oid.slice(0, 7) : 'none')

function parseReplies(json: string | null): GateReply[] | null {
  if (!json) return null
  try {
    return z.array(gateReply).parse(JSON.parse(json))
  } catch {
    return null
  }
}

export function defaultReplies(run: Run): GateReply[] {
  const ids = [...new Set([...run.threadIds, ...run.replies.map((reply) => reply.threadId)])]
  return ids.map((threadId) => {
    const body =
      run.replies.find((reply) => reply.threadId === threadId)?.body ??
      run.changes?.threads.find((item) => item.threadId === threadId)?.note ??
      ''
    return { threadId, body, selected: body.trim() !== '', postedUrl: null }
  })
}

export function mergeReplies(defaults: GateReply[], stored: GateReply[] | null) {
  if (!stored) return defaults
  const byId = new Map(stored.map((reply) => [reply.threadId, reply]))
  const merged = defaults.map((reply) => byId.get(reply.threadId) ?? reply)
  const known = new Set(defaults.map((reply) => reply.threadId))
  return [...merged, ...stored.filter((reply) => !known.has(reply.threadId))]
}

export function parsePorcelain(output: string) {
  const entries = output.split('\0')
  const files: string[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.length < 4) continue
    files.push(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C') index += 1
  }
  return files
}

export const findingText = (finding: Finding) => finding.editedBody ?? findingComment(finding)

export function reviewBody(summary: string, outside: Finding[]) {
  const parts = [summary.trim()]
  if (outside.length > 0) {
    const items = outside.map((finding) => {
      const where = `${finding.path}${finding.line ? `:${finding.line}` : ''}`
      return `- \`${where}\` ${findingText(finding).replace(/\n/g, '\n  ')}`
    })
    parts.push(`**Other findings**\n\n${items.join('\n')}`)
  }
  parts.push(aiTag)
  return parts.filter(Boolean).join('\n\n')
}

export const replyBody = (body: string) => `${body.trim()}\n\n${aiTag}`

type CheckInput = {
  kind: GateKind
  mode: PostMode
  event: Verdict
  body: string
  confirmed: boolean
  included: number
  total: number
  outsideDiff: number
  pendingReview: boolean
  threadIds: string[]
  reportedThreads: string[] | null
  worktree: GateWorktree | null
  replies: GateReply[]
}

function replyCheck(replies: GateReply[]): GateCheck {
  const chosen = replies.filter((reply) => reply.selected && !reply.postedUrl)
  const empty = chosen.filter((reply) => !reply.body.trim()).length
  return {
    key: 'replies',
    label: 'Replies chosen',
    ok: chosen.length > 0 && empty === 0,
    detail:
      chosen.length === 0
        ? 'Tick at least one thread to answer'
        : empty > 0
          ? `${empty} ticked repl${empty === 1 ? 'y is' : 'ies are'} empty`
          : `${chosen.length} repl${chosen.length === 1 ? 'y' : 'ies'} to post`,
  }
}

function worktreeChecks(worktree: GateWorktree | null): GateCheck[] {
  if (!worktree) {
    const detail = 'The worktree of this run is gone'
    return [
      { key: 'commit', label: 'Changes committed', ok: false, detail },
      { key: 'push', label: 'Pushed and verified on GitHub', ok: false, detail },
    ]
  }
  const dirty = worktree.dirty.length
  const changed = worktree.localHead !== worktree.checkoutHead
  const synced =
    dirty === 0 && worktree.localHead !== null && worktree.localHead === worktree.remoteHead
  return [
    {
      key: 'commit',
      label: 'Changes committed',
      ok: dirty === 0,
      detail:
        dirty > 0
          ? `${dirty} file${dirty === 1 ? '' : 's'} not committed`
          : changed
            ? `Head ${short(worktree.localHead)}`
            : 'No code changes',
    },
    {
      key: 'push',
      label: 'Pushed and verified on GitHub',
      ok: synced,
      detail: synced
        ? `GitHub is at ${short(worktree.remoteHead)}`
        : dirty > 0
          ? 'Commit first'
          : worktree.remoteHead === null
            ? 'Could not read the head on GitHub'
            : !changed && worktree.remoteHead !== worktree.checkoutHead
              ? `GitHub moved to ${short(worktree.remoteHead)} since this run started`
              : `GitHub is at ${short(worktree.remoteHead)}, local is ${short(worktree.localHead)}`,
    },
  ]
}

export function gateChecks(input: CheckInput): GateCheck[] {
  if (input.kind === 'review') {
    const empty = input.included === 0 && !input.body.trim()
    const nothing = empty && !(input.mode === 'submit' && input.event === 'approve')
    const outside =
      input.outsideDiff > 0 ? ` · ${input.outsideDiff} outside the diff go in the review body` : ''
    return [
      {
        key: 'findings',
        label: 'Findings validated',
        ok: input.confirmed && !nothing,
        detail: nothing
          ? 'Nothing to post: include a finding or write a summary'
          : `${input.included} of ${input.total} included${outside}`,
      },
      input.mode === 'draft'
        ? {
            key: 'event',
            label: 'Review status',
            ok: true,
            detail: 'You pick it when you submit the draft on GitHub',
          }
        : {
            key: 'event',
            label: `Review status: ${eventLabels[input.event]}`,
            ok: true,
            detail: null,
          },
      {
        key: 'mode',
        label: postModeLabels[input.mode],
        ok: true,
        detail: input.pendingReview ? 'Adds to your pending review on GitHub' : null,
      },
    ]
  }
  if (input.kind === 'replies') return [replyCheck(input.replies)]
  const missing = input.reportedThreads
    ? input.threadIds.filter((id) => !input.reportedThreads!.includes(id)).length
    : input.threadIds.length
  return [
    {
      key: 'threads',
      label: 'Threads have a verdict',
      ok: input.reportedThreads !== null && missing === 0,
      detail:
        missing > 0
          ? `${missing} thread${missing === 1 ? '' : 's'} without fix, push back or defer`
          : null,
    },
    ...worktreeChecks(input.worktree),
    replyCheck(input.replies),
  ]
}

export function createActions(deps: ActionDeps) {
  const { ctx, api, emit } = deps
  const git = deps.git ?? defaultGit
  const sleep = deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)))
  const verifyAttempts = deps.verifyAttempts ?? 6
  const busy = new Set<number>()
  const diffs = new Map<string, Promise<DiffMap>>()
  let pushLock: Promise<unknown> = Promise.resolve()

  function load(runId: number) {
    const run = getRun(ctx, runId)
    const row = getRunRow(ctx, runId)
    const kind = gateKindOf[run.stage]
    if (!kind) throw new Error('This run has nothing to post')
    const pr = ctx.db.select().from(prs).where(eq(prs.id, run.prId)).get()
    if (!pr) throw new Error(`Pull request ${run.prId} not found`)
    const repo = getRepo(ctx, pr.repoId)
    let gate = ctx.db.select().from(postGates).where(eq(postGates.runId, runId)).get()
    gate ??= ctx.db.insert(postGates).values({ runId, kind }).returning().get()
    return { run, row, kind, pr, repo, gate }
  }

  type Loaded = ReturnType<typeof load>

  async function mutate<T>(query: string, variables: Record<string, unknown>) {
    const { data, errors } = await api.graphqlPartial<T>(query, variables)
    if (errors.length > 0) {
      throw new Error(redactText(errors.map((error) => error.message).join('; ')))
    }
    return data
  }

  async function liveNode(nodeId: string) {
    const { node } = await api.graphql<{ node: GateNode | null }>(gateQuery, { id: nodeId })
    if (!node) throw new Error('Pull request not found on GitHub')
    return node
  }

  async function currentHead({ pr }: Loaded) {
    try {
      return (await liveNode(pr.nodeId)).headRefOid
    } catch {
      return pr.headOid
    }
  }

  function reviewDiff({ repo, row }: Loaded) {
    if (!row.reviewedBaseOid || !row.reviewedHeadOid) return Promise.resolve<DiffMap>(new Map())
    const path = `/repos/${repo.owner}/${repo.name}/compare/${row.reviewedBaseOid}...${row.reviewedHeadOid}`
    let cached = diffs.get(path)
    if (!cached) {
      cached = api
        .get<{ files?: { filename: string; patch?: string }[] }>(path)
        .then((result) => diffMap(result.files ?? []))
      diffs.set(path, cached)
      cached.catch(() => diffs.delete(path))
    }
    return cached
  }

  async function gitOk(cwd: string, args: string[], env?: Record<string, string>) {
    const result = await git(cwd, args, env)
    if (result.code !== 0) {
      const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n')
      throw new Error(redactText(`git ${args[0]} failed: ${output}`))
    }
    return result.stdout.trim()
  }

  async function worktreeState(
    { run }: Loaded,
    remoteHead: string | null,
  ): Promise<GateWorktree | null> {
    const path = run.worktreePath
    if (!path) return null
    if (!(await stat(path).catch(() => null))?.isDirectory()) return null
    const status = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (status.code !== 0) {
      throw new Error(redactText(`git status failed: ${status.stderr.trim()}`))
    }
    return {
      path,
      dirty: parsePorcelain(status.stdout),
      localHead: await gitOk(path, ['rev-parse', 'HEAD']),
      checkoutHead: run.reviewedHeadOid,
      remoteHead,
      branch: getRunRow(ctx, run.id).pushRef,
    }
  }

  const repliesOf = ({ run, gate }: Loaded) =>
    mergeReplies(defaultReplies(run), parseReplies(gate.repliesJson))

  async function build(runId: number): Promise<PostGate> {
    const loaded = load(runId)
    const { run, kind, pr, repo, gate } = loaded
    const closed = gate.postedAt !== null || gate.skippedAt !== null
    const warnings: string[] = []
    let node: GateNode | null = null
    if (!closed) {
      try {
        node = await liveNode(pr.nodeId)
      } catch (error) {
        warnings.push(`Could not read the pull request on GitHub: ${message(error)}`)
      }
    }
    const own = node ? node.viewerDidAuthor : pr.myRole === 'author'
    const allowedEvents = own ? (['comment'] as Verdict[]) : allEvents
    const chosen = gate.event ?? run.report?.verdict ?? 'comment'
    const event = allowedEvents.includes(chosen) ? chosen : 'comment'
    const mode = gate.mode ?? repo.postMode ?? getPostMode(ctx)
    const body = gate.body ?? run.report?.summary ?? ''
    const findings = kind === 'review' ? listFindings(ctx, runId) : []
    const included = findings.filter((finding) => finding.included)
    let outsideDiff = 0
    if (kind === 'review' && !closed) {
      try {
        const map = await reviewDiff(loaded)
        outsideDiff = included.filter((finding) => !isCommentable(map, finding)).length
      } catch (error) {
        outsideDiff = included.length
        warnings.push(
          `Could not read the diff, so findings go in the review body: ${message(error)}`,
        )
      }
    }
    const replies = kind === 'review' ? [] : repliesOf(loaded)
    let worktree: GateWorktree | null = null
    if (kind === 'address' && !closed) {
      try {
        worktree = await worktreeState(loaded, node?.headRefOid ?? null)
      } catch (error) {
        warnings.push(message(error))
      }
    }
    const pendingReview = (node?.reviews.nodes.length ?? 0) > 0
    if (pendingReview && kind !== 'review') {
      warnings.push(
        'You have a pending review on this pull request: GitHub may hold these replies in it until you submit it.',
      )
    }
    const checks = gateChecks({
      kind,
      mode,
      event,
      body,
      confirmed: gate.confirmedAt !== null,
      included: included.length,
      total: findings.length,
      outsideDiff,
      pendingReview,
      threadIds: run.threadIds,
      reportedThreads: run.changes ? run.changes.threads.map((item) => item.threadId) : null,
      worktree,
      replies,
    })
    const live = activeRunFor(ctx, run.prId) !== null || run.status !== 'done'
    const direction = reviewDirection(mode, event, run.report?.verdict)
    const nextStage: BoardStage | null =
      kind === 'address'
        ? 're-review'
        : kind === 'replies'
          ? null
          : direction.goes === 'changes'
            ? 'changes-requested'
            : direction.approvedOnGithub
              ? 'approved'
              : 'to-approve'
    return {
      runId,
      prId: run.prId,
      kind,
      mode,
      modeFromRepo: gate.mode === null && repo.postMode !== null,
      event,
      allowedEvents,
      body,
      findings: { included: included.length, total: findings.length, outsideDiff },
      pendingReview,
      commitMessage: gate.commitMessage ?? defaultCommitMessage,
      worktree,
      replies,
      checks,
      ready: !closed && !live && node !== null && checks.every((check) => check.ok),
      live,
      confirmedAt: gate.confirmedAt,
      postedAt: gate.postedAt,
      skippedAt: gate.skippedAt,
      reviewUrl: gate.ghReviewUrl,
      postedBody: gate.postedBody,
      nextStage,
      warning: warnings.length > 0 ? warnings.join(' ') : null,
    }
  }

  const setGate = (runId: number, set: Partial<Omit<GateRow, 'runId' | 'kind'>>) =>
    ctx.db.update(postGates).set(set).where(eq(postGates.runId, runId)).run()

  function ensureOpen({ gate }: Loaded) {
    if (gate.postedAt !== null) throw new Error('Already posted')
    if (gate.skippedAt !== null) throw new Error('Posting was skipped for this run')
  }

  function ensureIdle({ run }: Loaded) {
    if (run.status !== 'done') throw new Error('The run has not finished')
    if (activeRunFor(ctx, run.prId)) {
      throw new Error('An agent run is in progress on this pull request. Wait for it or stop it.')
    }
  }

  async function lockPr<T>(prId: number, fn: () => Promise<T>) {
    if (busy.has(prId)) throw new Error('Another action is in progress on this pull request')
    busy.add(prId)
    try {
      return await fn()
    } finally {
      busy.delete(prId)
    }
  }

  function exclusive<T>(runId: number, fn: () => Promise<T>) {
    return lockPr(getRun(ctx, runId).prId, fn)
  }

  async function update(patch: GatePatch) {
    const loaded = load(patch.runId)
    ensureOpen(loaded)
    const set: Partial<GateRow> = {}
    if (patch.mode !== undefined) set.mode = patch.mode
    if (patch.event !== undefined) set.event = patch.event
    if (patch.body !== undefined) set.body = patch.body
    if (patch.commitMessage !== undefined) set.commitMessage = patch.commitMessage
    if (patch.confirmed !== undefined) set.confirmedAt = patch.confirmed ? Date.now() : null
    if (patch.replies !== undefined) {
      const current = repliesOf(loaded)
      const byId = new Map(current.map((reply) => [reply.threadId, reply]))
      for (const reply of patch.replies) {
        const existing = byId.get(reply.threadId)
        if (!existing) throw new Error(`Thread ${reply.threadId} is not part of this run`)
        if (existing.postedUrl) continue
        byId.set(reply.threadId, {
          ...existing,
          body: reply.body ?? existing.body,
          selected: reply.selected ?? existing.selected,
        })
      }
      set.repliesJson = JSON.stringify([...byId.values()])
    }
    if (Object.keys(set).length > 0) setGate(patch.runId, set)
    return build(patch.runId)
  }

  async function commit(runId: number, text?: string) {
    return exclusive(runId, async () => {
      const loaded = load(runId)
      ensureOpen(loaded)
      ensureIdle(loaded)
      if (loaded.kind !== 'address') throw new Error('Only address runs commit')
      const path = loaded.run.worktreePath
      if (!path) throw new Error('The run has no worktree')
      const commitMessage = (text ?? loaded.gate.commitMessage ?? defaultCommitMessage).trim()
      if (!commitMessage) throw new Error('Write a commit message')
      setGate(runId, { commitMessage })
      await gitOk(path, ['add', '-A'])
      await gitOk(path, ['commit', '-m', commitMessage])
      setGate(runId, { committedOid: await gitOk(path, ['rev-parse', 'HEAD']) })
      return build(runId)
    })
  }

  async function withPushNonce<T>(fn: (nonce: string) => Promise<T>): Promise<T> {
    const previous = pushLock
    let release!: () => void
    pushLock = new Promise<void>((done) => (release = done))
    await previous.catch(() => {})
    const dir = join(ctx.userData, 'hooks')
    const file = join(dir, '.push-nonce')
    const nonce = randomBytes(24).toString('hex')
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(file, nonce, { mode: 0o600 })
      return await fn(nonce)
    } finally {
      await rm(file, { force: true })
      release()
    }
  }

  async function push(runId: number) {
    return exclusive(runId, async () => {
      const loaded = load(runId)
      ensureOpen(loaded)
      ensureIdle(loaded)
      if (loaded.kind !== 'address') throw new Error('Only address runs push')
      const { row, pr } = loaded
      if (!row.pushRemote || !row.pushRef) {
        throw new Error('This run does not know where to push. Run Address comments again.')
      }
      const state = await worktreeState(loaded, null)
      if (!state) throw new Error('The worktree of this run is gone')
      if (state.dirty.length > 0) throw new Error('Commit the changes first')
      const ref = `refs/heads/${row.pushRef}`
      const expected = loaded.gate.pushedOid ?? row.reviewedHeadOid
      const lease = expected ? `--force-with-lease=${ref}:${expected}` : null
      await withPushNonce((nonce) =>
        gitOk(
          state.path,
          ['push', '--porcelain', ...(lease ? [lease] : []), row.pushRemote!, `HEAD:${ref}`],
          { PRISM_PUSH_NONCE: nonce },
        ),
      )
      let remote: string | null = null
      for (let attempt = 0; attempt < verifyAttempts; attempt += 1) {
        if (attempt > 0) await sleep(1500)
        remote = (await liveNode(pr.nodeId)).headRefOid
        if (remote === state.localHead) break
      }
      if (remote !== state.localHead) {
        throw new Error(
          `Pushed, but GitHub still shows ${short(remote)} instead of ${short(state.localHead)}. Check again in a moment.`,
        )
      }
      setGate(runId, { pushedOid: remote })
      emit.prsChanged()
      return build(runId)
    })
  }

  async function postReview(loaded: Loaded, gate: PostGate) {
    const { row, pr, run } = loaded
    const pending = (await liveNode(pr.nodeId)).reviews.nodes[0] ?? null
    const findings = listFindings(ctx, run.id).filter((item) => item.included && !item.posted)
    const map = await reviewDiff(loaded).catch(() => new Map() as DiffMap)
    const inline = findings.filter((item) => isCommentable(map, item))
    const outside = findings.filter((item) => !isCommentable(map, item))
    const body = reviewBody(gate.body, outside)
    const thread = (item: Finding) => ({
      path: item.path,
      line: item.line,
      side: item.side,
      body: findingText(item),
    })
    let review: { id: string; url: string }
    let postedBody = body
    if (!pending) {
      const result = await mutate<{
        addPullRequestReview: {
          pullRequestReview: {
            id: string
            url: string
            comments: { nodes: { id: string; path: string }[] }
          }
        }
      }>(addReviewMutation, {
        input: {
          pullRequestId: pr.nodeId,
          ...(row.reviewedHeadOid ? { commitOID: row.reviewedHeadOid } : {}),
          body,
          threads: inline.map(thread),
          ...(gate.mode === 'submit' ? { event: eventEnum[gate.event] } : {}),
        },
      })
      review = result.addPullRequestReview.pullRequestReview
      const comments = result.addPullRequestReview.pullRequestReview.comments.nodes
      const left = [...comments]
      for (const item of inline) {
        const index = left.findIndex((comment) => comment.path === item.path)
        if (index >= 0) linkFinding(ctx, item.id, left.splice(index, 1)[0]!.id)
      }
    } else {
      for (const item of inline) {
        const result = await mutate<{
          addPullRequestReviewThread: { thread: { comments: { nodes: { id: string }[] } } | null }
        }>(addThreadMutation, { input: { pullRequestReviewId: pending.id, ...thread(item) } })
        const comment = result.addPullRequestReviewThread.thread?.comments.nodes[0]
        if (!comment) {
          throw new Error(
            `GitHub did not add the comment on ${item.path}:${item.line}. Exclude it or edit it, then post again.`,
          )
        }
        linkFinding(ctx, item.id, comment.id)
      }
      const merged = [pending.body.trim(), body].filter(Boolean).join('\n\n')
      postedBody = merged
      review =
        gate.mode === 'submit'
          ? (
              await mutate<{
                submitPullRequestReview: { pullRequestReview: { id: string; url: string } }
              }>(submitMutation, {
                input: {
                  pullRequestReviewId: pending.id,
                  event: eventEnum[gate.event],
                  body: merged,
                },
              })
            ).submitPullRequestReview.pullRequestReview
          : (
              await mutate<{
                updatePullRequestReview: { pullRequestReview: { id: string; url: string } }
              }>(updateReviewMutation, {
                input: { pullRequestReviewId: pending.id, body: merged },
              })
            ).updatePullRequestReview.pullRequestReview
    }
    for (const item of outside) linkFinding(ctx, item.id, review.id)
    setGate(run.id, { ghReviewId: review.id, ghReviewUrl: review.url, postedBody })
  }

  async function postReplies(loaded: Loaded) {
    const replies = repliesOf(loaded)
    for (const reply of replies) {
      if (!reply.selected || reply.postedUrl || !reply.body.trim()) continue
      const result = await mutate<{
        addPullRequestReviewThreadReply: { comment: { id: string; url: string } }
      }>(replyMutation, {
        input: { pullRequestReviewThreadId: reply.threadId, body: replyBody(reply.body) },
      })
      reply.postedUrl = result.addPullRequestReviewThreadReply.comment.url
      setGate(loaded.run.id, { repliesJson: JSON.stringify(replies) })
    }
  }

  async function post(runId: number) {
    return exclusive(runId, async () => {
      const gate = await build(runId)
      const loaded = load(runId)
      ensureOpen(loaded)
      ensureIdle(loaded)
      if (!gate.ready) {
        const failing = gate.checks.find((check) => !check.ok)
        throw new Error(
          failing
            ? `${failing.label}: ${failing.detail ?? 'not done yet'}`
            : (gate.warning ?? 'The post gate is not ready'),
        )
      }
      if (loaded.kind === 'review') await postReview(loaded, gate)
      else await postReplies(loaded)
      setGate(runId, {
        postedAt: Date.now(),
        mode: gate.mode,
        event: gate.event,
        postedHeadOid: await currentHead(loaded),
      })
      clearManualStage(ctx, loaded.run.prId)
      emit.prsChanged()
      return build(runId)
    })
  }

  async function skip(runId: number, skipped: boolean) {
    return exclusive(runId, async () => {
      const current = skipped ? await build(runId) : null
      const loaded = load(runId)
      if (loaded.gate.postedAt !== null) throw new Error('Already posted')
      if (current) {
        setGate(runId, {
          skippedAt: Date.now(),
          mode: current.mode,
          event: current.event,
          postedHeadOid: await currentHead(loaded),
        })
        clearManualStage(ctx, loaded.run.prId)
      } else {
        setGate(runId, { skippedAt: null })
      }
      emit.prsChanged()
      return build(runId)
    })
  }

  async function approve(prId: number) {
    const pr = ctx.db.select().from(prs).where(eq(prs.id, prId)).get()
    if (!pr) throw new Error(`Pull request ${prId} not found`)
    if (activeRunFor(ctx, prId)) {
      throw new Error('An agent run is in progress on this pull request. Wait for it or stop it.')
    }
    return lockPr(prId, async () => {
      const node = await liveNode(pr.nodeId)
      const event = node.viewerDidAuthor ? 'COMMENT' : 'APPROVE'
      const body = `✅ GO\n\n${aiTag}`
      const pending = node.reviews.nodes[0] ?? null
      const review = pending
        ? (
            await mutate<{
              submitPullRequestReview: { pullRequestReview: { id: string; url: string } }
            }>(submitMutation, {
              input: {
                pullRequestReviewId: pending.id,
                event,
                body: [pending.body.trim(), body].filter(Boolean).join('\n\n'),
              },
            })
          ).submitPullRequestReview.pullRequestReview
        : (
            await mutate<{
              addPullRequestReview: { pullRequestReview: { id: string; url: string } }
            }>(addReviewMutation, {
              input: { pullRequestId: pr.nodeId, commitOID: node.headRefOid, body, event },
            })
          ).addPullRequestReview.pullRequestReview
      markApproved(ctx, prId, node.headRefOid)
      emit.prsChanged()
      return { url: review.url, own: node.viewerDidAuthor }
    })
  }

  return { get: build, update, commit, push, post, skip, approve }
}

export type Actions = ReturnType<typeof createActions>
