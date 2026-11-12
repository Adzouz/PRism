import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeDelta, describeDelta, parseRangeDiff } from './delta'

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Octo',
  GIT_AUTHOR_EMAIL: 'octo@example.com',
  GIT_COMMITTER_NAME: 'Octo',
  GIT_COMMITTER_EMAIL: 'octo@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim()

async function commit(dir: string, file: string, content: string, message = `edit ${file}`) {
  await writeFile(join(dir, file), content)
  git(dir, 'add', file)
  git(dir, 'commit', '-qm', message)
  return git(dir, 'rev-parse', 'HEAD')
}

async function repo() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'prism-delta-')))
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env })
  await commit(dir, 'base.txt', 'base\n')
  git(dir, 'checkout', '-qb', 'feature')
  const reviewed = await commit(dir, 'a.txt', 'a1\n', 'add a')
  return { dir, reviewed, reviewedBase: git(dir, 'rev-parse', 'main') }
}

describe('parseRangeDiff', () => {
  it('keeps changed and new commits only', () => {
    const output = [
      '1:  1111111 = 1:  aaaaaaa same commit',
      '2:  2222222 ! 2:  bbbbbbb changed commit',
      '    @@ a.txt',
      '    -old',
      '    +new',
      '3:  3333333 < -:  ------- dropped commit',
      '-:  ------- > 3:  ccccccc new commit',
    ].join('\n')
    expect(parseRangeDiff(output)).toEqual([
      { sha: 'bbbbbbb', subject: 'changed commit' },
      { sha: 'ccccccc', subject: 'new commit' },
    ])
  })
})

describe('computeDelta', () => {
  it('asks for a full review without an earlier review or when the old head is gone', async () => {
    const { dir, reviewed } = await repo()
    const input = { lastHead: null, lastBase: null, head: reviewed, base: 'main' }
    expect(await computeDelta(dir, input)).toEqual({ kind: 'full', reason: 'no earlier review' })
    expect(await computeDelta(dir, { ...input, lastHead: 'f'.repeat(40) })).toMatchObject({
      kind: 'full',
      reason: expect.stringContaining('is gone'),
    })
  })

  it('reports nothing new on the same head', async () => {
    const { dir, reviewed } = await repo()
    expect(
      await computeDelta(dir, { lastHead: reviewed, lastBase: null, head: reviewed, base: 'main' }),
    ).toEqual({ kind: 'none', since: reviewed })
  })

  it('lists new commits and their files, leaving base merges out', async () => {
    const { dir, reviewed, reviewedBase } = await repo()
    git(dir, 'checkout', '-q', 'main')
    await commit(dir, 'upstream.txt', 'up\n', 'upstream work')
    git(dir, 'checkout', '-q', 'feature')
    git(dir, 'merge', '-q', '--no-edit', 'main')
    const mergedOnly = git(dir, 'rev-parse', 'HEAD')
    const input = { lastHead: reviewed, lastBase: reviewedBase, head: mergedOnly, base: 'main' }
    expect(await computeDelta(dir, input)).toEqual({
      kind: 'base-only',
      since: reviewed,
      rebased: false,
    })

    const head = await commit(dir, 'b.txt', 'b\n', 'add b')
    const delta = await computeDelta(dir, { ...input, head })
    expect(delta).toEqual({
      kind: 'commits',
      since: reviewed,
      rebased: false,
      commits: [{ sha: head, subject: 'add b' }],
      files: ['b.txt'],
    })
    expect(describeDelta(delta)).toBe(`Re-review covers 1 commit since ${reviewed.slice(0, 12)}.`)
  })

  it('sees through a rebase that only moved the commits', async () => {
    const { dir, reviewed, reviewedBase } = await repo()
    git(dir, 'checkout', '-q', 'main')
    await commit(dir, 'upstream.txt', 'up\n', 'upstream work')
    git(dir, 'checkout', '-q', 'feature')
    git(dir, 'rebase', '-q', 'main')
    const rebased = git(dir, 'rev-parse', 'HEAD')
    const input = { lastHead: reviewed, lastBase: reviewedBase, head: rebased, base: 'main' }
    expect(await computeDelta(dir, input)).toEqual({
      kind: 'base-only',
      since: reviewed,
      rebased: true,
    })

    await writeFile(join(dir, 'a.txt'), 'a2\n')
    git(dir, 'commit', '-qa', '--amend', '--no-edit')
    const amended = git(dir, 'rev-parse', 'HEAD')
    expect(await computeDelta(dir, { ...input, head: amended })).toMatchObject({
      kind: 'commits',
      rebased: true,
      commits: [{ sha: amended, subject: 'add a' }],
      files: ['a.txt'],
    })
  })
})
