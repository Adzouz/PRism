import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Run, RunEvent, Stage } from '@shared/domain'
import type { AgentAdapter, SegmentInput, SegmentResult } from '../agents/types'
import { openDb } from '../db/client'
import { prs, repos, skills, stageBindings } from '../db/schema'
import { setSetting } from '../db/settings'
import type { Ctx } from './context'
import type { GithubApi } from './gh-api'
import { listPrs, setPrStage } from './prs'
import { createRunner } from './runner'
import {
  boardRunFor,
  getRun,
  listEvents,
  listFindings,
  pendingAsk,
  runStage,
  type BoardRunInfo,
} from './runs'
import type { prepareWorktree } from './worktrees'

const migrations = resolve(__dirname, '../../../drizzle')

async function setup(count = 1) {
  const userData = await mkdtemp(join(tmpdir(), 'prism-runner-'))
  const ctx: Ctx = {
    db: openDb(':memory:', migrations),
    userData,
    builtinSkillsDir: '',
    log: () => {},
    skillsChanged: () => {},
  }
  const repo = ctx.db
    .insert(repos)
    .values({
      owner: 'acme',
      name: 'app',
      localPath: '/code/app',
      worktreeRoot: '/code/app-worktrees',
      addedAt: 0,
    })
    .returning()
    .get()
  const skillDir = join(userData, 'skills/pr-review')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: pr-review\n---\nReview carefully.\n')
  const skill = ctx.db
    .insert(skills)
    .values({
      name: 'pr-review',
      description: 'Review',
      mode: 'custom',
      path: skillDir,
      contentHash: 'x',
    })
    .returning()
    .get()
  for (const stage of ['review', 'test-plan', 'address', 'draft-replies']) {
    ctx.db
      .insert(stageBindings)
      .values({ scope: 'global', stage, skillId: skill.id, validatedAt: 1 })
      .run()
  }
  setSetting(ctx.db, 'agent', { agent: 'claude', model: 'claude-opus-5-5' })
  const ids = Array.from(
    { length: count },
    (_, index) =>
      ctx.db
        .insert(prs)
        .values({
          repoId: repo.id,
          nodeId: `PR_${index}`,
          number: index + 1,
          title: `Change ${index + 1}`,
          url: `https://github.com/acme/app/pull/${index + 1}`,
          author: 'someone',
          isDraft: false,
          state: 'OPEN',
          headRef: `feature-${index}`,
          headOid: 'head1',
          baseRef: 'main',
          baseOid: 'base1',
          ciState: 'none',
          additions: 1,
          deletions: 1,
          changedFiles: 1,
          reviewRequested: true,
          myRole: 'reviewer',
          derivedStage: 'to-review',
          stageSince: 0,
          createdAt: 0,
          updatedAt: 0,
          syncedAt: 0,
        })
        .returning()
        .get().id,
  )
  return { ctx, ids }
}

let threadNodes: unknown[] = []

const threadNode = (id: string, isResolved: boolean) => ({
  id,
  isResolved,
  isOutdated: false,
  path: `src/${id}.ts`,
  line: 4,
  originalLine: 4,
  comments: {
    totalCount: 1,
    nodes: [
      {
        id: `${id}-c`,
        body: `Please fix ${id}`,
        createdAt: '2026-11-01T10:00:00Z',
        url: `https://github.com/acme/app/pull/1#${id}`,
        author: { login: 'reviewer', avatarUrl: '' },
      },
    ],
  },
})

const api: GithubApi = {
  graphql: async <T>(query: string) =>
    (query.includes('query Threads')
      ? {
          node: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: threadNodes,
            },
          },
        }
      : { node: null }) as T,
  graphqlPartial: async <T>() => ({ data: { node: null } as T, errors: [] }),
  probe: async () => ({ status: 200, etag: null }),
  rate: async () => null,
} as unknown as GithubApi

const prepare: typeof prepareWorktree = async (_options, pr) => ({
  path: `/code/app-worktrees/pr-${pr.number}`,
  branch: pr.headRef,
  remote: 'origin',
  baseRemote: 'origin',
  created: true,
  headOid: 'head1',
  warning: null,
})

const ok = (sessionId: string, total = 1): SegmentResult => ({
  sessionId,
  tokensIn: 100 * total,
  tokensOut: 20 * total,
  costUsd: 0.01 * total,
  error: null,
})

function makeRunner(ctx: Ctx, run: (input: SegmentInput) => Promise<SegmentResult>) {
  const adapter: AgentAdapter = { run: vi.fn<AgentAdapter['run']>(run) }
  const runs: Run[] = []
  const events: RunEvent[] = []
  const runner = createRunner({
    ctx,
    api,
    adapters: { claude: adapter },
    emit: {
      run: (item) => runs.push(item),
      event: (item) => events.push(item),
      prsChanged: () => {},
    },
    agentEnv: async () => ({ env: {}, executable: null }),
    prepare,
  })
  return { runner, adapter, runs, events }
}

async function until(check: () => boolean) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (check()) return
    await new Promise((done) => setTimeout(done, 5))
  }
  throw new Error('timed out')
}

const finding = {
  path: 'src/a.ts',
  line: 3,
  side: 'RIGHT' as const,
  severity: 'blocking' as const,
  title: 'Null check',
  body: 'This can be null.',
}

describe('agent runner', () => {
  it('runs three reviews in parallel and moves cards through agent columns', async () => {
    const { ctx, ids } = await setup(3)
    let inFlight = 0
    let peak = 0
    let release!: () => void
    const gate = new Promise<void>((done) => (release = done))
    const { runner, adapter } = makeRunner(ctx, async (input) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      input.onSession(`session-${input.cwd}`)
      input.tools.progress('Reading the diff')
      await gate
      input.tools.reportFindings(
        { verdict: 'request_changes', summary: 'One bug.', dimensions: [] },
        [finding],
      )
      inFlight -= 1
      return ok(`session-${input.cwd}`)
    })

    const started = ids.map((prId) => runner.start({ prId, stage: 'review' }))
    await until(() => inFlight === 3)
    expect(peak).toBe(3)
    expect(listPrs(ctx).map((pr) => [pr.stage, pr.run?.progress])).toEqual([
      ['reviewing', 'Reading the diff'],
      ['reviewing', 'Reading the diff'],
      ['reviewing', 'Reading the diff'],
    ])
    expect(() => runner.start({ prId: ids[0]!, stage: 'review' })).toThrow('already in progress')

    release()
    await until(() => started.every((run) => getRun(ctx, run.id).status === 'done'))
    const first = getRun(ctx, started[0]!.id)
    expect(first).toMatchObject({
      report: { verdict: 'request_changes' },
      sessionId: 'session-/code/app-worktrees/pr-1',
      worktreePath: '/code/app-worktrees/pr-1',
      tokensIn: 100,
      costUsd: 0.01,
    })
    expect(listFindings(ctx, first.id)).toHaveLength(1)
    expect(listPrs(ctx).map((pr) => pr.stage)).toEqual([
      'verdict-ready',
      'verdict-ready',
      'verdict-ready',
    ])
    expect(listPrs(ctx)[0]!.run).toMatchObject({ verdict: 'request_changes', findings: 1 })
    const prompt = vi.mocked(adapter.run).mock.calls[0]![0]
    expect(prompt.prompt).toContain('Review carefully.')
    expect(prompt.prompt).toContain('acme/app#1')
    expect(prompt.readOnly).toBe(true)
    expect(prompt.systemAppend).toContain('Never commit')
    expect(prompt.projectRoot).toBe('/code/app')
  })

  it('pauses on a question and resumes the same session with the answer', async () => {
    const { ctx, ids } = await setup()
    const waiting: boolean[] = []
    const { runner, adapter, events } = makeRunner(ctx, async (input) => {
      if (!input.resume) {
        input.tools.askUser({ question: 'Include tests?', options: ['Yes', 'No'] })
        waiting.push(input.tools.isWaiting())
        return ok('s1')
      }
      input.tools.reportFindings({ verdict: 'approve', summary: 'Fine.', dimensions: [] }, [])
      return ok('s1', 2)
    })
    const run = runner.start({ prId: ids[0]!, stage: 'review' })
    await until(() => getRun(ctx, run.id).status === 'needs_you')
    const pending = getRun(ctx, run.id)
    expect(pending.ask).toMatchObject({ prompt: 'Include tests?', options: ['Yes', 'No'] })
    expect(listPrs(ctx)[0]).toMatchObject({
      stage: 'needs-you',
      run: { ask: { prompt: 'Include tests?' } },
    })

    runner.answer({ askId: pending.ask!.id, answer: 'Yes' })
    await until(() => getRun(ctx, run.id).status === 'done')
    const resumed = vi.mocked(adapter.run).mock.calls[1]![0]
    expect(resumed.resume).toBe('s1')
    expect(resumed.prompt).toContain('Include tests?')
    expect(resumed.prompt).toContain('Yes')
    expect(getRun(ctx, run.id)).toMatchObject({ tokensIn: 200, ask: null })
    expect(events.map((event) => event.kind)).toContain('answer')
    expect(() => runner.answer({ askId: pending.ask!.id, answer: 'No' })).toThrow(
      'already answered',
    )
    expect(waiting).toEqual([true])
  })

  it('nudges once for a missing report, then fails', async () => {
    const { ctx, ids } = await setup()
    const { runner, adapter } = makeRunner(ctx, async () => ok('s'))
    const run = runner.start({ prId: ids[0]!, stage: 'review' })
    await until(() => getRun(ctx, run.id).status === 'failed')
    expect(adapter.run).toHaveBeenCalledTimes(2)
    expect(vi.mocked(adapter.run).mock.calls[1]![0].prompt).toContain('prism_report_findings')
    expect(getRun(ctx, run.id).error).toContain('without calling prism_report_findings')
    expect(listPrs(ctx)[0]!.stage).toBe('to-review')
  })

  it('records agent errors and cancels running work', async () => {
    const { ctx, ids } = await setup(2)
    const { runner } = makeRunner(ctx, async (input) => {
      if (input.cwd.endsWith('pr-1')) return { ...ok('s'), error: 'rate limited' }
      await new Promise((done) => input.signal.addEventListener('abort', done))
      return ok('s')
    })
    const failing = runner.start({ prId: ids[0]!, stage: 'review' })
    const slow = runner.start({ prId: ids[1]!, stage: 'review' })
    await until(() => getRun(ctx, failing.id).status === 'failed')
    expect(getRun(ctx, failing.id).error).toBe('rate limited')
    await until(() => runner.isActive(slow.id) && getRun(ctx, slow.id).status === 'running')
    runner.cancel(slow.id)
    await until(() => !runner.isActive(slow.id))
    expect(getRun(ctx, slow.id).status).toBe('cancelled')
    expect(
      listEvents(ctx, slow.id)
        .filter((event) => event.kind === 'status')
        .at(-1),
    ).toMatchObject({
      payload: { status: 'cancelled' },
    })
  })

  it('resumes interrupted runs after a restart', async () => {
    const { ctx, ids } = await setup()
    let calls = 0
    const first = makeRunner(ctx, async (input) => {
      calls += 1
      input.onSession('s9')
      await new Promise(() => {})
      return ok('s9')
    })
    const run = first.runner.start({ prId: ids[0]!, stage: 'review' })
    await until(() => getRun(ctx, run.id).sessionId === 's9')

    const second = makeRunner(ctx, async (input) => {
      input.tools.reportFindings({ verdict: 'comment', summary: 'Ok.', dimensions: [] }, [])
      return ok(input.resume ?? 'new')
    })
    second.runner.resumeAll()
    await until(() => getRun(ctx, run.id).status === 'done')
    const call = vi.mocked(second.adapter.run).mock.calls[0]![0]
    expect(call.resume).toBe('s9')
    expect(call.prompt).toContain('restarted')
    expect(calls).toBe(1)
  })

  it('hands the selected review threads to address runs', async () => {
    const { ctx, ids } = await setup(2)
    threadNodes = [threadNode('T1', false), threadNode('T2', false), threadNode('T3', true)]
    const { runner, adapter } = makeRunner(ctx, async (input) => {
      input.tools.reportChanges({
        threads: [{ threadId: 'T1', action: 'fix' }],
        filesTouched: ['src/T1.ts'],
        checks: [],
      })
      input.tools.draftReplies([{ threadId: 'T1', body: 'Done.' }])
      return ok('s')
    })
    const all = runner.start({ prId: ids[0]!, stage: 'address' })
    const picked = runner.start({ prId: ids[1]!, stage: 'address', threadIds: ['T2'] })
    await until(() => [all, picked].every((run) => getRun(ctx, run.id).status === 'done'))
    expect(getRun(ctx, all.id).threadIds).toEqual(['T1', 'T2'])
    expect(getRun(ctx, picked.id).threadIds).toEqual(['T2'])
    const prompt = (pr: number) =>
      vi.mocked(adapter.run).mock.calls.find(([input]) => input.cwd.endsWith(`pr-${pr}`))![0]
    expect(prompt(1).prompt).toContain('Thread `T1`')
    expect(prompt(1).prompt).toContain('Thread `T2`')
    expect(prompt(1).prompt).not.toContain('Thread `T3`')
    expect(prompt(2).prompt).toContain('Thread `T2`')
    expect(prompt(2).prompt).not.toContain('Thread `T1`')
    expect(prompt(1).readOnly).toBe(false)
    expect(getRun(ctx, all.id)).toMatchObject({
      changes: { threads: [{ threadId: 'T1', action: 'fix' }] },
      replies: [{ threadId: 'T1', body: 'Done.' }],
    })
  })

  it('fails draft replies when there is nothing to reply to', async () => {
    const { ctx, ids } = await setup()
    threadNodes = [threadNode('T9', true)]
    const { runner, adapter } = makeRunner(ctx, async () => ok('s'))
    const run = runner.start({ prId: ids[0]!, stage: 'draft-replies' })
    await until(() => getRun(ctx, run.id).status === 'failed')
    expect(getRun(ctx, run.id).error).toBe('There are no review threads to reply to')
    expect(adapter.run).not.toHaveBeenCalled()
  })

  it('continues a finished run with a follow-up message', async () => {
    const { ctx, ids } = await setup()
    const { runner, adapter, events } = makeRunner(ctx, async (input) => {
      const verdict = input.resume ? 'approve' : 'comment'
      input.tools.reportFindings({ verdict, summary: 'Checked.', dimensions: [] }, [])
      return ok('s5')
    })
    const run = runner.start({ prId: ids[0]!, stage: 'review' })
    await until(() => getRun(ctx, run.id).status === 'done')
    expect(listPrs(ctx)[0]!.stage).toBe('verdict-ready')
    runner.dismiss(run.id)
    expect(listPrs(ctx)[0]!.stage).toBe('to-review')

    const next = runner.followUp({ runId: run.id, message: 'Also check the docs' })
    expect(next).toMatchObject({ status: 'running', dismissedAt: null, endedAt: null })
    await until(() => getRun(ctx, run.id).status === 'done')
    const call = vi.mocked(adapter.run).mock.calls[1]![0]
    expect(call).toMatchObject({ resume: 's5', prompt: 'Also check the docs' })
    expect(getRun(ctx, run.id).report?.verdict).toBe('approve')
    expect(listPrs(ctx)[0]!.stage).toBe('verdict-ready')
    expect(events.find((event) => event.kind === 'message')?.payload).toEqual({
      text: 'Also check the docs',
    })
  })

  it('guards dismiss and follow-up', async () => {
    const { ctx, ids } = await setup()
    const { runner } = makeRunner(ctx, async (input) => {
      await new Promise((done) => input.signal.addEventListener('abort', done))
      return { ...ok('s'), sessionId: null }
    })
    const run = runner.start({ prId: ids[0]!, stage: 'review' })
    await until(() => runner.isActive(run.id) && getRun(ctx, run.id).status === 'running')
    expect(() => runner.dismiss(run.id)).toThrow('Stop the run')
    expect(() => runner.followUp({ runId: run.id, message: 'x' })).toThrow('still in progress')
    expect(() => setPrStage(ctx, { id: ids[0]!, stage: 'waiting-on-author' })).toThrow(
      'Stop the agent run',
    )
    runner.cancel(run.id)
    await until(() => !runner.isActive(run.id))
    expect(() => runner.followUp({ runId: run.id, message: 'x' })).toThrow('no agent session')
    expect(runner.dismiss(run.id).dismissedAt).not.toBeNull()
  })

  it('refuses to start without a bound skill', async () => {
    const { ctx, ids } = await setup()
    const { runner } = makeRunner(ctx, async () => ok('s'))
    expect(() => runner.start({ prId: ids[0]!, stage: 're-review' })).toThrow('No skill is bound')
  })

  it('closes the open question when a waiting run is stopped', async () => {
    const { ctx, ids } = await setup()
    const waiting: boolean[] = []
    const { runner } = makeRunner(ctx, async (input) => {
      if (!input.resume) {
        input.tools.askUser({ question: 'Which base?' })
        return ok('s1')
      }
      waiting.push(input.tools.isWaiting())
      input.tools.reportFindings({ verdict: 'comment', summary: 'Ok.', dimensions: [] }, [])
      return ok('s1', 2)
    })
    const run = runner.start({ prId: ids[0]!, stage: 'review' })
    await until(() => getRun(ctx, run.id).status === 'needs_you')
    const ask = getRun(ctx, run.id).ask!
    runner.cancel(run.id)
    expect(pendingAsk(ctx, run.id)).toBeNull()
    expect(() => runner.answer({ askId: ask.id, answer: 'main' })).toThrow('already answered')
    runner.followUp({ runId: run.id, message: 'Use main and finish' })
    await until(() => getRun(ctx, run.id).status === 'done')
    expect(waiting).toEqual([false])
  })

  it('refuses a second question while one is open', async () => {
    const { ctx, ids } = await setup()
    const replies: string[] = []
    const { runner } = makeRunner(ctx, async (input) => {
      replies.push(input.tools.askUser({ question: 'First?' }))
      replies.push(input.tools.askUser({ question: 'Second?' }))
      return ok('s1')
    })
    const run = runner.start({ prId: ids[0]!, stage: 'review' })
    await until(() => getRun(ctx, run.id).status === 'needs_you')
    expect(replies[1]).toContain('already waiting')
    expect(getRun(ctx, run.id).ask?.prompt).toBe('First?')
  })

  it('dismisses earlier finished runs along with the verdict', async () => {
    const { ctx, ids } = await setup()
    const { runner } = makeRunner(ctx, async (input) => {
      input.tools.reportFindings({ verdict: 'comment', summary: 'Ok.', dimensions: [] }, [])
      return ok('s')
    })
    const first = runner.start({ prId: ids[0]!, stage: 'review' })
    await until(() => getRun(ctx, first.id).status === 'done' && !runner.isActive(first.id))
    const second = runner.start({ prId: ids[0]!, stage: 'review' })
    await until(() => getRun(ctx, second.id).status === 'done' && !runner.isActive(second.id))
    expect(listPrs(ctx)[0]).toMatchObject({ stage: 'verdict-ready', run: { id: second.id } })
    runner.dismiss(second.id)
    expect(listPrs(ctx)[0]).toMatchObject({ stage: 'to-review', run: null })
    expect(getRun(ctx, first.id).dismissedAt).not.toBeNull()
  })

  it('gives re-reviews the open findings of earlier reviews and the last reviewed head', async () => {
    const { ctx, ids } = await setup()
    const skill = ctx.db.select().from(skills).get()!
    ctx.db
      .insert(stageBindings)
      .values({ scope: 'global', stage: 're-review', skillId: skill.id, validatedAt: 1 })
      .run()
    let firstId = 0
    let reReviews = 0
    const { runner, adapter } = makeRunner(ctx, async (input) => {
      if (input.stage === 're-review') {
        reReviews += 1
        if (reReviews === 1) {
          input.tools.reportPriorStatus([{ findingId: firstId, status: 'resolved' }])
          input.tools.reportFindings({ verdict: 'comment', summary: 'One more.', dimensions: [] }, [
            { ...finding, title: 'Missing test' },
          ])
        } else {
          input.tools.reportFindings({ verdict: 'approve', summary: 'Fine.', dimensions: [] }, [])
        }
      } else {
        const review = input.stage === 'review'
        input.tools.reportFindings(
          { verdict: review ? 'request_changes' : 'comment', summary: 'Done.', dimensions: [] },
          review ? [finding] : [],
        )
      }
      return ok('s')
    })
    const runAndWait = async (stage: Stage) => {
      const run = runner.start({ prId: ids[0]!, stage })
      await until(() => getRun(ctx, run.id).status === 'done' && !runner.isActive(run.id))
      return run
    }
    const review = await runAndWait('review')
    firstId = listFindings(ctx, review.id)[0]!.id
    await runAndWait('test-plan')
    await runAndWait('re-review')
    await runAndWait('re-review')
    const prompts = vi
      .mocked(adapter.run)
      .mock.calls.map(([input]) => input)
      .filter((input) => input.stage === 're-review')
      .map((input) => input.prompt)
    expect(prompts[0]).toContain('Null check (open)')
    expect(prompts[0]).toContain('Last PRism review was at head1')
    expect(prompts[1]).toContain('Missing test (open)')
    expect(prompts[1]).not.toContain('Null check')
  })

  it('counts session cost once across resumed segments', async () => {
    const { ctx, ids } = await setup()
    const { runner } = makeRunner(ctx, async (input) => {
      input.tools.reportFindings({ verdict: 'comment', summary: 'Ok.', dimensions: [] }, [])
      return input.resume ? ok('s7', 3) : ok('s7', 2)
    })
    const run = runner.start({ prId: ids[0]!, stage: 'review' })
    await until(() => getRun(ctx, run.id).status === 'done' && !runner.isActive(run.id))
    expect(getRun(ctx, run.id).costUsd).toBeCloseTo(0.02)
    runner.followUp({ runId: run.id, message: 'Again' })
    await until(() => getRun(ctx, run.id).status === 'done' && !runner.isActive(run.id))
    expect(getRun(ctx, run.id)).toMatchObject({ tokensIn: 300, tokensOut: 60 })
    expect(getRun(ctx, run.id).costUsd).toBeCloseTo(0.03)
  })

  it('refuses follow-ups and new runs while a stopped run winds down', async () => {
    const { ctx, ids } = await setup()
    let finish!: () => void
    const wound = new Promise<void>((done) => (finish = done))
    const { runner } = makeRunner(ctx, async (input) => {
      input.onSession('s3')
      await new Promise((done) => input.signal.addEventListener('abort', done))
      await wound
      return ok('s3')
    })
    const run = runner.start({ prId: ids[0]!, stage: 'review' })
    await until(
      () => getRun(ctx, run.id).status === 'running' && getRun(ctx, run.id).sessionId !== null,
    )
    runner.cancel(run.id)
    expect(getRun(ctx, run.id).status).toBe('cancelled')
    expect(() => runner.followUp({ runId: run.id, message: 'x' })).toThrow('still stopping')
    expect(() => runner.start({ prId: ids[0]!, stage: 'review' })).toThrow('still stopping')
    finish()
    await until(() => !runner.isActive(run.id))
    expect(runner.followUp({ runId: run.id, message: 'x' }).status).toBe('running')
    runner.cancel(run.id)
    await until(() => !runner.isActive(run.id))
  })

  it('keeps the skill a run started with when the stage is rebound', async () => {
    const { ctx, ids } = await setup()
    const other = ctx.db
      .insert(skills)
      .values({
        name: 'other',
        description: 'x',
        mode: 'custom',
        path: '/nowhere',
        contentHash: 'y',
      })
      .returning()
      .get()
    const { runner, adapter } = makeRunner(ctx, async (input) => {
      input.tools.reportFindings({ verdict: 'comment', summary: 'Ok.', dimensions: [] }, [])
      return ok('s')
    })
    const run = runner.start({ prId: ids[0]!, stage: 'review' })
    ctx.db.update(stageBindings).set({ skillId: other.id }).run()
    await until(() => getRun(ctx, run.id).status === 'done')
    expect(vi.mocked(adapter.run).mock.calls[0]![0].prompt).toContain('Review carefully.')
  })

  it('fails a run whose skill was removed from the library', async () => {
    const { ctx, ids } = await setup()
    const { runner, adapter } = makeRunner(ctx, async () => ok('s'))
    const run = runner.start({ prId: ids[0]!, stage: 'review' })
    ctx.db.delete(stageBindings).run()
    ctx.db.delete(skills).run()
    await until(() => getRun(ctx, run.id).status === 'failed')
    expect(getRun(ctx, run.id).error).toContain('pr-review is no longer in the library')
    expect(adapter.run).not.toHaveBeenCalled()
  })

  it('stops the runs of a repository before it is removed', async () => {
    const { ctx, ids } = await setup(2)
    const { runner } = makeRunner(ctx, async (input) => {
      await new Promise((done) => input.signal.addEventListener('abort', done))
      return ok('s')
    })
    const started = ids.map((prId) => runner.start({ prId, stage: 'review' }))
    await until(() =>
      started.every((run) => runner.isActive(run.id) && getRun(ctx, run.id).status === 'running'),
    )
    runner.cancelForRepo(9999)
    expect(started.map((run) => getRun(ctx, run.id).status)).toEqual(['running', 'running'])
    runner.cancelForRepo(ctx.db.select().from(repos).get()!.id)
    expect(started.map((run) => getRun(ctx, run.id).status)).toEqual(['cancelled', 'cancelled'])
    await until(() => started.every((run) => !runner.isActive(run.id)))
  })

  it('survives its pull request disappearing mid-run', async () => {
    const { ctx, ids } = await setup()
    let finish!: () => void
    const gate = new Promise<void>((done) => (finish = done))
    const { runner } = makeRunner(ctx, async () => {
      await gate
      return ok('s')
    })
    const run = runner.start({ prId: ids[0]!, stage: 'review' })
    await until(() => getRun(ctx, run.id).status === 'running')
    ctx.db.delete(prs).run()
    finish()
    await until(() => !runner.isActive(run.id))
    expect(listPrs(ctx)).toEqual([])
    expect(() => getRun(ctx, run.id)).toThrow('not found')
  })

  it('flags a verdict made on an older head', async () => {
    const { ctx, ids } = await setup()
    const { runner } = makeRunner(ctx, async (input) => {
      input.tools.reportFindings({ verdict: 'approve', summary: 'Ok.', dimensions: [] }, [])
      return ok('s')
    })
    const run = runner.start({ prId: ids[0]!, stage: 'review' })
    await until(() => getRun(ctx, run.id).status === 'done')
    expect(listPrs(ctx)[0]!.run).toMatchObject({ stale: false })
    ctx.db.update(prs).set({ headOid: 'head2' }).run()
    expect(listPrs(ctx)[0]).toMatchObject({ stage: 'verdict-ready', run: { stale: true } })
  })
})

describe('run stage overlay', () => {
  const open = { state: 'OPEN', myReviewAt: null }
  it('maps runs to agent columns', () => {
    expect(runStage('reviews', { stage: 'review', status: 'running', endedAt: null }, open)).toBe(
      'reviewing',
    )
    expect(runStage('reviews', { stage: 're-review', status: 'done', endedAt: 10 }, open)).toBe(
      'verdict-ready',
    )
    expect(
      runStage(
        'reviews',
        { stage: 'review', status: 'done', endedAt: 10 },
        { state: 'OPEN', myReviewAt: 20 },
      ),
    ).toBeNull()
    expect(
      runStage(
        'reviews',
        { stage: 'review', status: 'done', endedAt: 10 },
        { state: 'MERGED', myReviewAt: null },
      ),
    ).toBeNull()
    expect(runStage('mine', { stage: 'address', status: 'queued', endedAt: null }, open)).toBe(
      'addressing',
    )
    expect(runStage('mine', { stage: 'address', status: 'done', endedAt: 5 }, open)).toBe(
      'ready-to-post',
    )
    expect(runStage('mine', { stage: 'review', status: 'needs_you', endedAt: null }, open)).toBe(
      'needs-you',
    )
    expect(runStage('reviews', { stage: 'review', status: 'failed', endedAt: 5 }, open)).toBeNull()
  })

  it('keeps a verdict visible while another stage runs', () => {
    const info = (
      id: number,
      stage: BoardRunInfo['stage'],
      status: BoardRunInfo['status'],
      endedAt: number | null = 10,
    ): BoardRunInfo => ({
      id,
      stage,
      status,
      progress: null,
      error: null,
      verdict: null,
      findings: 0,
      ask: null,
      endedAt,
      reviewedHeadOid: null,
    })
    const review = info(1, 'review', 'done')
    const plan = info(2, 'test-plan', 'running', null)
    const failed = info(3, 'test-plan', 'failed')
    expect(
      boardRunFor(
        'reviews',
        { latest: plan, active: plan, reviewed: review, addressed: null },
        open,
      ),
    ).toEqual({ stage: 'verdict-ready', run: plan })
    expect(
      boardRunFor(
        'reviews',
        { latest: failed, active: null, reviewed: review, addressed: null },
        open,
      ),
    ).toEqual({ stage: 'verdict-ready', run: review })
    expect(
      boardRunFor(
        'reviews',
        { latest: failed, active: null, reviewed: null, addressed: null },
        open,
      ),
    ).toEqual({ stage: null, run: failed })
    expect(
      boardRunFor(
        'mine',
        { latest: review, active: null, reviewed: review, addressed: null },
        open,
      ),
    ).toEqual({ stage: null, run: review })
  })
})
