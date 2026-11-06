import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseWorktreeList, prepareWorktree, type PrCheckout } from './worktrees'

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
  return { base, work, origin, clone, head }
}

const pr = (overrides: Partial<PrCheckout> = {}): PrCheckout => ({
  number: 7,
  owner: 'acme',
  name: 'app',
  headRef: 'feature',
  headOid: '',
  baseRef: 'main',
  headRepo: null,
  ...overrides,
})

describe('worktrees', () => {
  it('parses porcelain output', () => {
    const output = 'worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n'
    expect(parseWorktreeList(output)).toEqual([
      { path: '/a', head: '1', branch: 'main' },
      { path: '/b', head: '2', branch: null },
    ])
  })

  it('creates a guarded worktree, then reuses and fast-forwards it', async () => {
    const { base, work, origin, clone, head } = await setup()
    const options = { clone, root: join(base, 'wts'), hooksDir: join(base, 'hooks'), log: () => {} }
    const first = await prepareWorktree(options, pr())
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
    const second = await prepareWorktree(options, pr())
    expect(second).toMatchObject({ path: first.path, created: false, headOid: next })

    await writeFile(join(first.path, 'b.txt'), 'local edit')
    const after = await commit(work, 'd.txt', 'four')
    git(work, 'push', '-q', origin, 'feature')
    const third = await prepareWorktree(options, pr())
    expect(third.headOid).toBe(next)
    expect(third.warning).toContain(after.slice(0, 7))
  })

  it('adds a remote for fork pull requests', async () => {
    const { base, clone, work, head } = await setup()
    const fork = join(base, 'fork.git')
    execFileSync('git', ['clone', '-q', '--bare', work, fork])
    const options = { clone, root: join(base, 'wts'), hooksDir: join(base, 'hooks'), log: () => {} }
    const result = await prepareWorktree(
      options,
      pr({ number: 9, headRepo: { owner: 'octocat', url: fork, sshUrl: fork } }),
    )
    expect(result).toMatchObject({
      remote: 'prism-octocat',
      branch: 'octocat/feature',
      headOid: head,
    })
    expect(git(clone, 'remote', 'get-url', 'prism-octocat')).toBe(fork)
  })

  it('prepares several worktrees of one clone in parallel', async () => {
    const { base, clone, head } = await setup()
    const options = { clone, root: join(base, 'wts'), hooksDir: join(base, 'hooks'), log: () => {} }
    const results = await Promise.all(
      [1, 2, 3].map((number) =>
        prepareWorktree(
          options,
          pr({
            number,
            headRepo: { owner: `fork${number}`, url: join(base, 'origin.git'), sshUrl: '' },
          }),
        ),
      ),
    )
    expect(results.map((result) => result.headOid)).toEqual([head, head, head])
    expect(new Set(results.map((result) => result.path)).size).toBe(3)
  })
})
