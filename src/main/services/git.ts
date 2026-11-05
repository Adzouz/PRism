import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { run } from '../system/exec'

export function normalizeRemote(url: string) {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
}

export function isRemoteUrl(value: string) {
  return /^(https?:\/\/|ssh:\/\/|git@|[\w.-]+@[\w.-]+:)/i.test(value.trim())
}

export function githubUrl(slugOrUrl: string) {
  return isRemoteUrl(slugOrUrl) ? slugOrUrl.trim() : `https://github.com/${slugOrUrl.trim()}`
}

export async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  )
}

export async function isGitRepo(dir: string) {
  return exists(join(dir, '.git'))
}

export async function remotes(dir: string) {
  const result = await run('git', ['-C', dir, 'remote', '-v'], { timeout: 10_000 })
  if (result.code !== 0) return []
  return [
    ...new Set(
      result.stdout
        .split('\n')
        .map((line) => line.split(/\s+/)[1])
        .filter((url): url is string => Boolean(url))
        .map(normalizeRemote),
    ),
  ]
}

export async function hasRemote(dir: string, url: string) {
  const target = normalizeRemote(url)
  return (await remotes(dir)).includes(target)
}

const searchRoots = [
  'code',
  'src',
  'dev',
  'Developer',
  'Projects',
  'projects',
  'Sites',
  'github',
  'GitHub',
  'workspace',
  'repos',
  'git',
  'Documents/GitHub',
]

const skipDirs = new Set(['node_modules', 'Library', 'Applications', 'dist', 'build', 'out'])

export async function findClones(url: string, options: { maxDepth?: number; limit?: number } = {}) {
  const target = normalizeRemote(url)
  const home = homedir()
  const maxDepth = options.maxDepth ?? 4
  let budget = options.limit ?? 4000
  const found: string[] = []
  const queue: { dir: string; depth: number }[] = []
  for (const root of searchRoots) {
    const dir = join(home, root)
    if (await exists(dir)) queue.push({ dir, depth: 0 })
  }
  const seen = new Set<string>()
  while (queue.length > 0 && budget > 0) {
    const { dir, depth } = queue.shift()!
    if (seen.has(dir)) continue
    seen.add(dir)
    budget -= 1
    if (await isGitRepo(dir)) {
      if ((await remotes(dir)).includes(target)) found.push(dir)
      continue
    }
    if (depth >= maxDepth) continue
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || skipDirs.has(entry.name)) continue
      queue.push({ dir: join(dir, entry.name), depth: depth + 1 })
    }
  }
  return found
}

export async function cloneRepo(url: string, dest: string) {
  const result = await run('git', ['clone', url, dest], { timeout: 15 * 60_000 })
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git clone failed (${result.code})`)
}

export async function pull(dir: string) {
  const result = await run('git', ['-C', dir, 'pull', '--ff-only'], { timeout: 5 * 60_000 })
  return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() }
}
