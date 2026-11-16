import { and, eq, gte, inArray } from 'drizzle-orm'
import type { Dashboard, DashboardMetric, Repo } from '@shared/domain'
import { activity, reviewLatency, snapshots } from '../db/schema'
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
    if (!row || row.openPrs === null) return true
    if (day === today) return now - row.fetchedAt >= refreshEvery
    return !isFinal(day, row.fetchedAt)
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
      samples.push({ requestedAt: Math.min(...pending.values()), reviewedAt: at })
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

const reviewerFields = `requestedReviewer { __typename ... on User { login } ... on Team { slug } }`

const latencyQuery = `
  query Latency($q: String!) {
    search(query: $q, type: ISSUE, first: 50) {
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
        }
      }
    }
  }
`

type LatencyPr = { id?: string; timelineItems?: { nodes: (TimelineItem | null)[] } }

export async function refreshLatency(
  ctx: Ctx,
  api: GithubApi,
  repo: Repo,
  login: string,
  now: number,
) {
  const since = addDays(localDay(now), -activityDays)
  const data = await api.graphql<{ search: { nodes: (LatencyPr | null)[] } }>(latencyQuery, {
    q: `repo:${slug(repo)} is:pr reviewed-by:@me -author:@me updated:>=${since} sort:updated-desc`,
  })
  const found = data.search.nodes.filter(
    (node): node is Required<LatencyPr> => !!node?.id && !!node.timelineItems,
  )
  ctx.db.transaction((tx) => {
    for (const pr of found) {
      tx.delete(reviewLatency).where(eq(reviewLatency.prNodeId, pr.id)).run()
      const items = pr.timelineItems.nodes.filter((item): item is TimelineItem => !!item)
      for (const sample of latencySamples(items, login)) {
        tx.insert(reviewLatency)
          .values({ repoId: repo.id, prNodeId: pr.id, ...sample })
          .run()
      }
    }
  })
}

export async function refreshDashboard(
  ctx: Ctx,
  api: GithubApi,
  repo: Repo,
  login: string,
  now: number,
) {
  if (await refreshActivity(ctx, api, repo, now)) await refreshLatency(ctx, api, repo, login, now)
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
  const trend = period.map((target) => {
    const rows = rowsOf(target)
    const open = rows.flatMap((row) => (row.openPrs === null ? [] : [row.openPrs]))
    return { day: target, openPrs: open.length === rows.length ? sum(open) : null }
  })

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

  return {
    today,
    tiles,
    trend,
    activity: activitySeries,
    latency: { week: latency(7), month: latency(30) },
  }
}
