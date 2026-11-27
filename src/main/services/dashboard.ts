import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import {
  stages,
  type Dashboard,
  type DashboardMetric,
  type Repo,
  type ReviewTotals,
  type Stage,
  type UsageTotals,
} from '@shared/domain'
import { activity, agentUsage, myReviews, repos, reviewLatency, snapshots } from '../db/schema'
import type { Ctx } from './context'
import { addDays, dayEnd, dayRange, dayStart, lastDays, localDay } from './days'
import type { GithubApi } from './gh-api'
import { listRepos } from './repos'

export const activityDays = 30
const finalAfter = 6 * 3600_000
const refreshEvery = 30 * 60_000
const daysPerQuery = 6
const dayMs = 24 * 3600_000

const slug = (repo: Repo) => `${repo.owner}/${repo.name}`

const activityKinds = {
  opened: (day: string) => `is:pr created:${dayRange(day)}`,
  merged: (day: string) => `is:pr merged:${dayRange(day)}`,
  closed: (day: string) => `is:pr is:unmerged closed:${dayRange(day)}`,
  openNow: (day: string) => `is:pr is:open created:<=${dayEnd(day)}`,
  closedLater: (day: string) => `is:pr closed:>${dayEnd(day)} created:<=${dayEnd(day)}`,
  myOpened: (day: string) => `is:pr author:@me created:${dayRange(day)}`,
  myMerged: (day: string) => `is:pr author:@me merged:${dayRange(day)}`,
} as const

type ActivityKind = keyof typeof activityKinds

function activityQuery(days: number) {
  const names = Array.from({ length: days }, (_, index) =>
    Object.keys(activityKinds).map((kind) => `${kind}${index}`),
  ).flat()
  const variables = names.map((name) => `$${name}: String!`).join(', ')
  const fields = names
    .map((name) => `${name}: search(query: $${name}, type: ISSUE, first: 0) { issueCount }`)
    .join('\n')
  return `query Activity(${variables}) {\n${fields}\n}`
}

const isFinal = (day: string, fetchedAt: number) =>
  fetchedAt >= dayStart(addDays(day, 1)) + finalAfter

export async function refreshActivity(ctx: Ctx, api: GithubApi, repo: Repo, now: number) {
  const today = localDay(now)
  const days = lastDays(today, activityDays)
  const known = new Map(
    ctx.db
      .select()
      .from(activity)
      .where(and(eq(activity.repoId, repo.id), inArray(activity.day, days)))
      .all()
      .map((row) => [row.day, row]),
  )
  const due = days.filter((day) => {
    const row = known.get(day)
    if (!row || row.openPrs === null || row.myOpened === null || row.myMerged === null) return true
    if (now - row.fetchedAt < refreshEvery) return false
    return day === today || !isFinal(day, row.fetchedAt)
  })
  for (let start = 0; start < due.length; start += daysPerQuery) {
    const chunk = due.slice(start, start + daysPerQuery)
    const variables: Record<string, string> = {}
    chunk.forEach((day, index) => {
      for (const [kind, query] of Object.entries(activityKinds)) {
        variables[`${kind}${index}`] = `repo:${slug(repo)} ${query(day)}`
      }
    })
    const data = await api.graphql<Record<string, { issueCount: number } | undefined>>(
      activityQuery(chunk.length),
      variables,
    )
    const count = (kind: ActivityKind, index: number) => data[`${kind}${index}`]?.issueCount ?? 0
    chunk.forEach((day, index) => {
      const values = {
        repoId: repo.id,
        day,
        opened: count('opened', index),
        merged: count('merged', index),
        closed: count('closed', index),
        openPrs: count('openNow', index) + count('closedLater', index),
        myOpened: count('myOpened', index),
        myMerged: count('myMerged', index),
        fetchedAt: now,
      }
      ctx.db
        .insert(activity)
        .values(values)
        .onConflictDoUpdate({ target: [activity.repoId, activity.day], set: values })
        .run()
    })
  }
  return due.includes(today)
}

type Reviewer = { __typename: string; login?: string; slug?: string } | null

export type TimelineItem =
  | { __typename: 'ReviewRequestedEvent'; createdAt: string; requestedReviewer: Reviewer }
  | { __typename: 'ReviewRequestRemovedEvent'; createdAt: string; requestedReviewer: Reviewer }
  | {
      __typename: 'PullRequestReview'
      submittedAt: string | null
      author: { login: string } | null
    }

const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase()

function reviewerKey(reviewer: Reviewer, login: string) {
  if (reviewer?.__typename === 'User' && same(reviewer.login, login)) return 'me'
  if (reviewer?.__typename === 'Team' && reviewer.slug) return `team:${reviewer.slug}`
  return null
}

const itemTime = (item: TimelineItem) =>
  Date.parse(item.__typename === 'PullRequestReview' ? (item.submittedAt ?? '') : item.createdAt)

export function latencySamples(items: TimelineItem[], login: string) {
  const pending = new Map<string, number>()
  const samples: { requestedAt: number; reviewedAt: number }[] = []
  const timed = items
    .map((item) => ({ item, at: itemTime(item) }))
    .filter(({ at }) => !Number.isNaN(at))
    .sort((a, b) => a.at - b.at)
  for (const { item, at } of timed) {
    if (item.__typename === 'PullRequestReview') {
      if (!same(item.author?.login, login) || pending.size === 0) continue
      const requestedAt = pending.get('me') ?? Math.min(...pending.values())
      samples.push({ requestedAt, reviewedAt: at })
      pending.clear()
      continue
    }
    const key = reviewerKey(item.requestedReviewer, login)
    if (!key) continue
    if (item.__typename === 'ReviewRequestRemovedEvent') pending.delete(key)
    else if (!pending.has(key)) pending.set(key, at)
  }
  return samples
}

export type MyReview = { id: string; state: string; submittedAt: string | null }

export type ReviewDismissal = { previousReviewState?: string; review?: { id: string } | null }

export function reviewsDone(reviews: MyReview[], dismissals: ReviewDismissal[]) {
  const dismissedApprovals = new Set(
    dismissals.flatMap((event) =>
      event.previousReviewState === 'APPROVED' && event.review ? [event.review.id] : [],
    ),
  )
  return reviews.flatMap((review) => {
    const submittedAt = Date.parse(review.submittedAt ?? '')
    if (review.state === 'PENDING' || Number.isNaN(submittedAt)) return []
    const approved =
      review.state === 'APPROVED' ||
      (review.state === 'DISMISSED' && dismissedApprovals.has(review.id))
    return [{ id: review.id, approved, submittedAt }]
  })
}

const reviewerFields = `requestedReviewer { __typename ... on User { login } ... on Team { slug } }`

const reviewsQuery = `
  query Reviews($q: String!, $login: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          id
          timelineItems(
            last: 100
            itemTypes: [REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, PULL_REQUEST_REVIEW]
          ) {
            nodes {
              __typename
              ... on ReviewRequestedEvent { createdAt ${reviewerFields} }
              ... on ReviewRequestRemovedEvent { createdAt ${reviewerFields} }
              ... on PullRequestReview { submittedAt author { login } }
            }
          }
          reviews(author: $login, last: 50) { nodes { id state submittedAt } }
          dismissals: timelineItems(last: 50, itemTypes: [REVIEW_DISMISSED_EVENT]) {
            nodes { ... on ReviewDismissedEvent { previousReviewState review { id } } }
          }
        }
      }
    }
  }
`

type Connection<T> = { nodes: (T | null)[] }

type ReviewedPr = {
  id?: string
  timelineItems?: Connection<TimelineItem>
  reviews?: Connection<MyReview>
  dismissals?: Connection<ReviewDismissal>
}

const nodesOf = <T>(connection: Connection<T> | undefined) =>
  (connection?.nodes ?? []).filter((node): node is T => !!node)

const maxReviewPages = 10

export async function refreshReviews(
  ctx: Ctx,
  api: GithubApi,
  repo: Repo,
  login: string,
  now: number,
) {
  const since = addDays(localDay(now), -activityDays)
  const q = `repo:${slug(repo)} is:pr reviewed-by:@me -author:@me updated:>=${since} sort:updated-desc`
  const found: (ReviewedPr & { id: string })[] = []
  let after: string | null = null
  for (let page = 0; page < maxReviewPages; page++) {
    const data: {
      search: {
        pageInfo?: { hasNextPage: boolean; endCursor: string | null }
        nodes: (ReviewedPr | null)[]
      }
    } = await api.graphql(reviewsQuery, { q, login, after })
    found.push(
      ...data.search.nodes.filter(
        (node): node is ReviewedPr & { id: string } => !!node?.id && !!node.timelineItems,
      ),
    )
    const next = data.search.pageInfo
    if (!next?.hasNextPage || !next.endCursor) break
    after = next.endCursor
  }
  ctx.db.transaction((tx) => {
    for (const pr of found) {
      tx.delete(reviewLatency).where(eq(reviewLatency.prNodeId, pr.id)).run()
      for (const sample of latencySamples(nodesOf(pr.timelineItems), login)) {
        tx.insert(reviewLatency)
          .values({ repoId: repo.id, prNodeId: pr.id, ...sample })
          .run()
      }
      tx.delete(myReviews).where(eq(myReviews.prNodeId, pr.id)).run()
      for (const review of reviewsDone(nodesOf(pr.reviews), nodesOf(pr.dismissals))) {
        tx.insert(myReviews)
          .values({ repoId: repo.id, prNodeId: pr.id, ...review })
          .run()
      }
    }
    tx.delete(myReviews)
      .where(and(eq(myReviews.repoId, repo.id), lt(myReviews.submittedAt, dayStart(since))))
      .run()
    tx.update(repos).set({ reviewsFetchedAt: now }).where(eq(repos.id, repo.id)).run()
  })
}

function reviewsFetchedAt(ctx: Ctx, repoId: number) {
  const row = ctx.db
    .select({ at: repos.reviewsFetchedAt })
    .from(repos)
    .where(eq(repos.id, repoId))
    .get()
  return row?.at ?? null
}

export async function refreshDashboard(
  ctx: Ctx,
  api: GithubApi,
  repo: Repo,
  login: string,
  now: number,
) {
  const todayFetched = await refreshActivity(ctx, api, repo, now)
  if (todayFetched || reviewsFetchedAt(ctx, repo.id) === null) {
    await refreshReviews(ctx, api, repo, login, now)
  }
}

const metrics: DashboardMetric[] = ['openPrs', 'awaitingMe', 'myOpen', 'openIssues']

const sum = (values: number[]) =>
  values.length ? values.reduce((total, value) => total + value, 0) : null

function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function windowSum(values: (number | null)[]) {
  return values.some((value) => value === null) ? null : sum(values as number[])
}

type ActivityRow = typeof activity.$inferSelect

type UsageRow = typeof agentUsage.$inferSelect

function usageTotals(rows: UsageRow[]): UsageTotals {
  return {
    costUsd: rows.reduce((total, row) => total + row.costUsd, 0),
    tokensIn: rows.reduce((total, row) => total + row.tokensIn, 0),
    tokensOut: rows.reduce((total, row) => total + row.tokensOut, 0),
    runs: new Set(rows.map((row) => row.runId)).size,
  }
}

const isStage = (value: string): value is Stage => (stages as readonly string[]).includes(value)

function usageOf(rows: UsageRow[], period: string[]) {
  const dayOf = new Map(rows.map((row) => [row.id, localDay(row.at)]))
  const within = (days: string[]) => rows.filter((row) => days.includes(dayOf.get(row.id)!))
  const byStage = new Map<Stage, UsageRow[]>()
  for (const row of rows) {
    if (!isStage(row.stage)) continue
    byStage.set(row.stage, [...(byStage.get(row.stage) ?? []), row])
  }
  return {
    week: usageTotals(within(period.slice(-7))),
    month: usageTotals(rows),
    daily: period.map((day) => {
      const totals = usageTotals(within([day]))
      return { day, costUsd: totals.costUsd, tokens: totals.tokensIn + totals.tokensOut }
    }),
    byStage: [...byStage]
      .map(([stage, stageRows]) => ({ stage, ...usageTotals(stageRows) }))
      .sort((a, b) => b.costUsd - a.costUsd),
  }
}

export function getDashboard(
  ctx: Ctx,
  input: { repoId: number | null },
  now = Date.now(),
): Dashboard {
  const today = localDay(now)
  const yesterday = addDays(today, -1)
  const repoIds = input.repoId === null ? listRepos(ctx).map((repo) => repo.id) : [input.repoId]
  const period = lastDays(today, activityDays)

  const snaps = ctx.db
    .select()
    .from(snapshots)
    .where(and(inArray(snapshots.repoId, repoIds), gte(snapshots.day, period[0]!)))
    .all()
  const latest = new Map<number, (typeof snaps)[number]>()
  for (const snap of snaps) {
    const current = latest.get(snap.repoId)
    if (!current || snap.day > current.day) latest.set(snap.repoId, snap)
  }
  const byDay = (target: string) =>
    new Map(snaps.filter((snap) => snap.day === target).map((snap) => [snap.repoId, snap]))
  const todays = byDay(today)
  const yesterdays = byDay(yesterday)
  const compared = [...todays.keys()].filter((repoId) => yesterdays.has(repoId))

  const tiles = metrics.map((metric) => ({
    metric,
    value: sum([...latest.values()].map((snap) => snap[metric])),
    from: sum(compared.map((repoId) => yesterdays.get(repoId)![metric])),
    to: sum(compared.map((repoId) => todays.get(repoId)![metric])),
  }))

  const activityRows = ctx.db
    .select()
    .from(activity)
    .where(and(inArray(activity.repoId, repoIds), gte(activity.day, period[0]!)))
    .all()
  const rowsOf = (target: string) => {
    const rows = activityRows.filter((row) => row.day === target)
    return rows.length < repoIds.length ? [] : rows
  }
  const activitySeries = period.map((target) => {
    const rows = rowsOf(target)
    return {
      day: target,
      opened: sum(rows.map((row) => row.opened)),
      merged: sum(rows.map((row) => row.merged)),
      closed: sum(rows.map((row) => row.closed)),
    }
  })
  const fetchedTotal = (target: string, pick: (row: ActivityRow) => number | null) => {
    const rows = rowsOf(target)
    const values = rows.flatMap((row) => {
      const value = pick(row)
      return value === null ? [] : [value]
    })
    return values.length === rows.length ? sum(values) : null
  }
  const trend = period.map((target) => ({
    day: target,
    openPrs: fetchedTotal(target, (row) => row.openPrs),
  }))
  const myOpened = period.map((target) => fetchedTotal(target, (row) => row.myOpened))
  const myMerged = period.map((target) => fetchedTotal(target, (row) => row.myMerged))

  const samples = ctx.db
    .select()
    .from(reviewLatency)
    .where(
      and(
        inArray(reviewLatency.repoId, repoIds),
        gte(reviewLatency.reviewedAt, now - activityDays * dayMs),
      ),
    )
    .all()
  const latency = (days: number) => {
    const within = samples
      .filter((sample) => sample.reviewedAt >= now - days * dayMs)
      .map((sample) => (sample.reviewedAt - sample.requestedAt) / 1000)
    return { medianS: median(within), count: within.length }
  }

  const reviewsFetched = ctx.db
    .select({ at: repos.reviewsFetchedAt })
    .from(repos)
    .where(inArray(repos.id, repoIds))
    .all()
    .every((row) => row.at !== null)
  const reviewRows = ctx.db
    .select()
    .from(myReviews)
    .where(
      and(inArray(myReviews.repoId, repoIds), gte(myReviews.submittedAt, dayStart(period[0]!))),
    )
    .all()
  const reviewTotals = (days: string[]): ReviewTotals => {
    const within = reviewRows.filter((row) => days.includes(localDay(row.submittedAt)))
    return {
      reviews: within.length,
      pullRequests: new Set(within.map((row) => row.prNodeId)).size,
      approvals: within.filter((row) => row.approved).length,
    }
  }

  const merged = activitySeries.map((entry) => entry.merged)
  const usageRows = ctx.db
    .select()
    .from(agentUsage)
    .where(and(inArray(agentUsage.repoId, repoIds), gte(agentUsage.at, dayStart(period[0]!))))
    .all()

  return {
    today,
    tiles,
    trend,
    activity: activitySeries,
    latency: { week: latency(7), month: latency(30) },
    myReviews: reviewsFetched
      ? { week: reviewTotals(period.slice(-7)), month: reviewTotals(period) }
      : null,
    myPullRequests: {
      week: { opened: windowSum(myOpened.slice(-7)), merged: windowSum(myMerged.slice(-7)) },
      month: { opened: windowSum(myOpened), merged: windowSum(myMerged) },
    },
    merged: {
      week: windowSum(merged.slice(-7)),
      previousWeek: windowSum(merged.slice(-14, -7)),
      month: windowSum(merged),
    },
    usage: usageOf(usageRows, period),
  }
}
