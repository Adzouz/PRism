import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../db/client'
import { repos, snapshots } from '../db/schema'
import type { Ctx } from './context'
import type { GithubApi } from './gh-api'
import { deriveStage, type PrFacts } from './pr-stage'
import { listPrs, setPrFlags, setPrStage } from './prs'
import { getRepo } from './repos'
import { autoArchiveDone, syncRepo, type GqlPr } from './sync'

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
    reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...overrides,
  }
}

type Fixture = { req?: GqlPr[]; rev?: GqlPr[]; auth?: GqlPr[]; inv?: GqlPr[]; nodes?: GqlPr[] }

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
    unchanged: async () => false,
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
    expect(deriveStage({ ...base, myReview: review })).toBe('waiting-on-author')
    expect(deriveStage({ ...base, myReview: { ...review, oid: 'h0' } })).toBe('re-review')
    expect(deriveStage({ ...base, myReview: { ...review, state: 'APPROVED' } })).toBe('approved')
    expect(deriveStage({ ...base, state: 'MERGED' })).toBe('done')
  })

  it('derives my PR columns', () => {
    const mine = { ...base, role: 'author' as const }
    expect(deriveStage({ ...mine, isDraft: true })).toBe('draft')
    expect(deriveStage(mine)).toBe('waiting-for-review')
    expect(deriveStage({ ...mine, unresolvedThreads: 2 })).toBe('changes-requested')
    expect(deriveStage({ ...mine, reviewDecision: 'CHANGES_REQUESTED' })).toBe('changes-requested')
    expect(deriveStage({ ...mine, reviewDecision: 'APPROVED' })).toBe('approved')
    expect(deriveStage({ ...mine, role: 'takeover', state: 'CLOSED' })).toBe('done')
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
      recent: {
        nodes: [{ commit: { authors: { nodes: [{ user: { login: 'OctoCat' } }] } } }],
      },
    })
    const mentioned = makePr()
    const { api } = fakeApi(() => ({
      req: [requested],
      auth: [authored],
      inv: [takeover, mentioned],
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
    expect(byNumber.get(authored.number)).toMatchObject({ tab: 'mine', stage: 'draft' })
    expect(byNumber.get(takeover.number)).toMatchObject({ role: 'takeover', tab: 'mine' })
    expect(byNumber.has(mentioned.number)).toBe(false)
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

    pr = { ...pr, headRefOid: 'head2' }
    await syncRepo(ctx, api, repo, me)
    expect(listPrs(ctx)[0]).toMatchObject({ stage: 'to-review', manual: false })
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
})
