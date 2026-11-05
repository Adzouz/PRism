import { run } from '../system/exec'

export type RateInfo = { limit: number; remaining: number; resetAt: number }

export type GraphqlError = { message: string; type?: string; path?: (string | number)[] }

export type GithubApi = {
  graphql: <T>(query: string, variables?: Record<string, unknown>) => Promise<T>
  graphqlPartial: <T>(
    query: string,
    variables?: Record<string, unknown>,
  ) => Promise<{ data: T; errors: GraphqlError[] }>
  probe: (path: string) => Promise<{ unchanged: boolean; commit: () => void }>
  rate: () => RateInfo | null
}

const base = 'https://api.github.com'

export function createGithubApi(): GithubApi {
  let token: string | null = null
  let rate: RateInfo | null = null
  const etags = new Map<string, string>()

  async function getToken(refresh = false) {
    if (token && !refresh) return token
    const result = await run('gh', ['auth', 'token', '--hostname', 'github.com'])
    const value = result.stdout.trim()
    if (result.code !== 0 || !value) throw new Error('GitHub is not connected. Run gh auth login.')
    token = value
    return token
  }

  function readRate(response: Response) {
    const { headers } = response
    if (headers.get('x-ratelimit-resource') !== 'graphql') return
    rate = {
      limit: Number(headers.get('x-ratelimit-limit')),
      remaining: Number(headers.get('x-ratelimit-remaining')),
      resetAt: Number(headers.get('x-ratelimit-reset')) * 1000,
    }
  }

  async function request(path: string, init: RequestInit, retry = true): Promise<Response> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'PRism',
        'X-GitHub-Api-Version': '2022-11-28',
        ...init.headers,
      },
    })
    if (response.status === 401 && retry) {
      await getToken(true)
      return request(path, init, false)
    }
    readRate(response)
    return response
  }

  async function graphqlPartial<T>(query: string, variables: Record<string, unknown> = {}) {
    const response = await request('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    const payload = (await response.json().catch(() => null)) as {
      data?: T
      errors?: GraphqlError[]
      message?: string
    } | null
    if (!response.ok || !payload?.data) {
      const message =
        payload?.errors?.[0]?.message ?? payload?.message ?? `GitHub returned ${response.status}`
      throw new Error(message)
    }
    return { data: payload.data, errors: payload.errors ?? [] }
  }

  return {
    graphqlPartial,
    async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
      return (await graphqlPartial<T>(query, variables)).data
    },
    async probe(path: string) {
      const etag = etags.get(path)
      const response = await request(path, { headers: etag ? { 'If-None-Match': etag } : {} })
      await response.body?.cancel()
      const next = response.headers.get('etag')
      return {
        unchanged: response.status === 304,
        commit: () => {
          if (response.ok && next) etags.set(path, next)
        },
      }
    },
    rate: () => rate,
  }
}
