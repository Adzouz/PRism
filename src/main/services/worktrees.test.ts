import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pushBlockEnv } from '../agents/guard'
import {
  parseWorktreeList,
  prepareWorktree,
  remoteUrls,
  unblockedPushRemotes,
  type PrCheckout,
} from './worktrees'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Octo',
      GIT_AUTHOR_EMAIL: 'octo@example.com',
      GIT_COMMITTER_NAME: 'Octo',
      GIT_COMMITTER_EMAIL: 'octo@example.com',
    },
  }).trim()

async function commit(dir: string, file: string, content: string) {
  await writeFile(join(dir, file), content)
  git(dir, 'add', file)
  git(dir, 'commit', '-qm', `edit ${file}`)
  return git(dir, 'rev-parse', 'HEAD')
}

async function setup() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'prism-wt-')))
  const work = join(base, 'work')
  execFileSync('git', ['init', '-q', '-b', 'main', work])
  await commit(work, 'a.txt', 'one')
  git(work, 'checkout', '-qb', 'feature')
  const head = await commit(work, 'b.txt', 'two')
  git(work, 'checkout', '-q', 'main')
  const origin = join(base, 'origin.git')
  execFileSync('git', ['clone', '-q', '--bare', work, origin])
  const clone = join(base, 'clone')
  execFileSync('git', ['clone', '-q', origin, clone])
  const options = { clone, root: join(base, 'wts'), hooksDir: join(base, 'hooks'), log: () => {} }
  return { base, work, origin, clone, head, options }
}

const pr = (overrides: Partial<PrCheckout> = {}): PrCheckout => ({
  number: 7,
  owner: 'acme',
  name: 'app',
  headRef: 'feature',
  headOid: '',
  baseRef: 'main',
  crossRepository: false,
  headRepo: null,
  ...overrides,
})

describe('worktrees', () => {
  it('parses porcelain output', () => {
    const output =
      'worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n\nworktree /c\nHEAD 3\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n'
    expect(parseWorktreeList(output)).toEqual([
      { path: '/a', head: '1', branch: 'main', prunable: false },
      { path: '/b', head: '2', branch: null, prunable: false },
      { path: '/c', head: '3', branch: 'x', prunable: true },
    ])
  })

  it('creates a guarded worktree, then reuses and fast-forwards it', async () => {
    const { base, work, origin, head, options } = await setup()
    const first = await prepareWorktree(options, pr({ headOid: head }))
    expect(first).toMatchObject({
      path: join(base, 'wts/pr-7'),
      branch: 'feature',
      created: true,
      headOid: head,
      warning: null,
    })
    expect(git(first.path, 'config', 'core.hooksPath')).toBe(join(base, 'hooks'))

    git(work, 'checkout', '-q', 'feature')
    const next = await commit(work, 'c.txt', 'three')
    git(work, 'push', '-q', origin, 'feature')
    const second = await prepareWorktree(options, pr({ headOid: next }))
    expect(second).toMatchObject({ path: first.path, created: false, headOid: next })

    await writeFile(join(first.path, 'b.txt'), 'local edit')
    const after = await commit(work, 'd.txt', 'four')
    git(work, 'push', '-q', origin, 'feature')
    const third = await prepareWorktree(options, pr({ headOid: after }))
    expect(third.headOid).toBe(next)
    expect(third.warning).toContain(after.slice(0, 7))
  })

  it('follows a force-push when the worktree is clean', async () => {
    const { work, origin, head, options } = await setup()
    const first = await prepareWorktree(options, pr({ headOid: head }))
    git(work, 'checkout', '-q', 'feature')
    git(work, 'reset', '-q', '--hard', 'main')
    const rewritten = await commit(work, 'e.txt', 'rewritten')
    git(work, 'push', '-q', '--force', origin, 'feature')
    const second = await prepareWorktree(options, pr({ headOid: rewritten }))
    expect(second).toMatchObject({ path: first.path, headOid: rewritten, warning: null })
  })

  it('follows a force-push even when the clone fetched in between', async () => {
    const { work, origin, clone, head, options } = await setup()
    const first = await prepareWorktree(options, pr({ headOid: head }))
    git(work, 'checkout', '-q', 'feature')
    git(work, 'reset', '-q', '--hard', 'main')
    const rewritten = await commit(work, 'e.txt', 'rewritten')
    git(work, 'push', '-q', '--force', origin, 'feature')
    git(clone, 'fetch', '-q', 'origin')
    const second = await prepareWorktree(options, pr({ headOid: rewritten }))
    expect(second).toMatchObject({ path: first.path, headOid: rewritten, warning: null })
  })

  it('keeps a commit pushed from the worktree when the branch is force-pushed', async () => {
    const { work, origin, head, options } = await setup()
    const first = await prepareWorktree(options, pr({ headOid: head }))
    const mine = await commit(first.path, 'mine.txt', 'pushed by me')
    git(first.path, 'push', '-q', '--no-verify', 'origin', 'HEAD:feature')
    git(work, 'checkout', '-q', 'feature')
    git(work, 'reset', '-q', '--hard', 'main')
    const rewritten = await commit(work, 'e.txt', 'rewritten')
    git(work, 'push', '-q', '--force', origin, 'feature')
    const second = await prepareWorktree(options, pr({ headOid: rewritten }))
    expect(second.headOid).toBe(mine)
    expect(second.warning).toContain(rewritten.slice(0, 7))
  })

  it('reinstalls the push guard on a reused worktree', async () => {
    const { base, head, options } = await setup()
    const first = await prepareWorktree(options, pr({ headOid: head }))
    git(first.path, 'config', '--worktree', '--unset', 'core.hooksPath')
    await prepareWorktree(options, pr({ headOid: head }))
    expect(git(first.path, 'config', 'core.hooksPath')).toBe(join(base, 'hooks'))
  })

  it('keeps local commits after a force-push', async () => {
    const { work, origin, head, options } = await setup()
    const first = await prepareWorktree(options, pr({ headOid: head }))
    const local = await commit(first.path, 'mine.txt', 'local work')
    git(work, 'checkout', '-q', 'feature')
    git(work, 'reset', '-q', '--hard', 'main')
    const rewritten = await commit(work, 'e.txt', 'rewritten')
    git(work, 'push', '-q', '--force', origin, 'feature')
    const second = await prepareWorktree(options, pr({ headOid: rewritten }))
    expect(second.headOid).toBe(local)
    expect(second.warning).toContain(rewritten.slice(0, 7))
  })

  it('checks out pull/<n>/head for a pull request from a deleted fork', async () => {
    const { work, origin, options } = await setup()
    git(work, 'checkout', '-qb', 'fork-main', 'main')
    const forkHead = await commit(work, 'fork.txt', 'from a fork')
    git(work, 'push', '-q', origin, 'fork-main:refs/pull/9/head')
    const result = await prepareWorktree(
      options,
      pr({ number: 9, headRef: 'main', headOid: forkHead, crossRepository: true }),
    )
    expect(result).toMatchObject({ branch: null, headOid: forkHead, warning: null })
    expect(git(result.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
  })

  it('uses pull/<n>/head when the branch is not the pull request head', async () => {
    const { work, origin, options } = await setup()
    git(work, 'checkout', '-qb', 'pr-head', 'main')
    const prHead = await commit(work, 'pr.txt', 'the real head')
    git(work, 'push', '-q', origin, 'pr-head:refs/pull/7/head')
    const result = await prepareWorktree(options, pr({ headOid: prHead }))
    expect(result.headOid).toBe(prHead)
  })

  it('recreates a worktree whose folder was deleted by hand', async () => {
    const { head, options } = await setup()
    const first = await prepareWorktree(options, pr({ headOid: head }))
    await rm(first.path, { recursive: true, force: true })
    const second = await prepareWorktree(options, pr({ headOid: head }))
    expect(second).toMatchObject({ path: first.path, created: true, headOid: head })
  })

  it('reuses worktrees under a symlinked root', async () => {
    const { base, head, options } = await setup()
    await mkdir(join(base, 'real-wts'))
    await symlink(join(base, 'real-wts'), join(base, 'linked-wts'))
    const linked = { ...options, root: join(base, 'linked-wts') }
    git(options.clone, 'checkout', '-q', 'feature')
    const first = await prepareWorktree(linked, pr({ headOid: head }))
    const second = await prepareWorktree(linked, pr({ headOid: head }))
    expect(first.created).toBe(true)
    expect(second).toMatchObject({ path: first.path, created: false })
  })

  it('lists remotes whose pushes the push block cannot cover', async () => {
    const { origin, clone } = await setup()
    expect(await remoteUrls(clone)).toEqual([origin])
    const env = pushBlockEnv({}, await remoteUrls(clone))
    expect(await unblockedPushRemotes(clone, env)).toEqual([])
    git(clone, 'config', 'remote.origin.pushurl', origin)
    expect(await unblockedPushRemotes(clone, env)).toEqual([{ remote: 'origin', url: origin }])
  })

  it('adds a remote for fork pull requests', async () => {
    const { base, clone, work, head, options } = await setup()
    const fork = join(base, 'fork.git')
    execFileSync('git', ['clone', '-q', '--bare', work, fork])
    const result = await prepareWorktree(
      options,
      pr({
        number: 9,
        headOid: head,
        crossRepository: true,
        headRepo: { owner: 'octocat', url: fork, sshUrl: fork },
      }),
    )
    expect(result).toMatchObject({
      remote: 'prism-octocat',
      branch: 'octocat/feature',
      headOid: head,
    })
    expect(git(clone, 'remote', 'get-url', 'prism-octocat')).toBe(fork)
  })

  it('prepares several worktrees of one clone in parallel', async () => {
    const { base, head, options } = await setup()
    const results = await Promise.all(
      [1, 2, 3].map((number) =>
        prepareWorktree(
          options,
          pr({
            number,
            headOid: head,
            crossRepository: true,
            headRepo: { owner: `fork${number}`, url: join(base, 'origin.git'), sshUrl: '' },
          }),
        ),
      ),
    )
    expect(results.map((result) => result.headOid)).toEqual([head, head, head])
    expect(new Set(results.map((result) => result.path)).size).toBe(3)
  })
})
