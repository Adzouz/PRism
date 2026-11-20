import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergeState, startBaseMerge } from './merge'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim()

async function commit(cwd: string, file: string, content: string, message: string) {
  await writeFile(join(cwd, file), content)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', message)
}

async function repo() {
  const cwd = await mkdtemp(join(tmpdir(), 'prism-merge-'))
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'config', 'user.email', 'dev@example.com')
  git(cwd, 'config', 'user.name', 'Dev')
  git(cwd, 'config', 'commit.gpgsign', 'false')
  await commit(cwd, 'a.txt', 'one\ntwo\nthree\n', 'init')
  git(cwd, 'checkout', '-q', '-b', 'feature')
  await commit(cwd, 'a.txt', 'one\nfeature\nthree\n', 'feature')
  git(cwd, 'checkout', '-q', 'main')
  return cwd
}

async function conflicting() {
  const cwd = await repo()
  await commit(cwd, 'a.txt', 'one\nmain\nthree\n', 'main')
  git(cwd, 'checkout', '-q', 'feature')
  return cwd
}

describe('startBaseMerge', () => {
  it('merges the base without committing and lists the conflicted files', async () => {
    const cwd = await conflicting()
    const head = git(cwd, 'rev-parse', 'HEAD')
    const merge = await startBaseMerge(cwd, 'main')
    expect(merge).toEqual({
      base: 'main',
      baseOid: git(cwd, 'rev-parse', 'main'),
      conflicts: ['a.txt'],
      resumed: false,
    })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(cwd, 'rev-parse', 'MERGE_HEAD')).toBe(merge.baseOid)
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toContain('|||||||')
    expect(await mergeState(cwd)).toMatchObject({ merging: true, unmerged: ['a.txt'] })
  })

  it('continues a merge of the same base already in progress', async () => {
    const cwd = await conflicting()
    await startBaseMerge(cwd, 'main')
    const again = await startBaseMerge(cwd, 'main')
    expect(again).toMatchObject({ conflicts: ['a.txt'], resumed: true })
  })

  it('refuses when another merge is in progress', async () => {
    const cwd = await conflicting()
    git(cwd, 'branch', 'other', 'main')
    git(cwd, 'checkout', '-q', 'main')
    await commit(cwd, 'b.txt', 'b\n', 'more on main')
    git(cwd, 'checkout', '-q', 'feature')
    await startBaseMerge(cwd, 'other')
    await expect(startBaseMerge(cwd, 'main')).rejects.toThrow(/already in progress/)
  })

  it('merges a base that does not conflict and leaves it to commit', async () => {
    const cwd = await repo()
    await commit(cwd, 'b.txt', 'b\n', 'main adds b')
    git(cwd, 'checkout', '-q', 'feature')
    const merge = await startBaseMerge(cwd, 'main')
    expect(merge.conflicts).toEqual([])
    expect(await mergeState(cwd)).toEqual({ merging: true, unmerged: [], markers: [] })
  })

  it('refuses when the branch already contains the base', async () => {
    const cwd = await repo()
    git(cwd, 'checkout', '-q', 'feature')
    await expect(startBaseMerge(cwd, 'main')).rejects.toThrow(/nothing to merge/)
  })

  it('refuses a worktree with uncommitted changes', async () => {
    const cwd = await conflicting()
    await writeFile(join(cwd, 'notes.txt'), 'draft\n')
    await expect(startBaseMerge(cwd, 'main')).rejects.toThrow(/uncommitted changes/)
    expect(() => git(cwd, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).toThrow(/MERGE_HEAD/)
  })

  it('refuses a base that is not in the worktree', async () => {
    const cwd = await conflicting()
    await expect(startBaseMerge(cwd, 'origin/missing')).rejects.toThrow(/not in the worktree/)
  })
})

describe('mergeState', () => {
  it('reports markers left in a staged file until the file is fixed', async () => {
    const cwd = await conflicting()
    await startBaseMerge(cwd, 'main')
    git(cwd, 'add', 'a.txt')
    expect(await mergeState(cwd)).toEqual({ merging: true, unmerged: [], markers: ['a.txt'] })

    await writeFile(join(cwd, 'a.txt'), 'one\nfeature and main\nthree\n')
    git(cwd, 'add', 'a.txt')
    expect(await mergeState(cwd)).toEqual({ merging: true, unmerged: [], markers: [] })
  })

  it('reports no merge on a clean worktree', async () => {
    const cwd = await repo()
    expect(await mergeState(cwd)).toEqual({ merging: false, unmerged: [], markers: [] })
  })
})
