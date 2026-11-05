import type { CheckState, CiState } from '@shared/domain'
import type { GithubApi } from './gh-api'

export type GqlCheck =
  | {
      __typename: 'CheckRun'
      name: string
      status: string
      conclusion: string | null
      detailsUrl?: string | null
    }
  | { __typename: 'StatusContext'; context: string; state: string; targetUrl?: string | null }

export type StateCounts = { state: string; count: number }[]

export type CheckCounts = {
  checkRunCountsByState: StateCounts
  statusContextCountsByState: StateCounts
}

export const checkCountsFields = `contexts(first: 0) {
  checkRunCountsByState { state count }
  statusContextCountsByState { state count }
}`

const runStates: Record<string, CheckState> = {
  SUCCESS: 'success',
  COMPLETED: 'success',
  NEUTRAL: 'neutral',
  SKIPPED: 'skipped',
  STALE: 'skipped',
  FAILURE: 'failure',
  TIMED_OUT: 'failure',
  CANCELLED: 'failure',
  ACTION_REQUIRED: 'failure',
  STARTUP_FAILURE: 'failure',
}

const contextStates: Record<string, CheckState> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  ERROR: 'failure',
}

export function checkState(check: GqlCheck): { name: string; state: CheckState } {
  if (check.__typename === 'StatusContext') {
    return { name: check.context, state: contextStates[check.state] ?? 'pending' }
  }
  if (check.status !== 'COMPLETED') return { name: check.name, state: 'pending' }
  return { name: check.name, state: runStates[check.conclusion ?? ''] ?? 'pending' }
}

export function rollupCi(states: CheckState[]): CiState {
  if (states.length === 0) return 'none'
  if (states.includes('failure')) return 'failure'
  if (states.includes('pending')) return 'pending'
  return 'success'
}

export function ciFromCounts(counts: CheckCounts | null | undefined): CiState {
  if (!counts) return 'none'
  const states = [
    ...counts.checkRunCountsByState.map(({ state, count }) => ({
      state: runStates[state] ?? 'pending',
      count,
    })),
    ...counts.statusContextCountsByState.map(({ state, count }) => ({
      state: contextStates[state] ?? 'pending',
      count,
    })),
  ]
  return rollupCi(states.filter(({ count }) => count > 0).map(({ state }) => state))
}

export function matchesCheck(patterns: string[], name: string) {
  const lower = name.toLowerCase()
  return patterns.some((pattern) => {
    const escaped = pattern
      .trim()
      .toLowerCase()
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    return escaped !== '' && new RegExp(`^${escaped}$`).test(lower)
  })
}

const checksQuery = `
  query Checks($id: ID!, $after: String) {
    node(id: $id) { ... on PullRequest { commits(last: 1) { nodes { commit { statusCheckRollup {
      contexts(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl }
          ... on StatusContext { context state targetUrl }
        }
      }
    } } } } } }
  }
`

type ChecksPage = {
  node: {
    commits: {
      nodes: {
        commit: {
          statusCheckRollup: {
            contexts: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null }
              nodes: (GqlCheck | null)[]
            }
          } | null
        }
      }[]
    }
  } | null
}

export async function fetchChecks(api: GithubApi, nodeId: string, ignored: string[]) {
  const checks: { name: string; state: CheckState; url: string | null; ignored: boolean }[] = []
  let after: string | null = null
  for (let page = 0; page < 5; page += 1) {
    const data: ChecksPage = await api.graphql<ChecksPage>(checksQuery, { id: nodeId, after })
    const contexts = data.node?.commits.nodes[0]?.commit.statusCheckRollup?.contexts
    if (!contexts) break
    for (const node of contexts.nodes) {
      if (!node || !('__typename' in node)) continue
      const { name, state } = checkState(node)
      const url = (node.__typename === 'CheckRun' ? node.detailsUrl : node.targetUrl) ?? null
      checks.push({ name, state, url, ignored: matchesCheck(ignored, name) })
    }
    if (!contexts.pageInfo.hasNextPage) break
    after = contexts.pageInfo.endCursor
  }
  return checks
}

export const ciOfChecks = (checks: { state: CheckState; ignored: boolean }[]) =>
  rollupCi(checks.filter((check) => !check.ignored).map((check) => check.state))
