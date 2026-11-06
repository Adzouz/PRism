import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prePushHookScript } from '../agents/guard'
import { run } from '../system/exec'
import { exists, normalizeRemote } from './git'

export type PrCheckout = {
  number: number
  owner: string
  name: string
  headRef: string
  headOid: string
  baseRef: string
  headRepo: { owner: string; sshUrl: string; url: string } | null
}

export type Worktree = {
  path: string
  branch: string
  remote: string
  baseRemote: string
  created: boolean
  headOid: string
  warning: string | null
}

type Log = (message: string) => void

async function git(cwd: string, args: string[], timeout = 120_000) {
  const result = await run('git', ['-C', cwd, ...args], { timeout })
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trim()
}

async function tryGit(cwd: string, args: string[]) {
  const result = await run('git', ['-C', cwd, ...args], { timeout: 60_000 })
  return result.code === 0 ? result.stdout.trim() : null
}

export type WorktreeEntry = { path: string; head: string | null; branch: string | null }

export function parseWorktreeList(output: string): WorktreeEntry[] {
  return output
    .split('\n\n')
    .map((block) => {
      const lines = block.split('\n')
      const value = (key: string) =>
        lines.find((line) => line.startsWith(`${key} `))?.slice(key.length + 1) ?? null
      return {
        path: value('worktree') ?? '',
        head: value('HEAD'),
        branch: value('branch')?.replace(/^refs\/heads\//, '') ?? null,
      }
    })
    .filter((entry) => entry.path)
}

async function listRemotes(clone: string) {
  const output = (await tryGit(clone, ['remote', '-v'])) ?? ''
  const remotes = new Map<string, string>()
  for (const line of output.split('\n')) {
    const [name, url] = line.split(/\s+/)
    if (name && url) remotes.set(name, url)
  }
  return remotes
}

async function baseRemote(clone: string, pr: PrCheckout) {
  const target = normalizeRemote(`github.com/${pr.owner}/${pr.name}`)
  const remotes = await listRemotes(clone)
  for (const [name, url] of remotes) if (normalizeRemote(url) === target) return { name, url }
  const origin = remotes.get('origin')
  if (origin) return { name: 'origin', url: origin }
  throw new Error(`${clone} has no remote for ${pr.owner}/${pr.name}`)
}

async function headRemote(clone: string, pr: PrCheckout, base: { name: string; url: string }) {
  const fork = pr.headRepo
  if (!fork || fork.owner.toLowerCase() === pr.owner.toLowerCase()) return base.name
  const remotes = await listRemotes(clone)
  const target = normalizeRemote(fork.url)
  for (const [name, url] of remotes) if (normalizeRemote(url) === target) return name
  const name = `prism-${fork.owner.toLowerCase()}`
  const url = /^(git@|ssh:)/.test(base.url) ? fork.sshUrl : fork.url
  await git(clone, ['remote', 'add', name, url])
  return name
}

export function localBranchName(pr: PrCheckout) {
  const fork = pr.headRepo && pr.headRepo.owner.toLowerCase() !== pr.owner.toLowerCase()
  return fork ? `${pr.headRepo!.owner}/${pr.headRef}` : pr.headRef
}

async function installGuard(clone: string, path: string, hooksDir: string) {
  await mkdir(hooksDir, { recursive: true })
  const hook = join(hooksDir, 'pre-push')
  await writeFile(hook, prePushHookScript(join(hooksDir, '.push-nonce')))
  await chmod(hook, 0o755)
  await git(clone, ['config', 'extensions.worktreeConfig', 'true'])
  await git(path, ['config', '--worktree', 'core.hooksPath', hooksDir])
}

const cloneLocks = new Map<string, Promise<unknown>>()

export function prepareWorktree(
  options: { clone: string; root: string; hooksDir: string; log: Log },
  pr: PrCheckout,
): Promise<Worktree> {
  const previous = cloneLocks.get(options.clone) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(() => prepareLocked(options, pr))
  cloneLocks.set(options.clone, next)
  void next
    .finally(() => {
      if (cloneLocks.get(options.clone) === next) cloneLocks.delete(options.clone)
    })
    .catch(() => {})
  return next
}

async function prepareLocked(
  options: { clone: string; root: string; hooksDir: string; log: Log },
  pr: PrCheckout,
): Promise<Worktree> {
  const { clone, root, log } = options
  const base = await baseRemote(clone, pr)
  const remote = await headRemote(clone, pr, base)
  log(`Fetching ${remote}/${pr.headRef} and ${base.name}/${pr.baseRef}`)
  await git(clone, ['fetch', base.name, pr.baseRef])
  const remoteRef = `refs/remotes/${remote}/${pr.headRef}`
  const fetched = await tryGit(clone, ['fetch', remote, `+${pr.headRef}:${remoteRef}`])
  const startRef =
    fetched !== null
      ? remoteRef
      : (await git(clone, [
          'fetch',
          base.name,
          `+pull/${pr.number}/head:refs/prism/pr-${pr.number}`,
        ]),
        `refs/prism/pr-${pr.number}`)

  const branch = localBranchName(pr)
  const [main, ...entries] = parseWorktreeList(
    await git(clone, ['worktree', 'list', '--porcelain']),
  )
  const target = join(root, `pr-${pr.number}`)
  const existing =
    entries.find((entry) => entry.branch === branch) ??
    entries.find((entry) => entry.path === target)

  let path: string
  let created = false
  if (existing) {
    path = existing.path
    log(`Reusing worktree ${path}`)
  } else {
    if (await exists(target)) throw new Error(`${target} exists but is not a worktree of ${clone}`)
    await mkdir(root, { recursive: true })
    const hasBranch =
      (await tryGit(clone, ['rev-parse', '--verify', `refs/heads/${branch}`])) !== null
    const busy = main?.branch === branch
    const args = busy
      ? ['worktree', 'add', '--detach', target, startRef]
      : hasBranch
        ? ['worktree', 'add', target, branch]
        : ['worktree', 'add', '-b', branch, target, startRef]
    await git(clone, args)
    if (busy) log(`${branch} is checked out in ${clone}; using a detached worktree`)
    if (!hasBranch && !busy && fetched !== null) {
      await tryGit(target, ['branch', `--set-upstream-to=${remote}/${pr.headRef}`])
    }
    path = target
    created = true
    log(`Created worktree ${path} on ${branch}`)
    await installGuard(clone, path, options.hooksDir)
  }

  const head = await git(path, ['rev-parse', 'HEAD'])
  const wanted = await git(clone, ['rev-parse', startRef])
  let warning: string | null = null
  if (head !== wanted) {
    const clean = (await git(path, ['status', '--porcelain'])) === ''
    const behind = (await tryGit(path, ['merge-base', '--is-ancestor', head, wanted])) !== null
    if (clean && behind) {
      await git(path, ['merge', '--ff-only', wanted])
      log(`Fast-forwarded to ${wanted.slice(0, 7)}`)
    } else {
      warning = `Worktree is at ${head.slice(0, 7)}, the pull request head is ${wanted.slice(0, 7)}${clean ? '' : ' (local changes kept)'}`
      log(warning)
    }
  }
  return {
    path,
    branch,
    remote,
    baseRemote: base.name,
    created,
    headOid: await git(path, ['rev-parse', 'HEAD']),
    warning,
  }
}
