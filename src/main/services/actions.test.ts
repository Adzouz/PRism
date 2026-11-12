import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aiTag, type ReviewReport, type Stage } from '@shared/domain'
import { prePushHookScript } from '../agents/guard'
import { openDb } from '../db/client'
import { prFlags, prs, repos, runs } from '../db/schema'
import { createActions, gateChecks, parsePorcelain, reviewBody } from './actions'
import type { Ctx } from './context'
import { commentableLines } from './diff'
import type { GithubApi } from './gh-api'
import { listPrs } from './prs'
import { setRepoPostMode } from './repos'
import { listFindings, saveReplies, saveReview, updateFinding, type NewFinding } from './runs'

const migrations = resolve(__dirname, '../../../drizzle')

const patch = ['@@ -1,3 +1,4 @@', ' one', '-two', '+deux', '+trois', ' three'].join('\n')

type Live = {
  headRefOid: string | (() => string)
  viewerDidAuthor: boolean
  pending: { id: string; body: string; url: string } | null
}

function fakeApi(live: Live) {
  const calls: { name: string; input: Record<string, unknown> }[] = []
  let replyCount = 0
  let failReplyAt = -1
  let nullThread = false
  const failures = new Map<string, { data: Record<string, unknown>; message: string }>()
  const respond = (query: string, variables: Record<string, unknown>) => {
    const name = /(?:query|mutation) (\w+)/.exec(query)?.[1] ?? ''
    calls.push({ name, input: (variables.input ?? variables) as Record<string, unknown> })
    const failure = failures.get(name)
    if (failure) return { data: failure.data, errors: [{ message: failure.message }] }
    const ok = (data: Record<string, unknown>) => ({ data, errors: [] })
    if (name === 'Gate') {
      const head = typeof live.headRefOid === 'function' ? live.headRefOid() : live.headRefOid
      return ok({
        node: {
          headRefOid: head,
          viewerDidAuthor: live.viewerDidAuthor,
          reviews: { nodes: live.pending ? [live.pending] : [] },
        },
      })
    }
    if (name === 'AddReview') {
      const threads = (variables.input as { threads?: { path: string }[] }).threads ?? []
      return ok({
        addPullRequestReview: {
          pullRequestReview: {
            id: 'PRR_1',
            url: 'https://github.com/acme/app/pull/1#pullrequestreview-1',
            comments: {
              nodes: threads.map((thread, index) => ({ id: `C_${index}`, path: thread.path })),
            },
          },
        },
      })
    }
    if (name === 'AddThread') {
      return ok({
        addPullRequestReviewThread: {
          thread: nullThread ? null : { comments: { nodes: [{ id: `T_${calls.length}` }] } },
        },
      })
    }
    if (name === 'UpdateReview' || name === 'SubmitReview') {
      const key = name === 'UpdateReview' ? 'updatePullRequestReview' : 'submitPullRequestReview'
      return ok({ [key]: { pullRequestReview: { id: 'PRR_0', url: 'https://x/pending' } } })
    }
    if (name === 'Reply') {
      if (replyCount === failReplyAt) throw new Error('GitHub is down')
      replyCount += 1
      return ok({
        addPullRequestReviewThreadReply: {
          comment: { id: `R_${replyCount}`, url: `https://x/reply-${replyCount}` },
        },
      })
    }
    throw new Error(`unexpected ${name}`)
  }
  const api = {
    async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
      return respond(query, variables).data as T
    },
    async graphqlPartial<T>(query: string, variables: Record<string, unknown> = {}) {
      const result = respond(query, variables)
      return { data: result.data as T, errors: result.errors }
    },
    async get<T>(path: string) {
      calls.push({ name: 'GET', input: { path } })
      return { files: [{ filename: 'src/a.ts', patch }] } as T
    },
    probe: async () => ({ unchanged: false, commit: () => {} }),
    rate: () => null,
  } satisfies GithubApi
  return {
    api,
    calls,
    named: (name: string) => calls.filter((call) => call.name === name),
    failReplyAt: (index: number) => (failReplyAt = index),
    fail: (name: string, data: Record<string, unknown>, message: string) =>
      failures.set(name, { data, message }),
    nullThread: () => (nullThread = true),
  }
}

async function setup(role: 'reviewer' | 'author' = 'reviewer') {
  const userData = await mkdtemp(join(tmpdir(), 'prism-actions-'))
  const ctx: Ctx = {
    db: openDb(':memory:', migrations),
    userData,
    builtinSkillsDir: '',
    log: () => {},
    skillsChanged: () => {},
  }
  const repo = ctx.db
    .insert(repos)
    .values({ owner: 'acme', name: 'app', addedAt: 0 })
    .returning()
    .get()
  const pr = ctx.db
    .insert(prs)
    .values({
      repoId: repo.id,
      nodeId: 'PR_1',
      number: 1,
      title: 'Change',
      url: 'https://github.com/acme/app/pull/1',
      author: role === 'author' ? 'me' : 'someone',
      isDraft: false,
      state: 'OPEN',
      headRef: 'feature',
      headOid: 'head1',
      baseRef: 'main',
      baseOid: 'base1',
      ciState: 'none',
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      reviewRequested: role === 'reviewer',
      myRole: role,
      derivedStage: role === 'author' ? 'changes-requested' : 'to-review',
      stageSince: 0,
      createdAt: 0,
      updatedAt: 0,
      syncedAt: 0,
    })
    .returning()
    .get()
  const addRun = (stage: Stage, extra: Partial<typeof runs.$inferInsert> = {}) =>
    ctx.db
      .insert(runs)
      .values({
        prId: pr.id,
        stage,
        agent: 'claude',
        model: 'claude-opus-5-5',
        status: 'done',
        reviewedHeadOid: 'head1',
        reviewedBaseOid: 'base1',
        createdAt: 1,
        endedAt: 2,
        ...extra,
      })
      .returning()
      .get().id
  return { ctx, repo, pr, addRun }
}

const finding = (overrides: Partial<NewFinding> = {}): NewFinding => ({
  path: 'src/a.ts',
  line: 2,
  side: 'RIGHT',
  severity: 'blocking',
  title: 'Off by one',
  body: 'The loop skips the last item.',
  ...overrides,
})

const report: ReviewReport = { verdict: 'request_changes', summary: 'Two issues.', dimensions: [] }

const noSleep = async () => {}

describe('diff and text helpers', () => {
  it('reads the commentable lines of a patch', () => {
    const lines = commentableLines(patch)
    expect([...lines.RIGHT]).toEqual([1, 2, 3, 4])
    expect([...lines.LEFT]).toEqual([1, 2, 3])
  })

  it('parses porcelain output with renames', () => {
    expect(parsePorcelain(' M src/a.ts\0R  new.ts\0old.ts\0?? notes.md\0')).toEqual([
      'src/a.ts',
      'new.ts',
      'notes.md',
    ])
  })

  it('lists findings outside the diff in the review body and appends the AI tag', () => {
    const body = reviewBody('Summary.', [
      {
        id: 1,
        runId: 1,
        path: 'README.md',
        line: null,
        side: 'RIGHT',
        severity: 'nit',
        nitDecision: null,
        title: 'Typo',
        body: 'teh',
        suggestion: null,
        status: 'open',
        included: true,
        editedBody: null,
        posted: false,
      },
    ])
    expect(body).toBe(
      `Summary.\n\n**Other findings**\n\n- \`README.md\` Nit: **Typo**\n  \n  teh\n\n${aiTag}`,
    )
  })

  it('needs a confirmation and something to post before a review', () => {
    const base = {
      kind: 'review' as const,
      mode: 'submit' as const,
      event: 'comment' as const,
      body: '',
      confirmed: true,
      included: 0,
      total: 2,
      outsideDiff: 0,
      pendingReview: false,
      threadIds: [],
      reportedThreads: null,
      worktree: null,
      replies: [],
    }
    expect(gateChecks(base)[0]).toMatchObject({
      ok: false,
      detail: expect.stringContaining('Nothing'),
    })
    expect(gateChecks({ ...base, event: 'approve' })[0]!.ok).toBe(true)
    expect(gateChecks({ ...base, included: 1, confirmed: false })[0]!.ok).toBe(false)
  })
})

describe('review gate', () => {
  it('defaults to a pending draft, honours the repo override and clamps own PRs to Comment', async () => {
    const { ctx, repo, addRun } = await setup('author')
    const runId = addRun('review')
    saveReview(ctx, runId, report, [finding()])
    const actions = createActions({
      ctx,
      api: fakeApi({ headRefOid: 'head1', viewerDidAuthor: true, pending: null }).api,
      emit: { prsChanged: () => {} },
    })
    const gate = await actions.get(runId)
    expect(gate).toMatchObject({
      kind: 'review',
      mode: 'draft',
      modeFromRepo: false,
      event: 'comment',
      allowedEvents: ['comment'],
      body: 'Two issues.',
      ready: false,
    })
    setRepoPostMode(ctx, repo.id, 'submit')
    expect(await actions.get(runId)).toMatchObject({ mode: 'submit', modeFromRepo: true })
    await expect(actions.post(runId)).rejects.toThrow(/Findings validated/)
  })

  it('posts a draft review with inline comments, links findings and moves to Changes requested', async () => {
    const { ctx, addRun } = await setup()
    const runId = addRun('review')
    saveReview(ctx, runId, report, [
      finding(),
      finding({ path: 'src/a.ts', line: 40, title: 'Outside' }),
      finding({ path: 'src/b.ts', title: 'Excluded' }),
    ])
    const excluded = listFindings(ctx, runId)[2]!
    updateFinding(ctx, { id: excluded.id, included: false })
    updateFinding(ctx, { id: listFindings(ctx, runId)[0]!.id, editedBody: 'Edited comment' })
    const fake = fakeApi({ headRefOid: 'head1', viewerDidAuthor: false, pending: null })
    let changed = 0
    const actions = createActions({ ctx, api: fake.api, emit: { prsChanged: () => changed++ } })
    expect(listPrs(ctx)[0]!.stage).toBe('reviewing')

    const before = await actions.update({ runId, confirmed: true })
    expect(before.findings).toEqual({ included: 2, total: 3, outsideDiff: 1 })
    expect(before.event).toBe('request_changes')
    expect(before.ready).toBe(true)

    const after = await actions.post(runId)
    const [call] = fake.named('AddReview')
    expect(call!.input).toMatchObject({
      pullRequestId: 'PR_1',
      commitOID: 'head1',
      threads: [{ path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Edited comment' }],
    })
    expect(call!.input).not.toHaveProperty('event')
    expect(call!.input.body).toContain('`src/a.ts:40` **Outside**')
    expect(call!.input.body).toMatch(new RegExp(`${aiTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
    expect(after).toMatchObject({ postedAt: expect.any(Number), ready: false })
    expect(after.reviewUrl).toContain('pullrequestreview-1')
    expect(listFindings(ctx, runId).map((item) => item.posted)).toEqual([true, true, false])
    expect(changed).toBe(1)
    expect(after.nextStage).toBe('changes-requested')
    expect(after.postedBody).toBe(call!.input.body)
    expect(listPrs(ctx)[0]!.stage).toBe('changes-requested')
    await expect(actions.post(runId)).rejects.toThrow(/Already posted/)
    expect(() =>
      updateFinding(ctx, { id: listFindings(ctx, runId)[0]!.id, included: false }),
    ).toThrow(/already posted/)
  })

  it('submits with the chosen status', async () => {
    const { ctx, addRun } = await setup()
    const runId = addRun('re-review')
    saveReview(ctx, runId, { ...report, verdict: 'approve' }, [])
    const fake = fakeApi({ headRefOid: 'head1', viewerDidAuthor: false, pending: null })
    const actions = createActions({ ctx, api: fake.api, emit: { prsChanged: () => {} } })
    await actions.update({ runId, mode: 'submit', confirmed: true })
    await actions.post(runId)
    expect(fake.named('AddReview')[0]!.input).toMatchObject({ event: 'APPROVE', threads: [] })
  })

  it('adds to an existing pending review instead of starting a second one', async () => {
    const { ctx, addRun } = await setup()
    const runId = addRun('review')
    saveReview(ctx, runId, report, [finding()])
    const fake = fakeApi({
      headRefOid: 'head1',
      viewerDidAuthor: false,
      pending: { id: 'PRR_0', body: 'My notes.', url: 'https://x/pending' },
    })
    const actions = createActions({ ctx, api: fake.api, emit: { prsChanged: () => {} } })
    const gate = await actions.update({ runId, confirmed: true })
    expect(gate.pendingReview).toBe(true)
    expect(gate.checks.find((check) => check.key === 'mode')!.detail).toMatch(/pending review/)
    await actions.post(runId)
    expect(fake.named('AddReview')).toHaveLength(0)
    expect(fake.named('AddThread')[0]!.input).toMatchObject({
      pullRequestReviewId: 'PRR_0',
      path: 'src/a.ts',
      line: 2,
    })
    expect(fake.named('UpdateReview')[0]!.input.body).toMatch(/^My notes\.\n\nTwo issues\./)
    expect((await actions.get(runId)).postedBody).toBe(fake.named('UpdateReview')[0]!.input.body)
    expect(listFindings(ctx, runId)[0]!.posted).toBe(true)
  })

  it('reports GitHub mutation errors and keeps the gate open', async () => {
    const { ctx, addRun } = await setup()
    const runId = addRun('review')
    saveReview(ctx, runId, report, [finding()])
    const fake = fakeApi({ headRefOid: 'head1', viewerDidAuthor: false, pending: null })
    fake.fail('AddReview', { addPullRequestReview: null }, 'Line could not be resolved')
    const actions = createActions({ ctx, api: fake.api, emit: { prsChanged: () => {} } })
    await actions.update({ runId, confirmed: true })
    await expect(actions.post(runId)).rejects.toThrow('Line could not be resolved')
    expect((await actions.get(runId)).postedAt).toBeNull()
    expect(listFindings(ctx, runId)[0]!.posted).toBe(false)
  })

  it('fails instead of dropping a finding GitHub did not add to the pending review', async () => {
    const { ctx, addRun } = await setup()
    const runId = addRun('review')
    saveReview(ctx, runId, report, [finding()])
    const fake = fakeApi({
      headRefOid: 'head1',
      viewerDidAuthor: false,
      pending: { id: 'PRR_0', body: '', url: 'https://x/pending' },
    })
    fake.nullThread()
    const actions = createActions({ ctx, api: fake.api, emit: { prsChanged: () => {} } })
    await actions.update({ runId, confirmed: true })
    await expect(actions.post(runId)).rejects.toThrow(/did not add the comment on src\/a\.ts:2/)
    expect(fake.named('UpdateReview')).toHaveLength(0)
    expect((await actions.get(runId)).postedAt).toBeNull()
  })

  it('refuses skip and approve while a post is running on the pull request', async () => {
    const { ctx, pr, addRun } = await setup()
    const runId = addRun('review')
    saveReview(ctx, runId, report, [finding()])
    const fake = fakeApi({ headRefOid: 'head1', viewerDidAuthor: false, pending: null })
    let release!: () => void
    const held = new Promise<void>((done) => (release = done))
    const partial = fake.api.graphqlPartial
    fake.api.graphqlPartial = async <T>(query: string, variables?: Record<string, unknown>) => {
      if (query.includes('mutation AddReview')) await held
      return partial<T>(query, variables)
    }
    const actions = createActions({ ctx, api: fake.api, emit: { prsChanged: () => {} } })
    await actions.update({ runId, confirmed: true })
    const posting = actions.post(runId)
    await new Promise((done) => setTimeout(done, 10))
    await expect(actions.skip(runId, true)).rejects.toThrow(/Another action/)
    await expect(actions.approve(pr.id)).rejects.toThrow(/Another action/)
    release()
    const gate = await posting
    expect(gate.postedAt).not.toBeNull()
    expect(gate.skippedAt).toBeNull()
    expect(fake.named('AddReview')).toHaveLength(1)
  })

  it('skips and un-skips posting', async () => {
    const { ctx, addRun } = await setup()
    const runId = addRun('review')
    saveReview(ctx, runId, report, [finding()])
    const actions = createActions({
      ctx,
      api: fakeApi({ headRefOid: 'head1', viewerDidAuthor: false, pending: null }).api,
      emit: { prsChanged: () => {} },
    })
    expect((await actions.skip(runId, true)).skippedAt).not.toBeNull()
    expect(listPrs(ctx)[0]!.stage).toBe('changes-requested')
    await expect(actions.update({ runId, body: 'x' })).rejects.toThrow(/skipped/)
    expect((await actions.skip(runId, false)).skippedAt).toBeNull()
    expect(listPrs(ctx)[0]!.stage).toBe('reviewing')
  })
})

describe('replies gate', () => {
  it('posts only the ticked replies, tagged, and keeps the ones posted before a failure', async () => {
    const { ctx, addRun } = await setup('author')
    const runId = addRun('draft-replies', { threadsJson: JSON.stringify(['T1', 'T2', 'T3']) })
    saveReplies(ctx, runId, [
      { threadId: 'T1', body: 'Fixed.' },
      { threadId: 'T2', body: 'Kept on purpose.' },
    ])
    const fake = fakeApi({ headRefOid: 'head1', viewerDidAuthor: true, pending: null })
    const actions = createActions({ ctx, api: fake.api, emit: { prsChanged: () => {} } })
    const gate = await actions.get(runId)
    expect(gate.replies.map((reply) => [reply.threadId, reply.selected])).toEqual([
      ['T1', true],
      ['T2', true],
      ['T3', false],
    ])
    await actions.update({
      runId,
      replies: [{ threadId: 'T3', body: 'Will do in a follow-up.', selected: true }],
    })
    fake.failReplyAt(1)
    await expect(actions.post(runId)).rejects.toThrow(/GitHub is down/)
    const partial = await actions.get(runId)
    expect(partial.postedAt).toBeNull()
    expect(partial.replies.map((reply) => reply.postedUrl)).toEqual([
      'https://x/reply-1',
      null,
      null,
    ])
    fake.failReplyAt(-1)
    const done = await actions.post(runId)
    expect(done.postedAt).not.toBeNull()
    const bodies = fake.named('Reply').map((call) => call.input)
    expect(bodies.map((input) => input.pullRequestReviewThreadId)).toEqual(['T1', 'T2', 'T2', 'T3'])
    expect(bodies[0]!.body).toBe(`Fixed.\n\n${aiTag}`)
  })
  it('merges reply edits per field, so a tick right after typing keeps the text', async () => {
    const { ctx, addRun } = await setup('author')
    const runId = addRun('draft-replies', { threadsJson: JSON.stringify(['T1']) })
    saveReplies(ctx, runId, [])
    const actions = createActions({
      ctx,
      api: fakeApi({ headRefOid: 'head1', viewerDidAuthor: true, pending: null }).api,
      emit: { prsChanged: () => {} },
    })
    await Promise.all([
      actions.update({ runId, replies: [{ threadId: 'T1', body: 'Typed.' }] }),
      actions.update({ runId, replies: [{ threadId: 'T1', selected: true }] }),
    ])
    const gate = await actions.get(runId)
    expect(gate.replies).toMatchObject([{ threadId: 'T1', body: 'Typed.', selected: true }])
    expect(gate.checks[0]!.ok).toBe(true)
  })
})

describe('address gate', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim()

  async function repoSetup() {
    const root = await mkdtemp(join(tmpdir(), 'prism-actions-git-'))
    const bare = join(root, 'remote.git')
    const work = join(root, 'pr-1')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    execFileSync('git', ['clone', '-q', bare, work])
    git(work, 'config', 'user.email', 'dev@example.com')
    git(work, 'config', 'user.name', 'Dev')
    git(work, 'config', 'commit.gpgsign', 'false')
    git(work, 'checkout', '-q', '-b', 'feature')
    await writeFile(join(work, 'a.ts'), 'one\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'init')
    git(work, 'push', '-q', 'origin', 'feature')
    return { root, bare, work, head: git(work, 'rev-parse', 'HEAD') }
  }

  async function installHook(userData: string, work: string) {
    const hooks = join(userData, 'hooks')
    await mkdir(hooks, { recursive: true })
    await writeFile(join(hooks, 'pre-push'), prePushHookScript(join(hooks, '.push-nonce')))
    await chmod(join(hooks, 'pre-push'), 0o755)
    git(work, 'config', 'core.hooksPath', hooks)
  }

  it('commits, pushes through the pre-push guard, verifies the head and posts replies', async () => {
    const { ctx, addRun } = await setup('author')
    const { bare, work, head } = await repoSetup()
    await installHook(ctx.userData, work)
    expect(() => git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/blocked')).toThrow(/failed/)
    const runId = addRun('address', {
      worktreePath: work,
      reviewedHeadOid: head,
      pushRemote: 'origin',
      pushRef: 'feature',
      threadsJson: JSON.stringify(['T1']),
      changesJson: JSON.stringify({ threads: [{ threadId: 'T1', action: 'fix', note: 'Done.' }] }),
    })
    const fake = fakeApi({
      headRefOid: () => git(bare, 'rev-parse', 'refs/heads/feature'),
      viewerDidAuthor: true,
      pending: null,
    })
    const actions = createActions({
      ctx,
      api: fake.api,
      emit: { prsChanged: () => {} },
      sleep: noSleep,
    })

    const clean = await actions.get(runId)
    expect(clean.checks.map((check) => [check.key, check.ok])).toEqual([
      ['threads', true],
      ['commit', true],
      ['push', true],
      ['replies', true],
    ])
    expect(clean.checks[1]!.detail).toBe('No code changes')

    await writeFile(join(work, 'a.ts'), 'one\ntwo\n')
    const dirty = await actions.get(runId)
    expect(dirty.worktree!.dirty).toEqual(['a.ts'])
    expect(dirty.ready).toBe(false)
    await expect(actions.push(runId)).rejects.toThrow(/Commit the changes first/)

    const committed = await actions.commit(runId, 'fix: handle two')
    expect(git(work, 'log', '-1', '--format=%s')).toBe('fix: handle two')
    expect(committed.checks.find((check) => check.key === 'push')!.ok).toBe(false)

    const pushed = await actions.push(runId)
    expect(git(bare, 'rev-parse', 'refs/heads/feature')).toBe(git(work, 'rev-parse', 'HEAD'))
    expect(existsSync(join(ctx.userData, 'hooks/.push-nonce'))).toBe(false)
    expect(pushed.ready).toBe(true)

    await writeFile(join(work, 'a.ts'), 'one\ntwo\nthree\n')
    await actions.commit(runId, 'fix: handle three')
    const again = await actions.push(runId)
    expect(git(bare, 'rev-parse', 'refs/heads/feature')).toBe(git(work, 'rev-parse', 'HEAD'))
    expect(again.ready).toBe(true)

    const posted = await actions.post(runId)
    expect(posted.postedAt).not.toBeNull()
    expect(fake.named('Reply')[0]!.input.body).toBe(`Done.\n\n${aiTag}`)
  })

  it('refuses to overwrite commits pushed by someone else', async () => {
    const { ctx, addRun } = await setup('author')
    const { root, bare, work, head } = await repoSetup()
    const other = join(root, 'other')
    execFileSync('git', ['clone', '-q', '-b', 'feature', bare, other])
    git(other, 'config', 'user.email', 'dev@example.com')
    git(other, 'config', 'user.name', 'Dev')
    await writeFile(join(other, 'b.ts'), 'b\n')
    git(other, 'add', '-A')
    git(other, 'commit', '-q', '-m', 'theirs')
    git(other, 'push', '-q', 'origin', 'feature')
    const runId = addRun('address', {
      worktreePath: work,
      reviewedHeadOid: head,
      pushRemote: 'origin',
      pushRef: 'feature',
      changesJson: JSON.stringify({ threads: [] }),
    })
    const actions = createActions({
      ctx,
      api: fakeApi({
        headRefOid: () => git(bare, 'rev-parse', 'refs/heads/feature'),
        viewerDidAuthor: true,
        pending: null,
      }).api,
      emit: { prsChanged: () => {} },
      sleep: noSleep,
    })
    expect((await actions.get(runId)).checks.find((check) => check.key === 'push')!.detail).toMatch(
      /GitHub moved/,
    )
    await writeFile(join(work, 'a.ts'), 'mine\n')
    await actions.commit(runId, 'fix: mine')
    await expect(actions.push(runId)).rejects.toThrow(/stale info/)
    expect(git(bare, 'log', '-1', '--format=%s', 'refs/heads/feature')).toBe('theirs')
  })

  it('refuses to commit while an agent run is active on the pull request', async () => {
    const { ctx, addRun } = await setup('author')
    const { work, head } = await repoSetup()
    const runId = addRun('address', { worktreePath: work, reviewedHeadOid: head })
    addRun('test-plan', { status: 'running', endedAt: null })
    const actions = createActions({
      ctx,
      api: fakeApi({ headRefOid: head, viewerDidAuthor: true, pending: null }).api,
      emit: { prsChanged: () => {} },
    })
    expect((await actions.get(runId)).live).toBe(true)
    await expect(actions.commit(runId, 'x')).rejects.toThrow(/agent run is in progress/)
  })
})

describe('review loop', () => {
  const live = (head: string, own = false) => ({
    headRefOid: head,
    viewerDidAuthor: own,
    pending: null,
  })

  it('moves a GO to To approve, then Approved after the approve action', async () => {
    const { ctx, pr, addRun } = await setup()
    const runId = addRun('review')
    saveReview(ctx, runId, { ...report, verdict: 'approve' }, [])
    const fake = fakeApi(live('head1'))
    const actions = createActions({ ctx, api: fake.api, emit: { prsChanged: () => {} } })
    const gate = await actions.update({ runId, confirmed: true })
    expect(gate.nextStage).toBe('to-approve')
    await actions.post(runId)
    expect(listPrs(ctx)[0]!.stage).toBe('to-approve')

    const approved = await actions.approve(pr.id)
    expect(approved.own).toBe(false)
    expect(fake.named('AddReview').at(-1)!.input).toMatchObject({
      pullRequestId: 'PR_1',
      commitOID: 'head1',
      event: 'APPROVE',
      body: `✅ GO\n\n${aiTag}`,
    })
    expect(listPrs(ctx)[0]!.stage).toBe('approved')
    ctx.db.update(prs).set({ headOid: 'head2' }).run()
    expect(listPrs(ctx)[0]!.stage).toBe('re-review')
  })

  it('goes straight to Approved when the review is submitted as Approve', async () => {
    const { ctx, addRun } = await setup()
    const runId = addRun('review')
    saveReview(ctx, runId, { ...report, verdict: 'approve' }, [])
    const actions = createActions({
      ctx,
      api: fakeApi(live('head1')).api,
      emit: { prsChanged: () => {} },
    })
    const gate = await actions.update({ runId, mode: 'submit', confirmed: true })
    expect(gate.nextStage).toBe('approved')
    await actions.post(runId)
    expect(listPrs(ctx)[0]!.stage).toBe('approved')
  })

  it('posts GO as a Comment on my own pull request', async () => {
    const { ctx, pr } = await setup('author')
    const fake = fakeApi(live('head1', true))
    const actions = createActions({ ctx, api: fake.api, emit: { prsChanged: () => {} } })
    expect((await actions.approve(pr.id)).own).toBe(true)
    expect(fake.named('AddReview')[0]!.input).toMatchObject({ event: 'COMMENT' })
    expect(listPrs(ctx)[0]!.stage).toBe('approved')
  })

  it('sends an addressed pull request to Re-review and keeps the posted mode', async () => {
    const { ctx, repo, addRun } = await setup('author')
    const reviewId = addRun('review')
    saveReview(ctx, reviewId, report, [])
    const actions = createActions({
      ctx,
      api: fakeApi(live('head1', true)).api,
      emit: { prsChanged: () => {} },
    })
    await actions.update({ runId: reviewId, confirmed: true })
    const posted = await actions.post(reviewId)
    expect(listPrs(ctx)[0]!.stage).toBe('changes-requested')
    setRepoPostMode(ctx, repo.id, 'submit')
    expect((await actions.get(reviewId)).mode).toBe(posted.mode)

    const addressId = addRun('address', {
      threadsJson: JSON.stringify(['T1']),
      changesJson: JSON.stringify({ threads: [{ threadId: 'T1', action: 'fix' }] }),
    })
    expect((await actions.skip(addressId, true)).nextStage).toBe('re-review')
    expect(listPrs(ctx)[0]!.stage).toBe('re-review')
  })

  it('clears a manual stage when posting', async () => {
    const { ctx, pr, addRun } = await setup()
    const runId = addRun('review')
    saveReview(ctx, runId, report, [])
    ctx.db.insert(prFlags).values({ prId: pr.id, manualStage: 'to-approve' }).run()
    const actions = createActions({
      ctx,
      api: fakeApi(live('head1')).api,
      emit: { prsChanged: () => {} },
    })
    await actions.skip(runId, true)
    expect(listPrs(ctx)[0]).toMatchObject({ stage: 'changes-requested', manual: false })
  })
})
