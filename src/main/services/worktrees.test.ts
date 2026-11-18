import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pushBlockEnv } from '../agents/guard'
import {
  parseWorktreeList,
  prepareWorktree,
  remoteUrls,
  removePrWorktree,
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

  it('checks out the pull request head when the local branch was left behind by a force-push', async () => {
    const { base, work, origin, clone, options } = await setup()
    git(clone, 'branch', '-q', 'feature', 'origin/feature')
    const stale = git(clone, 'rev-parse', 'feature')
    git(work, 'checkout', '-q', 'feature')
    git(work, 'reset', '-q', '--hard', 'main')
    const rewritten = await commit(work, 'e.txt', 'rewritten')
    git(work, 'push', '-q', '--force', origin, 'feature')
    const logs: string[] = []
    const result = await prepareWorktree(
      { ...options, log: (line) => logs.push(line) },
      pr({ headOid: rewritten }),
    )
    expect(result).toMatchObject({
      path: join(base, 'wts/pr-7'),
      created: true,
      headOid: rewritten,
      warning: null,
    })
    expect(git(result.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    expect(git(clone, 'rev-parse', 'feature')).toBe(stale)
    expect(logs.join('\n')).toContain('not part of the pull request head')
  })

  it('checks out a local branch that is behind the pull request head and fast-forwards it', async () => {
    const { work, origin, clone, options } = await setup()
    git(clone, 'branch', '-q', 'feature', 'origin/feature')
    git(work, 'checkout', '-q', 'feature')
    const next = await commit(work, 'c.txt', 'three')
    git(work, 'push', '-q', origin, 'feature')
    const result = await prepareWorktree(options, pr({ headOid: next }))
    expect(result).toMatchObject({ created: true, headOid: next, warning: null })
    expect(git(result.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature')
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
    const third = await prepareWorktree(options, pr({ headOid: rewritten }))
    expect(third.headOid).toBe(mine)
  })

  it('moves unpushed commits onto a force-pushed head', async () => {
    const { work, origin, clone, head, options } = await setup()
    const first = await prepareWorktree(options, pr({ headOid: head }))
    const mine = await commit(first.path, 'mine.txt', 'not pushed')
    git(work, 'checkout', '-q', 'feature')
    git(work, 'reset', '-q', '--hard', 'main')
    const rewritten = await commit(work, 'e.txt', 'rewritten')
    git(work, 'push', '-q', '--force', origin, 'feature')
    const second = await prepareWorktree(options, pr({ headOid: rewritten }))
    expect(second).toMatchObject({ path: first.path, current: true, warning: null })
    expect(git(second.path, 'rev-parse', 'HEAD~1')).toBe(rewritten)
    expect(git(second.path, 'log', '-1', '--format=%s')).toBe('edit mine.txt')
    expect(git(clone, 'rev-parse', 'refs/prism/pr-7-unpushed')).toBe(mine)
    expect(git(clone, 'rev-parse', 'refs/prism/pr-7-checkout')).toBe(rewritten)
  })

  it('keeps unpushed commits that do not apply on a force-pushed head', async () => {
    const { work, origin, head, options } = await setup()
    const first = await prepareWorktree(options, pr({ headOid: head }))
    const mine = await commit(first.path, 'b.txt', 'mine')
    git(work, 'checkout', '-q', 'feature')
    git(work, 'reset', '-q', '--hard', 'main')
    const rewritten = await commit(work, 'b.txt', 'theirs')
    git(work, 'push', '-q', '--force', origin, 'feature')
    const second = await prepareWorktree(options, pr({ headOid: rewritten }))
    expect(second).toMatchObject({ headOid: mine, current: false })
    expect(second.warning).toContain('do not apply')
    expect(git(second.path, 'status', '--porcelain')).toBe('')
  })

  it('reinstalls the push guard on a reused worktree', async () => {
    const { base, head, options } = await setup()
    const first = await prepareWorktree(options, pr({ headOid: head }))
    git(first.path, 'config', '--worktree', '--unset', 'core.hooksPath')
    await prepareWorktree(options, pr({ headOid: head }))
    expect(git(first.path, 'config', 'core.hooksPath')).toBe(join(base, 'hooks'))
  })

  it("leaves the user's own worktree under the root unguarded", async () => {
    const { base, clone, head, options } = await setup()
    const own = join(base, 'wts', 'feature-dev')
    git(clone, 'worktree', 'add', '-q', own, 'feature')
    const result = await prepareWorktree(options, pr({ headOid: head }))
    expect(result).toMatchObject({ path: own, created: false })
    expect(git(own, 'config', '--default', '', 'core.hooksPath')).toBe('')
  })

  it('keeps an unpushed commit on later runs', async () => {
    const { head, options } = await setup()
    const first = await prepareWorktree(options, pr({ headOid: head }))
    const local = await commit(first.path, 'mine.txt', 'local work')
    await prepareWorktree(options, pr({ headOid: head }))
    const third = await prepareWorktree(options, pr({ headOid: head }))
    expect(third.headOid).toBe(local)
    expect(third.warning).toContain(head.slice(0, 7))
    expect(git(first.path, 'rev-parse', 'feature')).toBe(local)
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

  it('blocks the configured url when insteadOf rewrites it', async () => {
    const { base, clone } = await setup()
    const url = 'https://github.com/acme/app.git'
    git(clone, 'remote', 'set-url', 'origin', url)
    const globalConfig = join(base, 'gitconfig')
    await writeFile(
      globalConfig,
      '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[url "git@github-work:acme/"]\n\tpushInsteadOf = https://github.com/acme/\n',
    )
    const saved = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    try {
      expect(await remoteUrls(clone)).toEqual([url])
      const env = pushBlockEnv({}, await remoteUrls(clone))
      expect(await unblockedPushRemotes(clone, env)).toEqual([])
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = saved
    }
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

describe('removePrWorktree', () => {
  it('removes a clean worktree with its ignored files and PRism refs, and keeps the branch', async () => {
    const { base, clone, head, options } = await setup()
    const worktree = await prepareWorktree(options, pr({ headOid: head }))
    await writeFile(join(clone, '.git/info/exclude'), 'node_modules/\n')
    await mkdir(join(worktree.path, 'node_modules/pkg'), { recursive: true })
    await writeFile(join(worktree.path, 'node_modules/pkg/index.js'), 'module.exports = 1')
    expect(git(clone, 'for-each-ref', 'refs/prism')).not.toBe('')

    const removed = await removePrWorktree(options, { number: 7, headOid: head })

    expect(removed).toEqual({ status: 'removed', path: join(base, 'wts/pr-7') })
    expect(existsSync(worktree.path)).toBe(false)
    expect(git(clone, 'worktree', 'list')).not.toContain('pr-7')
    expect(git(clone, 'for-each-ref', 'refs/prism')).toBe('')
    expect(git(clone, 'rev-parse', 'feature')).toBe(head)
    expect(await removePrWorktree(options, { number: 7, headOid: head })).toEqual({
      status: 'missing',
    })
  })

  it('keeps a worktree with changes or commits that are not on GitHub', async () => {
    const { head, options } = await setup()
    const worktree = await prepareWorktree(options, pr({ headOid: head }))
    const closed = { number: 7, headOid: head }

    await writeFile(join(worktree.path, 'a.txt'), 'changed')
    expect(await removePrWorktree(options, closed)).toEqual({
      status: 'kept',
      path: worktree.path,
      reason: 'uncommitted changes',
    })
    git(worktree.path, 'checkout', '--', 'a.txt')
    await writeFile(join(worktree.path, 'notes.txt'), 'new file')
    expect(await removePrWorktree(options, closed)).toMatchObject({ reason: 'uncommitted changes' })
    const local = await commit(worktree.path, 'notes.txt', 'new file')
    expect(await removePrWorktree(options, closed)).toMatchObject({
      status: 'kept',
      reason: 'commits that are not on GitHub',
    })
    expect(existsSync(worktree.path)).toBe(true)

    expect(await removePrWorktree(options, { number: 7, headOid: local })).toMatchObject({
      status: 'removed',
    })
  })

  it('leaves a folder that is not a worktree of the clone', async () => {
    const { options } = await setup()
    const folder = join(options.root, 'pr-9')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'keep.txt'), 'mine')
    expect(await removePrWorktree(options, { number: 9, headOid: '' })).toMatchObject({
      status: 'kept',
      path: folder,
    })
    expect(existsSync(join(folder, 'keep.txt'))).toBe(true)
  })

  it('removes a worktree created under a symlinked root', async () => {
    const { base, head, options } = await setup()
    await mkdir(options.root, { recursive: true })
    const link = join(base, 'link')
    await symlink(options.root, link)
    const linked = { ...options, root: link }
    const worktree = await prepareWorktree(linked, pr({ headOid: head }))
    expect(await removePrWorktree(linked, { number: 7, headOid: head })).toEqual({
      status: 'removed',
      path: worktree.path,
    })
  })
})
