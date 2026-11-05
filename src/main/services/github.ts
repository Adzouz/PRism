import type { GithubRepoSummary, GithubStatus } from '@shared/domain'
import { run, which } from '../system/exec'

export const requiredScopes = ['repo', 'read:org']

export function parseScopes(output: string) {
  const line = /Token scopes:\s*(.*)/.exec(output)?.[1] ?? ''
  return [...line.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '').filter(Boolean)
}

export async function githubStatus(): Promise<GithubStatus> {
  const empty = { login: null, scopes: [], missingScopes: requiredScopes }
  if (!(await which('gh'))) {
    return { installed: false, loggedIn: false, ...empty, error: 'gh is not installed' }
  }
  const status = await run('gh', ['auth', 'status', '--hostname', 'github.com'])
  const output = `${status.stdout}\n${status.stderr}`
  if (status.code !== 0) {
    return { installed: true, loggedIn: false, ...empty, error: null }
  }
  const user = await run('gh', ['api', 'user', '--jq', '.login'])
  const scopes = parseScopes(output)
  return {
    installed: true,
    loggedIn: true,
    login: user.code === 0 ? user.stdout.trim() : null,
    scopes,
    missingScopes: requiredScopes.filter((scope) => !scopes.includes(scope)),
    error: user.code === 0 ? null : user.stderr.trim() || 'Could not read the GitHub user',
  }
}

export type RepoInfo = { owner: string; name: string; sshUrl: string; url: string }

export async function viewRepo(slug: string): Promise<RepoInfo> {
  const result = await run('gh', ['repo', 'view', slug, '--json', 'owner,name,sshUrl,url'])
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Repository ${slug} not found`)
  const data = JSON.parse(result.stdout) as {
    owner: { login: string }
    name: string
    sshUrl: string
    url: string
  }
  return { owner: data.owner.login, name: data.name, sshUrl: data.sshUrl, url: data.url }
}

type ApiRepo = {
  full_name: string
  description: string | null
  private: boolean
  pushed_at: string | null
}

export async function listUserRepos(): Promise<GithubRepoSummary[]> {
  const result = await run('gh', [
    'api',
    'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
  ])
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Could not list your repositories')
  return (JSON.parse(result.stdout) as ApiRepo[]).map((repo) => ({
    fullName: repo.full_name,
    description: repo.description,
    private: repo.private,
    pushedAt: repo.pushed_at,
  }))
}

export async function searchRepos(query: string): Promise<GithubRepoSummary[]> {
  const text = query.trim()
  if (text.length < 2) return []
  const result = await run('gh', [
    'search',
    'repos',
    text,
    '--limit',
    '10',
    '--json',
    'fullName,description,visibility,updatedAt',
  ])
  if (result.code !== 0) return []
  return (
    JSON.parse(result.stdout) as {
      fullName: string
      description: string | null
      visibility: string
      updatedAt: string | null
    }[]
  ).map((repo) => ({
    fullName: repo.fullName,
    description: repo.description || null,
    private: repo.visibility !== 'public',
    pushedAt: repo.updatedAt,
  }))
}
