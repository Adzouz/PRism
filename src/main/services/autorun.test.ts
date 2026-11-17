import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { Run, RunStatus, Stage } from '@shared/domain'
import { openDb } from '../db/client'
import { prFlags, prs, repos, runs } from '../db/schema'
import { autoRunNote, autoRunQueue, createAutoRun } from './autorun'
import type { Ctx } from './context'
import { getPr } from './prs'
import { getRun } from './runs'
import type { PrEvent } from './sync'

const migrations = resolve(__dirname, '../../../drizzle')

type Start = (input: { prId: number; stage: Stage; note: string }) => Run

function setup() {
  const ctx: Ctx = {
    db: openDb(':memory:', migrations),
    userData: '',
    builtinSkillsDir: '',
    log: () => {},
    skillsChanged: () => {},
  }
  const addRepo = (name: string, autoRun: boolean) =>
    ctx.db.insert(repos).values({ owner: 'acme', name, autoRun, addedAt: 0 }).returning().get().id
  const repoId = addRepo('app', true)
  let numbers = 0
  const addPr = (values: Partial<typeof prs.$inferInsert> = {}) => {
    numbers += 1
    return ctx.db
      .insert(prs)
      .values({
        repoId,
        nodeId: `PR_${numbers}`,
        number: numbers,
        title: `Change ${numbers}`,
        url: `https://github.com/acme/app/pull/${numbers}`,
        author: 'octocat',
        isDraft: false,
        state: 'OPEN',
        headRef: `feature-${numbers}`,
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
        ...values,
      })
      .returning()
      .get().id
  }
  const addRun = (prId: number, status: RunStatus, createdAt = 1, stage: Stage = 'review') =>
    ctx.db
      .insert(runs)
      .values({ prId, stage, agent: 'claude', model: 'claude-opus-5-5', status, createdAt })
      .returning()
      .get().id
  const start = vi.fn<Start>((input) => getRun(ctx, addRun(input.prId, 'queued', 5_000)))
  const requested = (prId: number, direct = true): PrEvent => ({
    kind: 'reviewRequested',
    prId,
    headOid: 'head1',
    direct,
  })
  return { ctx, addRepo, addPr, addRun, start, requested }
}

const started = (start: Mock<Start>) => start.mock.calls.map(([input]) => [input.prId, input.stage])

describe('auto-run', () => {
  it('starts a review when someone requests mine by name', () => {
    const { ctx, addPr, start, requested } = setup()
    const prId = addPr()
    createAutoRun(ctx, { start }).handle([requested(prId)], 1_000)
    expect(start).toHaveBeenCalledWith({ prId, stage: 'review', note: autoRunNote })
    expect(autoRunQueue(ctx)).toEqual([])
  })

  it('ignores team requests, failing checks and repositories without auto-run', () => {
    const { ctx, addRepo, addPr, start, requested } = setup()
    const team = addPr()
    const elsewhere = addPr({ repoId: addRepo('docs', false) })
    const failing: PrEvent = { kind: 'ciFailed', prId: team, headOid: 'head1' }
    createAutoRun(ctx, { start }).handle([requested(team, false), requested(elsewhere), failing])
    expect(start).not.toHaveBeenCalled()
    expect(autoRunQueue(ctx)).toEqual([])
  })

  it('starts a re-review when I reviewed the pull request before', () => {
    const { ctx, addPr, start, requested } = setup()
    const prId = addPr({ myReviewState: 'CHANGES_REQUESTED', myReviewOid: 'head0' })
    createAutoRun(ctx, { start }).handle([requested(prId)], 1_000)
    expect(started(start)).toEqual([[prId, 're-review']])
  })

  it('waits while two runs are busy, then starts after a restart', () => {
    const { ctx, addPr, addRun, start, requested } = setup()
    const first = addPr()
    const second = addPr()
    const busy = addRun(addPr({ reviewRequested: false }), 'running')
    addRun(addPr({ reviewRequested: false }), 'preparing')
    addRun(addPr({ reviewRequested: false }), 'needs_you')

    createAutoRun(ctx, { start }).handle([requested(first), requested(second)], 1_000)
    expect(start).not.toHaveBeenCalled()
    expect(autoRunQueue(ctx).map((entry) => entry.prId)).toEqual([first, second])

    ctx.db.update(runs).set({ status: 'done' }).where(eq(runs.id, busy)).run()
    createAutoRun(ctx, { start }).drain()
    expect(started(start)).toEqual([[first, 'review']])
    expect(autoRunQueue(ctx).map((entry) => entry.prId)).toEqual([second])
  })

  it('drops a queued request that no longer applies', () => {
    const { ctx, addPr, addRun, start, requested } = setup()
    const withdrawn = addPr({ reviewRequested: false })
    const closed = addPr({ state: 'MERGED' })
    const hidden = addPr()
    ctx.db.insert(prFlags).values({ prId: hidden, hidden: true }).run()
    const archived = addPr()
    ctx.db.insert(prFlags).values({ prId: archived, archivedAt: 1 }).run()
    const startedByHand = addPr()
    const dismissed = addRun(startedByHand, 'cancelled', 2_000)
    ctx.db.update(runs).set({ dismissedAt: 2_500 }).where(eq(runs.id, dismissed)).run()
    const running = addPr()
    addRun(running, 'needs_you', 1)
    const unposted = addPr()
    const finished = addRun(unposted, 'done', 1)
    ctx.db.update(runs).set({ endedAt: 10 }).where(eq(runs.id, finished)).run()
    expect(getPr(ctx, unposted).stage).toBe('reviewing')
    expect(getPr(ctx, startedByHand).stage).toBe('to-review')

    createAutoRun(ctx, { start }).handle(
      [withdrawn, closed, hidden, archived, startedByHand, running, unposted].map((prId) =>
        requested(prId),
      ),
      1_000,
    )
    expect(start).not.toHaveBeenCalled()
    expect(autoRunQueue(ctx)).toEqual([])
  })

  it('stops for a repository whose auto-run was turned off while it waited', () => {
    const { ctx, addPr, addRun, start, requested } = setup()
    const prId = addPr()
    addRun(addPr({ reviewRequested: false }), 'running')
    addRun(addPr({ reviewRequested: false }), 'running')
    const autoRun = createAutoRun(ctx, { start })
    autoRun.handle([requested(prId)], 1_000)
    ctx.db.update(repos).set({ autoRun: false }).run()
    ctx.db.update(runs).set({ status: 'done' }).run()
    autoRun.drain()
    expect(start).not.toHaveBeenCalled()
    expect(autoRunQueue(ctx)).toEqual([])
  })

  it('goes on with the queue when a run cannot start', () => {
    const { ctx, addPr, start, requested } = setup()
    const broken = addPr()
    const fine = addPr()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    start.mockImplementationOnce(() => {
      throw new Error('No skill is bound to the review stage')
    })
    createAutoRun(ctx, { start }).handle([requested(broken), requested(fine)], 1_000)
    expect(started(start)).toEqual([
      [broken, 'review'],
      [fine, 'review'],
    ])
    expect(autoRunQueue(ctx)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
