import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../db/client'
import { eq } from 'drizzle-orm'
import { activity, agentUsage, repos, reviewLatency, snapshots } from '../db/schema'
import type { Ctx } from './context'
import {
  getDashboard,
  latencySamples,
  refreshActivity,
  refreshLatency,
  type TimelineItem,
} from './dashboard'
import { addDays, dayRange, lastDays, localDay } from './days'
import type { GithubApi } from './gh-api'
import { getRepo } from './repos'

const migrations = resolve(__dirname, '../../../drizzle')
const me = 'octocat'
const hour = 3600_000

beforeAll(() => {
  process.env.TZ = 'Europe/Paris'
})

async function makeCtx() {
  const ctx: Ctx = {
    db: openDb(':memory:', migrations),
    userData: await mkdtemp(join(tmpdir(), 'prism-data-')),
    builtinSkillsDir: '',
    log: () => {},
    skillsChanged: () => {},
  }
  const add = (name: string) =>
    getRepo(
      ctx,
      ctx.db.insert(repos).values({ owner: 'acme', name, addedAt: 0 }).returning().get().id,
    )
  return { ctx, app: add('app'), docs: add('docs') }
}

function fakeApi(respond: (name: string, variables: Record<string, string>) => unknown) {
  const calls: { name: string; variables: Record<string, string> }[] = []
  const api: GithubApi = {
    async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
      const name = /query (\w+)/.exec(query)?.[1] ?? ''
      calls.push({ name, variables: variables as Record<string, string> })
      return respond(name, variables as Record<string, string>) as T
    },
    async graphqlPartial<T>(query: string, variables?: Record<string, unknown>) {
      return { data: await api.graphql<T>(query, variables), errors: [] }
    },
    probe: async () => ({ unchanged: false, commit: () => {} }),
    get: async () => {
      throw new Error('unexpected REST call')
    },
    rate: () => null,
  }
  return { api, calls }
}

const requested = (at: string, reviewer: string, type: 'User' | 'Team' = 'User') =>
  ({
    __typename: 'ReviewRequestedEvent',
    createdAt: at,
    requestedReviewer:
      type === 'User'
        ? { __typename: 'User', login: reviewer }
        : { __typename: 'Team', slug: reviewer },
  }) as TimelineItem

const removed = (at: string, reviewer: string) =>
  ({
    __typename: 'ReviewRequestRemovedEvent',
    createdAt: at,
    requestedReviewer: { __typename: 'User', login: reviewer },
  }) as TimelineItem

const review = (at: string | null, author: string) =>
  ({ __typename: 'PullRequestReview', submittedAt: at, author: { login: author } }) as TimelineItem

describe('days', () => {
  it('uses local days and ranges with the local offset', () => {
    const now = Date.parse('2026-11-15T23:30:00Z')
    expect(localDay(now)).toBe('2026-11-16')
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31')
    expect(lastDays('2026-11-16', 3)).toEqual(['2026-11-14', '2026-11-15', '2026-11-16'])
    expect(dayRange('2026-11-16')).toBe('2026-11-16T00:00:00+01:00..2026-11-16T23:59:59+01:00')
    expect(dayRange('2026-10-25')).toBe('2026-10-25T00:00:00+02:00..2026-10-25T23:59:59+01:00')
  })
})

describe('latencySamples', () => {
  it('pairs each request to me or my team with my next review', () => {
    const samples = latencySamples(
      [
        review('2026-11-10T09:00:00Z', me),
        requested('2026-11-10T10:00:00Z', 'core', 'Team'),
        requested('2026-11-10T11:00:00Z', 'OctoCat'),
        review('2026-11-10T12:00:00Z', 'someone'),
        review(null, me),
        review('2026-11-10T14:00:00Z', me),
        requested('2026-11-11T10:00:00Z', me),
        review('2026-11-11T10:30:00Z', me),
        review('2026-11-11T11:00:00Z', me),
      ],
      me,
    )
    expect(samples).toEqual([
      {
        requestedAt: Date.parse('2026-11-10T11:00:00Z'),
        reviewedAt: Date.parse('2026-11-10T14:00:00Z'),
      },
      {
        requestedAt: Date.parse('2026-11-11T10:00:00Z'),
        reviewedAt: Date.parse('2026-11-11T10:30:00Z'),
      },
    ])
  })

  it('drops a request that was removed and ignores requests to others', () => {
    const samples = latencySamples(
      [
        requested('2026-11-10T10:00:00Z', me),
        requested('2026-11-10T10:00:00Z', 'hubot'),
        removed('2026-11-10T11:00:00Z', me),
        review('2026-11-10T12:00:00Z', me),
      ],
      me,
    )
    expect(samples).toEqual([])
  })

  it('measures from a direct request to me over an older team request', () => {
    const samples = latencySamples(
      [
        requested('2026-11-01T10:00:00Z', 'core', 'Team'),
        review('2026-11-01T11:00:00Z', 'someone'),
        requested('2026-11-06T10:00:00Z', me),
        review('2026-11-06T11:00:00Z', me),
      ],
      me,
    )
    expect(samples).toEqual([
      {
        requestedAt: Date.parse('2026-11-06T10:00:00Z'),
        reviewedAt: Date.parse('2026-11-06T11:00:00Z'),
      },
    ])
  })
})

describe('refreshActivity', () => {
  it('backfills the window once and refetches only days that are not final', async () => {
    const { ctx, app } = await makeCtx()
    const { api, calls } = fakeApi((_, variables) =>
      Object.fromEntries(
        Object.keys(variables).map((key) => [
          key,
          { issueCount: key.startsWith('opened') ? 2 : 1 },
        ]),
      ),
    )
    const now = Date.parse('2026-11-16T14:00:00+01:00')
    await refreshActivity(ctx, api, app, now)
    expect(calls).toHaveLength(5)
    expect(Object.keys(calls[0]!.variables)).toHaveLength(30)
    const end = '2026-11-16T23:59:59+01:00'
    const today = (index: number) => ({
      [`opened${index}`]: `repo:acme/app is:pr created:${dayRange('2026-11-16')}`,
      [`merged${index}`]: `repo:acme/app is:pr merged:${dayRange('2026-11-16')}`,
      [`closed${index}`]: `repo:acme/app is:pr is:unmerged closed:${dayRange('2026-11-16')}`,
      [`openNow${index}`]: `repo:acme/app is:pr is:open created:<=${end}`,
      [`closedLater${index}`]: `repo:acme/app is:pr closed:>${end} created:<=${end}`,
    })
    expect(calls[4]!.variables).toMatchObject(today(5))
    const rows = ctx.db.select().from(activity).all()
    expect(rows).toHaveLength(30)
    expect(rows[0]).toMatchObject({ opened: 2, merged: 1, closed: 1, openPrs: 2 })

    calls.length = 0
    await expect(refreshActivity(ctx, api, app, now + 10 * 60_000)).resolves.toBe(false)
    expect(calls).toHaveLength(0)
    await expect(refreshActivity(ctx, api, app, now + hour)).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.variables).toEqual(today(0))

    calls.length = 0
    ctx.db.update(activity).set({ openPrs: null }).where(eq(activity.day, '2026-11-01')).run()
    await refreshActivity(ctx, api, app, now + hour)
    expect(Object.keys(calls[0]!.variables)).toContain('openNow0')
    expect(calls[0]!.variables.openNow0).toContain('created:<=2026-11-01T23:59:59+01:00')
  })

  it('waits between fetches of a past day that is not final yet', async () => {
    const { ctx, app } = await makeCtx()
    const { api, calls } = fakeApi((_, variables) =>
      Object.fromEntries(Object.keys(variables).map((key) => [key, { issueCount: 1 }])),
    )
    const lateNight = Date.parse('2026-11-16T23:50:00+01:00')
    await refreshActivity(ctx, api, app, lateNight)

    calls.length = 0
    await refreshActivity(ctx, api, app, lateNight + 20 * 60_000)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.variables.opened0).toContain(dayRange('2026-11-17'))
    expect(calls[0]!.variables.opened1).toBeUndefined()

    calls.length = 0
    await refreshActivity(ctx, api, app, lateNight + 25 * 60_000)
    expect(calls).toHaveLength(0)

    await refreshActivity(ctx, api, app, lateNight + 40 * 60_000)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.variables.opened0).toContain(dayRange('2026-11-16'))
  })
})

describe('refreshLatency', () => {
  it('replaces the samples of each reviewed pull request', async () => {
    const { ctx, app } = await makeCtx()
    let items: TimelineItem[] = [
      requested('2026-11-10T10:00:00Z', me),
      review('2026-11-10T12:00:00Z', me),
    ]
    const { api, calls } = fakeApi(() => ({
      search: { nodes: [{ id: 'PR_1', timelineItems: { nodes: items } }, {}, null] },
    }))
    const now = Date.parse('2026-11-16T14:00:00+01:00')
    await refreshLatency(ctx, api, app, me, now)
    expect(calls[0]!.variables.q).toBe(
      'repo:acme/app is:pr reviewed-by:@me -author:@me updated:>=2026-10-17 sort:updated-desc',
    )
    expect(ctx.db.select().from(reviewLatency).all()).toEqual([
      {
        repoId: app.id,
        prNodeId: 'PR_1',
        requestedAt: Date.parse('2026-11-10T10:00:00Z'),
        reviewedAt: Date.parse('2026-11-10T12:00:00Z'),
      },
    ])
    items = [requested('2026-11-10T10:00:00Z', me), removed('2026-11-10T11:00:00Z', me)]
    await refreshLatency(ctx, api, app, me, now)
    expect(ctx.db.select().from(reviewLatency).all()).toEqual([])
  })
})

describe('getDashboard', () => {
  const now = Date.parse('2026-11-16T14:00:00+01:00')
  const snap = (repoId: number, day: string, openPrs: number) => ({
    repoId,
    day,
    openPrs,
    openIssues: 0,
    awaitingMe: openPrs - 1,
    myOpen: 1,
    takenAt: 0,
  })

  it('compares today with yesterday on the repositories that have both', async () => {
    const { ctx, app, docs } = await makeCtx()
    ctx.db
      .insert(snapshots)
      .values([
        snap(app.id, '2026-11-14', 6),
        snap(app.id, '2026-11-15', 8),
        snap(app.id, '2026-11-16', 10),
        snap(docs.id, '2026-11-15', 3),
      ])
      .run()
    const dashboard = getDashboard(ctx, { repoId: null }, now)
    expect(dashboard.today).toBe('2026-11-16')
    expect(dashboard.tiles.find((tile) => tile.metric === 'openPrs')).toEqual({
      metric: 'openPrs',
      value: 13,
      from: 8,
      to: 10,
    })
    expect(getDashboard(ctx, { repoId: docs.id }, now).tiles[0]).toEqual({
      metric: 'openPrs',
      value: 3,
      from: null,
      to: null,
    })
  })

  it('sums daily activity and open totals, leaving incomplete days empty, and takes the median latency', async () => {
    const { ctx, app, docs } = await makeCtx()
    ctx.db
      .insert(activity)
      .values([
        {
          repoId: app.id,
          day: '2026-11-16',
          opened: 2,
          merged: 1,
          closed: 0,
          openPrs: 9,
          fetchedAt: now,
        },
        {
          repoId: docs.id,
          day: '2026-11-16',
          opened: 1,
          merged: 0,
          closed: 1,
          openPrs: 3,
          fetchedAt: now,
        },
        {
          repoId: docs.id,
          day: '2026-11-15',
          opened: 1,
          merged: 0,
          closed: 1,
          openPrs: 4,
          fetchedAt: now,
        },
        {
          repoId: app.id,
          day: '2026-11-14',
          opened: 0,
          merged: 0,
          closed: 0,
          openPrs: null,
          fetchedAt: now,
        },
        {
          repoId: docs.id,
          day: '2026-11-14',
          opened: 0,
          merged: 0,
          closed: 0,
          openPrs: 4,
          fetchedAt: now,
        },
      ])
      .run()
    const sample = (prNodeId: string, daysAgo: number, hours: number) => ({
      repoId: app.id,
      prNodeId,
      requestedAt: now - daysAgo * 24 * hour - hours * hour,
      reviewedAt: now - daysAgo * 24 * hour,
    })
    ctx.db
      .insert(reviewLatency)
      .values([sample('A', 1, 1), sample('B', 2, 3), sample('C', 10, 24), sample('D', 40, 1)])
      .run()
    const dashboard = getDashboard(ctx, { repoId: null }, now)
    expect(dashboard.activity.at(-1)).toEqual({
      day: '2026-11-16',
      opened: 3,
      merged: 1,
      closed: 1,
    })
    expect(dashboard.activity.at(-2)).toEqual({
      day: '2026-11-15',
      opened: null,
      merged: null,
      closed: null,
    })
    expect(dashboard.trend).toHaveLength(30)
    expect(dashboard.trend.slice(-3)).toEqual([
      { day: '2026-11-14', openPrs: null },
      { day: '2026-11-15', openPrs: null },
      { day: '2026-11-16', openPrs: 12 },
    ])
    expect(dashboard.latency).toEqual({
      week: { medianS: 2 * 3600, count: 2 },
      month: { medianS: 3 * 3600, count: 3 },
    })
  })

  it('sums merged pull requests per week and month, empty while a day is missing', async () => {
    const { ctx, app, docs } = await makeCtx()
    const days = lastDays(localDay(now), 30)
    const row = (repoId: number, day: string, merged: number) => ({
      repoId,
      day,
      opened: 0,
      merged,
      closed: 0,
      openPrs: 0,
      fetchedAt: now,
    })
    ctx.db
      .insert(activity)
      .values(days.flatMap((day, index) => [row(app.id, day, index % 3), row(docs.id, day, 1)]))
      .run()
    const merged = (repoId: number | null) => getDashboard(ctx, { repoId }, now).merged
    const appCounts = days.map((_, index) => index % 3)
    const total = (counts: number[]) => counts.reduce((sum, value) => sum + value, 0)
    expect(merged(app.id)).toEqual({
      week: total(appCounts.slice(-7)),
      previousWeek: total(appCounts.slice(-14, -7)),
      month: total(appCounts),
    })
    expect(merged(null).month).toBe(total(appCounts) + 30)
    ctx.db.delete(activity).where(eq(activity.day, days[10]!)).run()
    expect(merged(null)).toEqual({
      week: total(appCounts.slice(-7)) + 7,
      previousWeek: total(appCounts.slice(-14, -7)) + 7,
      month: null,
    })
  })

  it('totals agent usage per window, day and stage for the picked repositories', async () => {
    const { ctx, app, docs } = await makeCtx()
    const spend = (
      repoId: number,
      runId: number,
      stage: string,
      at: number,
      costUsd: number,
      tokens = 1000,
    ) => ({
      repoId,
      runId,
      stage,
      model: 'sonnet',
      at,
      tokensIn: tokens,
      tokensOut: tokens / 10,
      costUsd,
    })
    const day = 24 * hour
    ctx.db
      .insert(agentUsage)
      .values([
        spend(app.id, 1, 'review', now - hour, 0.5),
        spend(app.id, 1, 'review', now - 2 * hour, 0.25),
        spend(app.id, 2, 'address', now - 3 * day, 1),
        spend(docs.id, 3, 'review', now - 10 * day, 2),
        spend(app.id, 4, 're-review', now - 40 * day, 9),
        spend(app.id, 5, 'gone', now - day, 4),
      ])
      .run()
    const usage = getDashboard(ctx, { repoId: null }, now).usage
    expect(usage.week).toEqual({ costUsd: 5.75, tokensIn: 4000, tokensOut: 400, runs: 3 })
    expect(usage.month).toEqual({ costUsd: 7.75, tokensIn: 5000, tokensOut: 500, runs: 4 })
    expect(usage.daily).toHaveLength(30)
    expect(usage.daily.at(-1)).toEqual({ day: localDay(now), costUsd: 0.75, tokens: 2200 })
    expect(usage.daily.at(-4)).toEqual({
      day: addDays(localDay(now), -3),
      costUsd: 1,
      tokens: 1100,
    })
    expect(usage.byStage).toEqual([
      { stage: 'review', costUsd: 2.75, tokensIn: 3000, tokensOut: 300, runs: 2 },
      { stage: 'address', costUsd: 1, tokensIn: 1000, tokensOut: 100, runs: 1 },
    ])
    expect(getDashboard(ctx, { repoId: docs.id }, now).usage.month).toEqual({
      costUsd: 2,
      tokensIn: 1000,
      tokensOut: 100,
      runs: 1,
    })
  })
})
