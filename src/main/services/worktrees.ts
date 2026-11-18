import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises'
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
  crossRepository: boolean
  headRepo: { owner: string; sshUrl: string; url: string } | null
}

export type Worktree = {
  path: string
  branch: string | null
  remote: string
  baseRemote: string
  created: boolean
  headOid: string
  current: boolean
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

export type WorktreeEntry = {
  path: string
  head: string | null
  branch: string | null
  prunable: boolean
}

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
        prunable: lines.some((line) => line === 'prunable' || line.startsWith('prunable ')),
      }
    })
    .filter((entry) => entry.path)
}

export async function remoteUrls(clone: string) {
  const output =
    (await tryGit(clone, ['config', '-z', '--get-regexp', '^remote\\..*\\.(url|pushurl)$'])) ?? ''
  const urls = output
    .split('\0')
    .filter((entry) => entry.includes('\n'))
    .map((entry) => entry.slice(entry.indexOf('\n') + 1))
  return [...new Set(urls.filter(Boolean))]
}

export async function unblockedPushRemotes(clone: string, env: Record<string, string>) {
  const names = ((await tryGit(clone, ['remote'])) ?? '').split('\n').filter(Boolean)
  const unblocked: { remote: string; url: string }[] = []
  for (const remote of names) {
    const result = await run('git', ['-C', clone, 'remote', 'get-url', '--push', '--all', remote], {
      env,
      timeout: 60_000,
    })
    for (const url of result.stdout.split('\n').filter(Boolean)) {
      if (!url.startsWith('prism-push-blocked:')) unblocked.push({ remote, url })
    }
  }
  return unblocked
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
  if (pr.crossRepository && !pr.headRepo) return null
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

function withCloneLock<T>(clone: string, task: () => Promise<T>): Promise<T> {
  const previous = cloneLocks.get(clone) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  cloneLocks.set(clone, next)
  void next
    .finally(() => {
      if (cloneLocks.get(clone) === next) cloneLocks.delete(clone)
    })
    .catch(() => {})
  return next
}

export function prepareWorktree(
  options: { clone: string; root: string; hooksDir: string; log: Log },
  pr: PrCheckout,
): Promise<Worktree> {
  return withCloneLock(options.clone, () => prepareLocked(options, pr))
}

export type WorktreeRemoval =
  | { status: 'missing' }
  | { status: 'removed'; path: string }
  | { status: 'kept'; path: string; reason: string }

export function removePrWorktree(
  options: { clone: string; root: string },
  pr: { number: number; headOid: string },
): Promise<WorktreeRemoval> {
  return withCloneLock(options.clone, () => removeLocked(options, pr))
}

async function onGithub(cwd: string, rev: string, prHead: string) {
  const unpublished = await tryGit(cwd, [
    'rev-list',
    '--count',
    rev,
    '--not',
    '--remotes',
    '--exclude=refs/prism/*-unpushed',
    '--glob=refs/prism/*',
  ])
  if (unpublished === '0') return true
  return prHead !== '' && (await tryGit(cwd, ['merge-base', '--is-ancestor', rev, prHead])) !== null
}

async function removeLocked(
  { clone, root }: { clone: string; root: string },
  pr: { number: number; headOid: string },
): Promise<WorktreeRemoval> {
  const folder = join(root, `pr-${pr.number}`)
  if (!(await exists(folder))) return { status: 'missing' }
  const real = await realpath(folder)
  const [, ...entries] = parseWorktreeList(await git(clone, ['worktree', 'list', '--porcelain']))
  const entry = entries.find((item) => item.path === real || item.path === folder)
  if (!entry) return { status: 'kept', path: folder, reason: `not a worktree of ${clone}` }
  const changes = await tryGit(entry.path, ['status', '--porcelain'])
  if (changes !== '') {
    const reason = changes === null ? 'could not read its status' : 'uncommitted changes'
    return { status: 'kept', path: entry.path, reason }
  }
  if (!(await onGithub(entry.path, 'HEAD', pr.headOid))) {
    return { status: 'kept', path: entry.path, reason: 'commits that are not on GitHub' }
  }
  await git(clone, ['worktree', 'remove', entry.path])
  const backup = `refs/prism/pr-${pr.number}-unpushed`
  const refs = [`refs/prism/pr-${pr.number}`, `refs/prism/pr-${pr.number}-checkout`]
  const kept = await tryGit(clone, ['rev-parse', '--verify', `${backup}^{commit}`])
  if (kept === null || (await onGithub(clone, backup, pr.headOid))) refs.push(backup)
  for (const ref of refs) await tryGit(clone, ['update-ref', '-d', ref])
  return { status: 'removed', path: entry.path }
}

async function unpushedHead(
  clone: string,
  root: string,
  number: number,
  previous: string,
  remoteRef: string,
) {
  const folder = await realpath(join(root, `pr-${number}`)).catch(() => null)
  if (!folder) return null
  const [, ...entries] = parseWorktreeList(await git(clone, ['worktree', 'list', '--porcelain']))
  const head = entries.find((entry) => entry.path === folder && !entry.prunable)?.head
  if (!head || head === previous) return null
  if ((await tryGit(clone, ['merge-base', '--is-ancestor', previous, head])) === null) return null
  const range = `${previous}..${head}`
  const total = await tryGit(clone, ['rev-list', '--count', range])
  const tips = ((await tryGit(clone, ['reflog', 'show', '--format=%H', remoteRef])) ?? '')
    .split('\n')
    .filter(Boolean)
  const local = await tryGit(clone, ['rev-list', '--count', range, '--not', '--remotes', ...tips])
  return total !== null && total === local ? head : null
}

async function prepareLocked(
  options: { clone: string; root: string; hooksDir: string; log: Log },
  pr: PrCheckout,
): Promise<Worktree> {
  const { clone, root, log } = options
  const base = await baseRemote(clone, pr)
  const branch = localBranchName(pr)
  const remote = branch === null ? base.name : await headRemote(clone, pr, base)
  const pullRef = `refs/prism/pr-${pr.number}`
  const checkoutRef = `refs/prism/pr-${pr.number}-checkout`
  const branchRef = `refs/remotes/${remote}/${pr.headRef}`
  const fetchPull = () => tryGit(clone, ['fetch', base.name, `+pull/${pr.number}/head:${pullRef}`])
  const oidOf = (ref: string) => tryGit(clone, ['rev-parse', '--verify', `${ref}^{commit}`])

  const previous = await oidOf(checkoutRef)
  const unpushed = previous
    ? await unpushedHead(clone, root, pr.number, previous, branch === null ? pullRef : branchRef)
    : null
  await git(clone, ['fetch', base.name, pr.baseRef])
  let startRef: string
  if (branch === null) {
    log(`Fetching pull/${pr.number}/head and ${base.name}/${pr.baseRef}`)
    if ((await fetchPull()) === null) {
      throw new Error(`Could not fetch pull/${pr.number}/head from ${base.name}`)
    }
    startRef = pullRef
  } else {
    log(`Fetching ${remote}/${pr.headRef} and ${base.name}/${pr.baseRef}`)
    const fetched = await tryGit(clone, ['fetch', remote, `+${pr.headRef}:${branchRef}`])
    startRef = fetched !== null ? branchRef : pullRef
    if (fetched === null && (await fetchPull()) === null) {
      throw new Error(`Could not fetch ${pr.headRef} or pull/${pr.number}/head`)
    }
    if (startRef === branchRef && pr.headOid && (await oidOf(branchRef)) !== pr.headOid) {
      if ((await fetchPull()) !== null && (await oidOf(pullRef)) === pr.headOid) {
        log(`${remote}/${pr.headRef} is not the pull request head; using pull/${pr.number}/head`)
        startRef = pullRef
      }
    }
  }

  const [main, ...all] = parseWorktreeList(await git(clone, ['worktree', 'list', '--porcelain']))
  const entries = all.filter((entry) => !entry.prunable)
  await mkdir(root, { recursive: true })
  const realRoot = await realpath(root)
  const target = join(realRoot, `pr-${pr.number}`)
  const targets = new Set([target, join(root, `pr-${pr.number}`)])
  const matches = (entry: WorktreeEntry) =>
    (branch !== null && entry.branch === branch) || targets.has(entry.path)
  const existing =
    (branch === null ? undefined : entries.find((entry) => entry.branch === branch)) ??
    entries.find((entry) => targets.has(entry.path))

  let path: string
  let created = false
  if (existing) {
    path = existing.path
    log(`Reusing worktree ${path}`)
    if ((await realpath(path).catch(() => path)) === target) {
      await installGuard(clone, path, options.hooksDir)
    }
  } else {
    if (await exists(target)) throw new Error(`${target} exists but is not a worktree of ${clone}`)
    const local =
      branch === null
        ? null
        : await tryGit(clone, ['rev-parse', '--verify', `refs/heads/${branch}`])
    const hasBranch = local !== null
    const offHead =
      local !== null &&
      (await tryGit(clone, ['merge-base', '--is-ancestor', local, `${startRef}^{commit}`])) === null
    if (offHead) {
      log(
        `Local ${branch} (${local.slice(0, 7)}) is not part of the pull request head; using a detached worktree and leaving the branch as is`,
      )
    }
    const detached = branch === null || main?.branch === branch || offHead
    const force = all.some((entry) => entry.prunable && matches(entry)) ? ['-f'] : []
    const args =
      detached || branch === null
        ? ['worktree', 'add', ...force, '--detach', target, startRef]
        : hasBranch
          ? ['worktree', 'add', ...force, target, branch]
          : ['worktree', 'add', ...force, '-b', branch, target, startRef]
    await git(clone, args)
    await installGuard(clone, target, options.hooksDir)
    if (branch !== null && detached && !offHead) {
      log(`${branch} is checked out in ${clone}; using a detached worktree`)
    }
    if (branch !== null && !hasBranch && !detached && startRef === branchRef) {
      await tryGit(target, ['branch', `--set-upstream-to=${remote}/${pr.headRef}`])
    }
    path = target
    created = true
    log(`Created worktree ${path}${branch === null || detached ? ' (detached)' : ` on ${branch}`}`)
  }

  const head = await git(path, ['rev-parse', 'HEAD'])
  const wanted = await git(clone, ['rev-parse', `${startRef}^{commit}`])
  let warning: string | null = null
  if (head !== wanted) {
    const clean = (await git(path, ['status', '--porcelain'])) === ''
    const behind = (await tryGit(path, ['merge-base', '--is-ancestor', head, wanted])) !== null
    if (clean && behind) {
      await git(path, ['merge', '--ff-only', wanted])
      log(`Fast-forwarded to ${wanted.slice(0, 7)}`)
    } else if (clean && previous !== null && head === previous) {
      await git(path, ['reset', '--hard', wanted])
      log(`The pull request was force-pushed; moved to ${wanted.slice(0, 7)}`)
    } else if (
      clean &&
      previous !== null &&
      head === unpushed &&
      (await tryGit(path, ['merge-base', '--is-ancestor', wanted, head])) === null
    ) {
      warning = await moveUnpushed(clone, path, pr.number, previous, head, wanted, log)
    } else {
      warning = `Worktree is at ${head.slice(0, 7)}, the pull request head is ${wanted.slice(0, 7)}${clean ? '' : ' (local changes kept)'}`
      log(warning)
    }
  }
  const headOid = await git(path, ['rev-parse', 'HEAD'])
  const current =
    headOid === wanted ||
    (await tryGit(path, ['merge-base', '--is-ancestor', wanted, headOid])) !== null
  if (current) await git(clone, ['update-ref', checkoutRef, wanted])
  return { path, branch, remote, baseRemote: base.name, created, headOid, current, warning }
}

async function moveUnpushed(
  clone: string,
  path: string,
  number: number,
  previous: string,
  head: string,
  wanted: string,
  log: Log,
) {
  await git(clone, ['update-ref', `refs/prism/pr-${number}-unpushed`, head])
  const rebased = await tryGit(path, ['rebase', '--onto', wanted, previous])
  if (rebased !== null) {
    log(
      `The pull request moved to ${wanted.slice(0, 7)}; moved the unpushed commits on top of it (they were at ${head.slice(0, 7)})`,
    )
    return null
  }
  await tryGit(path, ['rebase', '--abort'])
  const warning = `The pull request moved to ${wanted.slice(0, 7)} and the unpushed commits of this worktree (${head.slice(0, 7)}) do not apply on it. Rebase them in ${path}, or remove the worktree to start from the pull request head.`
  log(warning)
  return warning
}
