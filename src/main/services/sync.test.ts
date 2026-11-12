import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openDb } from '../db/client'
import { repos, snapshots } from '../db/schema'
import type { Ctx } from './context'
import type { GithubApi } from './gh-api'
import { deriveStage, loopStage, type PrFacts } from './pr-stage'
import { listPrs, setPrFlags, setPrStage } from './prs'
import { getRepo } from './repos'
import { checkState } from './checks'
import { createRun, dismissRunsForPr, updateRun } from './runs'
import { autoArchiveDone, createSyncService, myReviewOf, syncRepo, type GqlPr } from './sync'

const migrations = resolve(__dirname, '../../../drizzle')
const me = 'octocat'

async function makeCtx() {
  const ctx: Ctx = {
    db: openDb(':memory:', migrations),
    userData: await mkdtemp(join(tmpdir(), 'prism-data-')),
    builtinSkillsDir: '',
    log: () => {},
    skillsChanged: () => {},
  }
  const row = ctx.db
    .insert(repos)
    .values({
      owner: 'acme',
      name: 'app',
      addedAt: 0,
      ignoredChecksJson: JSON.stringify(['flaky-*']),
    })
    .returning()
    .get()
  return { ctx, repo: getRepo(ctx, row.id) }
}

let counter = 0

function makePr(overrides: Partial<GqlPr> = {}): GqlPr {
  counter += 1
  return {
    id: `PR_${counter}`,
    number: counter,
    title: `Change ${counter}`,
    url: `https://github.com/acme/app/pull/${counter}`,
    isDraft: false,
    state: 'OPEN',
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-02T10:00:00Z',
    closedAt: null,
    author: { login: 'someone', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
    headRefName: 'feature',
    headRefOid: 'head1',
    baseRefName: 'main',
    baseRefOid: 'base1',
    reviewDecision: 'REVIEW_REQUIRED',
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...overrides,
  }
}

function commitBy(author: string, committer: string, parents = 1) {
  return {
    commit: {
      parents: { totalCount: parents },
      committer: { user: { login: committer } },
      authors: { nodes: [{ user: { login: author } }] },
    },
  }
}

type Fixture = {
  req?: GqlPr[]
  rev?: GqlPr[]
  auth?: GqlPr[]
  inv?: GqlPr[]
  nodes?: (GqlPr | null)[]
  nodeErrors?: { type: string; index: number }[]
  countsFail?: boolean
}

function fakeApi(fixture: () => Fixture) {
  const calls: string[] = []
  const api: GithubApi = {
    async graphql<T>(query: string) {
      const data = fixture()
      const name = /query (\w+)/.exec(query)?.[1] ?? ''
      calls.push(name)
      if (name === 'Board') {
        const wrap = (list: GqlPr[] = []) => ({ nodes: list })
        return {
          req: wrap(data.req),
          rev: wrap(data.rev),
          auth: wrap(data.auth),
          inv: wrap(data.inv),
        } as T
      }
      if (name === 'Refresh') return { nodes: data.nodes ?? [] } as T
      if (name === 'Counts' && data.countsFail) throw new Error('search limit')
      if (name === 'Checks') {
        const nodes = [
          { __typename: 'CheckRun', name: 'flaky-e2e', status: 'COMPLETED', conclusion: 'FAILURE' },
          { __typename: 'StatusContext', context: 'build', state: 'SUCCESS' },
        ]
        const contexts = { pageInfo: { hasNextPage: false, endCursor: null }, nodes }
        return {
          node: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts } } }] } },
        } as T
      }
      return { openPrs: { issueCount: 3 }, awaitingMe: { issueCount: 1 } } as T
    },
    async graphqlPartial<T>(query: string, variables?: Record<string, unknown>) {
      const data = await api.graphql<T>(query, variables)
      const errors = (fixture().nodeErrors ?? []).map(({ type, index }) => ({
        message: type,
        type,
        path: ['nodes', index],
      }))
      return { data, errors }
    },
    probe: async () => ({ unchanged: false, commit: () => {} }),
    get: async () => {
      throw new Error('unexpected REST call')
    },
    rate: () => null,
  }
  return { api, calls }
}

const base: PrFacts = {
  state: 'OPEN',
  isDraft: false,
  reviewDecision: null,
  headOid: 'h1',
  reviewRequested: false,
  myReview: null,
  unresolvedThreads: 0,
  role: 'reviewer',
}

describe('deriveStage', () => {
  it('derives review columns', () => {
    expect(deriveStage({ ...base, reviewRequested: true })).toBe('to-review')
    const review = { state: 'COMMENTED', oid: 'h1', at: 1 }
    expect(deriveStage({ ...base, reviewRequested: true, myReview: review })).toBe('re-review')
    expect(deriveStage({ ...base, myReview: review })).toBe('changes-requested')
    expect(deriveStage({ ...base, myReview: { ...review, oid: 'h0' } })).toBe('re-review')
    expect(deriveStage({ ...base, myReview: { ...review, state: 'APPROVED' } })).toBe('approved')
    const approved = { ...review, state: 'APPROVED' }
    expect(deriveStage({ ...base, reviewRequested: true, myReview: approved })).toBe('re-review')
    expect(deriveStage({ ...base, myReview: { ...approved, oid: 'h0' } })).toBe('re-review')
    expect(deriveStage({ ...base, myReview: { ...approved, oid: null } })).toBe('approved')
    expect(deriveStage({ ...base, state: 'MERGED' })).toBe('done')
  })

  it('derives my PR columns', () => {
    const mine = { ...base, role: 'author' as const }
    expect(deriveStage({ ...mine, isDraft: true })).toBe('to-review')
    expect(deriveStage(mine)).toBe('to-review')
    expect(deriveStage({ ...mine, unresolvedThreads: 2 })).toBe('changes-requested')
    expect(deriveStage({ ...mine, reviewDecision: 'CHANGES_REQUESTED' })).toBe('changes-requested')
    expect(deriveStage({ ...mine, reviewDecision: 'APPROVED' })).toBe('approved')
    expect(deriveStage({ ...mine, role: 'takeover', state: 'CLOSED' })).toBe('done')
  })
})

describe('loopStage', () => {
  const review = {
    kind: 'review' as const,
    goes: 'changes' as const,
    approvedOnGithub: false,
    reviewedHeadOid: 'h1',
  }

  it('follows the last posted review or address run', () => {
    expect(loopStage('to-review', 'h1', null, null)).toBe('to-review')
    expect(loopStage('to-review', 'h1', review, null)).toBe('changes-requested')
    expect(loopStage('to-review', 'h1', { ...review, goes: 'approve' }, null)).toBe('to-approve')
    expect(
      loopStage('to-review', 'h1', { ...review, goes: 'approve', approvedOnGithub: true }, null),
    ).toBe('approved')
    expect(loopStage('to-review', 'h2', review, null)).toBe('re-review')
    expect(loopStage('changes-requested', 'h1', { ...review, kind: 'address' }, null)).toBe(
      're-review',
    )
  })

  it('lets approvals and closed pull requests win', () => {
    expect(loopStage('to-review', 'h1', review, 'h1')).toBe('approved')
    expect(loopStage('to-review', 'h2', review, 'h1')).toBe('re-review')
    expect(loopStage('approved', 'h1', review, null)).toBe('approved')
    expect(loopStage('done', 'h1', review, null)).toBe('done')
  })
})

describe('syncRepo', () => {
  it('builds the board from searches', async () => {
    const { ctx, repo } = await makeCtx()
    const requested = makePr({
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'core' } }] },
    })
    const authored = makePr({ author: { login: me, avatarUrl: '' }, isDraft: true })
    const takeover = makePr({
      recent: { nodes: [commitBy('OctoCat', 'OctoCat')] },
    })
    const suggested = makePr({ recent: { nodes: [commitBy(me, 'web-flow')] } })
    const mentioned = makePr()
    const { api } = fakeApi(() => ({
      req: [requested],
      auth: [authored],
      inv: [takeover, suggested, mentioned],
    }))

    const counts = await syncRepo(ctx, api, repo, me)

    expect(counts).toEqual({ reviews: 1, mine: 2 })
    const board = listPrs(ctx)
    expect(board).toHaveLength(3)
    const byNumber = new Map(board.map((pr) => [pr.number, pr]))
    expect(byNumber.get(requested.number)).toMatchObject({
      tab: 'reviews',
      stage: 'to-review',
      requestedTeam: 'core',
    })
    expect(byNumber.get(authored.number)).toMatchObject({ tab: 'mine', stage: 'to-review' })
    expect(byNumber.get(takeover.number)).toMatchObject({ role: 'takeover', tab: 'mine' })
    expect(byNumber.has(mentioned.number)).toBe(false)
    expect(byNumber.has(suggested.number)).toBe(false)
    expect(ctx.db.select().from(snapshots).all()).toMatchObject([{ openPrs: 3, awaitingMe: 1 }])
  })

  it('keeps a manual stage until GitHub state changes', async () => {
    const { ctx, repo } = await makeCtx()
    let pr = makePr()
    const { api } = fakeApi(() => ({ req: [pr] }))
    await syncRepo(ctx, api, repo, me)
    const [row] = listPrs(ctx)
    setPrStage(ctx, { id: row!.id, stage: 'approved' })

    await syncRepo(ctx, api, repo, me)
    expect(listPrs(ctx)[0]).toMatchObject({ stage: 'approved', manual: true })

    const review = (state: string, at: string) => ({
      state,
      submittedAt: at,
      commit: { oid: pr.headRefOid },
    })
    pr = { ...pr, reviews: { nodes: [review('COMMENTED', '2026-11-03T10:00:00Z')] } }
    await syncRepo(ctx, api, repo, me)
    const commented = listPrs(ctx)[0]!
    setPrStage(ctx, { id: commented.id, stage: 'approved' })
    pr = {
      ...pr,
      reviews: {
        nodes: [
          review('COMMENTED', '2026-11-03T10:00:00Z'),
          review('COMMENTED', '2026-11-04T10:00:00Z'),
        ],
      },
    }
    await syncRepo(ctx, api, repo, me)
    expect(listPrs(ctx)[0]).toMatchObject({ stage: 'approved', manual: true })

    pr = { ...pr, headRefOid: 'head2' }
    await syncRepo(ctx, api, repo, me)
    expect(listPrs(ctx)[0]).toMatchObject({ stage: 're-review', manual: false })
  })

  it('refreshes PRs that left the searches and archives done ones', async () => {
    const { ctx, repo } = await makeCtx()
    const pr = makePr({ author: { login: me, avatarUrl: '' } })
    let fixture: Fixture = { auth: [pr] }
    const { api, calls } = fakeApi(() => fixture)
    await syncRepo(ctx, api, repo, me)

    fixture = { nodes: [{ ...pr, state: 'MERGED', closedAt: '2026-11-03T10:00:00Z' }] }
    await syncRepo(ctx, api, repo, me)
    expect(calls).toContain('Refresh')
    expect(listPrs(ctx)[0]).toMatchObject({ stage: 'done', archivedAt: null })

    expect(autoArchiveDone(ctx, Date.parse('2026-11-05T10:00:00Z'))).toBe(1)
    expect(listPrs(ctx)[0]?.archivedAt).not.toBeNull()
  })

  it('drops review PRs that no longer involve me unless starred', async () => {
    const { ctx, repo } = await makeCtx()
    const first = makePr()
    const second = makePr()
    let fixture: Fixture = { req: [first, second] }
    const { api } = fakeApi(() => fixture)
    await syncRepo(ctx, api, repo, me)
    const starred = listPrs(ctx).find((pr) => pr.number === second.number)!
    setPrFlags(ctx, { id: starred.id, starred: true, hidden: true })

    fixture = { nodes: [first, second] }
    await syncRepo(ctx, api, repo, me)
    expect(listPrs(ctx)).toMatchObject([{ number: second.number, starred: true, hidden: true }])
  })

  it('ignores expected-red checks', async () => {
    const { ctx, repo } = await makeCtx()
    const counts = {
      checkRunCountsByState: [{ state: 'FAILURE', count: 1 }],
      statusContextCountsByState: [{ state: 'SUCCESS', count: 1 }],
    }
    const pr = makePr({
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: counts } } }] },
    })
    const { api, calls } = fakeApi(() => ({ req: [pr] }))
    await syncRepo(ctx, api, repo, me)
    expect(calls).toContain('Checks')
    expect(listPrs(ctx)[0]?.ciState).toBe('success')
  })

  it('keeps a restored done PR out of auto-archive', async () => {
    const { ctx, repo } = await makeCtx()
    const pr = makePr({ state: 'MERGED', closedAt: '2026-11-01T10:00:00Z' })
    const { api } = fakeApi(() => ({
      nodes: [],
      auth: [{ ...pr, author: { login: me, avatarUrl: '' } }],
    }))
    await syncRepo(ctx, api, repo, me)
    const now = Date.parse('2026-11-05T10:00:00Z')
    expect(autoArchiveDone(ctx, now)).toBe(1)
    const [row] = listPrs(ctx)
    setPrFlags(ctx, { id: row!.id, archived: false })
    expect(autoArchiveDone(ctx, now + 60_000)).toBe(0)
    expect(listPrs(ctx)[0]?.archivedAt).toBeNull()
  })

  it('keeps a team request when the PR is only refreshed by id', async () => {
    const { ctx, repo } = await makeCtx()
    const pr = makePr({
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'core' } }] },
    })
    let fixture: Fixture = { req: [pr] }
    const { api } = fakeApi(() => fixture)
    await syncRepo(ctx, api, repo, me)
    fixture = { nodes: [pr] }
    await syncRepo(ctx, api, repo, me)
    expect(listPrs(ctx)).toMatchObject([{ number: pr.number, stage: 'to-review' }])
  })
})

describe('review and check edge cases', () => {
  it('keeps my verdict when I comment after approving', () => {
    const commented = {
      reviews: {
        nodes: [{ state: 'COMMENTED', submittedAt: '2026-11-03T10:00:00Z', commit: { oid: 'h2' } }],
      },
    }
    const opinion = (state: string, login = me) => ({ nodes: [{ state, author: { login } }] })
    const pr = makePr({ ...commented, latestOpinionatedReviews: opinion('APPROVED') })
    expect(myReviewOf(pr, me)).toEqual({
      state: 'APPROVED',
      oid: 'h2',
      at: Date.parse('2026-11-03T10:00:00Z'),
    })
    expect(
      myReviewOf(
        makePr({ ...commented, latestOpinionatedReviews: opinion('APPROVED', 'someone') }),
        me,
      )?.state,
    ).toBe('COMMENTED')
    expect(
      myReviewOf(makePr({ ...commented, latestOpinionatedReviews: opinion('DISMISSED') }), me)
        ?.state,
    ).toBe('COMMENTED')
    expect(myReviewOf(makePr(), me)).toBeNull()
  })

  it('keeps my verdict after many later comments', async () => {
    const { ctx, repo } = await makeCtx()
    const pr = makePr({
      reviews: {
        nodes: [
          { state: 'COMMENTED', submittedAt: '2026-11-04T10:00:00Z', commit: { oid: 'head1' } },
        ],
      },
      latestOpinionatedReviews: { nodes: [{ state: 'APPROVED', author: { login: 'OctoCat' } }] },
    })
    const { api } = fakeApi(() => ({ rev: [pr] }))
    await syncRepo(ctx, api, repo, me)
    expect(listPrs(ctx)[0]).toMatchObject({ myReviewState: 'APPROVED', stage: 'approved' })
  })

  it('treats unknown check conclusions as pending', () => {
    expect(
      checkState({
        __typename: 'CheckRun',
        name: 'x',
        status: 'COMPLETED',
        conclusion: 'NEW_VALUE',
      }),
    ).toEqual({ name: 'x', state: 'pending' })
  })

  it('keeps a review PR with an undismissed run until it is dismissed', async () => {
    const { ctx, repo } = await makeCtx()
    const pr = makePr()
    let fixture: Fixture = { req: [pr] }
    const { api } = fakeApi(() => fixture)
    await syncRepo(ctx, api, repo, me)
    const id = listPrs(ctx)[0]!.id
    const run = createRun(ctx, {
      prId: id,
      stage: 'review',
      skillId: null,
      skillName: null,
      agent: 'claude',
      model: 'claude-haiku-5-5',
    })
    updateRun(ctx, run.id, { status: 'failed', error: 'rate limited', endedAt: Date.now() })

    fixture = { nodes: [pr] }
    await syncRepo(ctx, api, repo, me)
    expect(listPrs(ctx).map((item) => item.id)).toEqual([id])

    dismissRunsForPr(ctx, id)
    await syncRepo(ctx, api, repo, me)
    expect(listPrs(ctx)).toEqual([])
  })

  it('drops PRs GitHub no longer returns, keeps starred ones', async () => {
    const { ctx, repo } = await makeCtx()
    const first = makePr({ author: { login: me, avatarUrl: '' } })
    const second = makePr({ author: { login: me, avatarUrl: '' } })
    let fixture: Fixture = { auth: [first, second] }
    const { api } = fakeApi(() => fixture)
    await syncRepo(ctx, api, repo, me)
    const kept = listPrs(ctx).find((pr) => pr.number === second.number)!
    setPrFlags(ctx, { id: kept.id, starred: true })
    fixture = {
      nodes: [null, null],
      nodeErrors: [
        { type: 'NOT_FOUND', index: 0 },
        { type: 'NOT_FOUND', index: 1 },
      ],
    }
    await syncRepo(ctx, api, repo, me)
    expect(listPrs(ctx).map((pr) => pr.number)).toEqual([second.number])
  })

  it('keeps PRs and flags when access is refused', async () => {
    const { ctx, repo } = await makeCtx()
    const pr = makePr({ author: { login: me, avatarUrl: '' } })
    let fixture: Fixture = { auth: [pr] }
    const { api } = fakeApi(() => fixture)
    await syncRepo(ctx, api, repo, me)
    const [row] = listPrs(ctx)
    setPrFlags(ctx, { id: row!.id, hidden: true })
    fixture = { nodes: [null], nodeErrors: [{ type: 'FORBIDDEN', index: 0 }] }
    await syncRepo(ctx, api, repo, me)
    expect(listPrs(ctx)).toMatchObject([{ number: pr.number, hidden: true }])
  })

  it('does not fail the repo sync when the snapshot fails', async () => {
    const { ctx, repo } = await makeCtx()
    const { api } = fakeApi(() => ({ req: [makePr()], countsFail: true }))
    await expect(syncRepo(ctx, api, repo, me)).resolves.toEqual({ reviews: 1, mine: 0 })
  })

  it('resolves pending CI when only ignored checks are pending', async () => {
    const { ctx, repo } = await makeCtx()
    const counts = {
      checkRunCountsByState: [{ state: 'IN_PROGRESS', count: 1 }],
      statusContextCountsByState: [{ state: 'SUCCESS', count: 1 }],
    }
    const pr = makePr({
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: counts } } }] },
    })
    const { api } = fakeApi(() => ({ req: [pr] }))
    const original = api.graphql
    api.graphql = (async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes('query Checks')) {
        const nodes = [
          { __typename: 'CheckRun', name: 'flaky-e2e', status: 'IN_PROGRESS', conclusion: null },
          { __typename: 'StatusContext', context: 'build', state: 'SUCCESS' },
        ]
        const contexts = { pageInfo: { hasNextPage: false, endCursor: null }, nodes }
        return { node: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts } } }] } } }
      }
      return original(query, variables)
    }) as typeof api.graphql
    await syncRepo(ctx, api, repo, me)
    expect(listPrs(ctx)[0]?.ciState).toBe('success')
  })
})

describe('sync service', () => {
  const hooks = {
    status: () => {},
    changed: () => {},
    login: async () => me,
    enabled: () => true,
  }

  it('keeps the ETag uncommitted when a repo sync fails', async () => {
    const { ctx } = await makeCtx()
    const commits: number[] = []
    let fail = true
    const { api } = fakeApi(() => {
      if (fail) throw new Error('GitHub is down')
      return {}
    })
    api.probe = async () => ({ unchanged: false, commit: () => commits.push(1) })
    const sync = createSyncService(ctx, api, hooks)
    const failed = await sync.syncNow(true)
    expect(failed.repos[0]).toMatchObject({ state: 'error', error: 'GitHub is down' })
    expect(commits).toHaveLength(0)
    fail = false
    await sync.syncNow(true)
    expect(commits).toHaveLength(1)
  })

  it('syncs on focus without forcing, at most every 15s', async () => {
    const { ctx } = await makeCtx()
    const { api, calls } = fakeApi(() => ({}))
    let probes = 0
    api.probe = async () => {
      probes += 1
      return { unchanged: true, commit: () => {} }
    }
    const sync = createSyncService(ctx, api, hooks)
    await sync.syncNow(true)
    const settle = () => new Promise((done) => setTimeout(done, 0))
    calls.length = 0
    probes = 0

    sync.focus()
    await settle()
    expect(probes).toBe(0)

    vi.useFakeTimers({ now: Date.now() + 20_000, toFake: ['Date'] })
    try {
      sync.focus()
      await settle()
      expect(probes).toBe(1)
      expect(calls).not.toContain('Board')
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs a forced sync after an in-flight light one', async () => {
    const { ctx } = await makeCtx()
    const { api, calls } = fakeApi(() => ({}))
    api.probe = async () => ({ unchanged: true, commit: () => {} })
    const sync = createSyncService(ctx, api, hooks)
    await sync.syncNow(true)
    calls.length = 0
    const light = sync.syncNow(false)
    const forced = sync.syncNow(true)
    expect(forced).not.toBe(light)
    await forced
    expect(calls.filter((name) => name === 'Board')).toHaveLength(1)
  })
})
