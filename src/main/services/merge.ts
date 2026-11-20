import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { run, type RunResult } from '../system/exec'

export type BaseMerge = { base: string; baseOid: string; conflicts: string[]; resumed: boolean }
export type MergeState = { merging: boolean; unmerged: string[]; markers: string[] }

type Exec = (cwd: string, args: string[]) => Promise<RunResult>

const git: Exec = (cwd, args) => run('git', ['-C', cwd, ...args], { timeout: 120_000 })

const short = (oid: string) => oid.slice(0, 7)

async function oidOf(cwd: string, ref: string, exec: Exec = git) {
  const result = await exec(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`])
  return result.code === 0 ? result.stdout.trim() : null
}

async function unmergedFiles(cwd: string, exec: Exec = git) {
  const result = await exec(cwd, ['diff', '--name-only', '-z', '--diff-filter=U'])
  if (result.code !== 0) throw new Error(`git diff failed: ${result.stderr.trim()}`)
  return [...new Set(result.stdout.split('\0').filter(Boolean))]
}

export async function mergeInProgress(cwd: string, exec: Exec = git) {
  return Boolean(await oidOf(cwd, 'MERGE_HEAD', exec))
}

async function opensConflict(cwd: string, file: string, lines: number[]) {
  const content = await readFile(join(cwd, file), 'utf8').catch(() => null)
  if (content === null) return true
  const text = content.split('\n')
  return lines.some((line) => /^(<{7}|\|{7}|>{7})/.test(text[line - 1] ?? ''))
}

async function conflictMarkers(cwd: string, exec: Exec) {
  const result = await exec(cwd, ['diff', 'HEAD', '--check', '--no-color'])
  const flagged = new Map<string, number[]>()
  for (const line of result.stdout.split('\n')) {
    const match = /^(.+):(\d+): leftover conflict marker$/.exec(line)
    if (match) flagged.set(match[1]!, [...(flagged.get(match[1]!) ?? []), Number(match[2])])
  }
  const files = await Promise.all(
    [...flagged].map(async ([file, lines]) =>
      (await opensConflict(cwd, file, lines)) ? file : [],
    ),
  )
  return files.flat()
}

export async function mergeState(cwd: string, exec: Exec = git): Promise<MergeState> {
  const [merging, unmerged, markers] = await Promise.all([
    oidOf(cwd, 'MERGE_HEAD', exec).then(Boolean),
    unmergedFiles(cwd, exec),
    conflictMarkers(cwd, exec),
  ])
  return { merging, unmerged, markers }
}

export async function startBaseMerge(cwd: string, base: string): Promise<BaseMerge> {
  const baseOid = await oidOf(cwd, base)
  if (!baseOid) throw new Error(`${base} is not in the worktree, so nothing was merged`)
  const mergeHead = await oidOf(cwd, 'MERGE_HEAD')
  if (mergeHead) {
    if (mergeHead !== baseOid) {
      throw new Error(
        `A merge of ${short(mergeHead)} is already in progress in ${cwd}, but ${base} is now at ${short(baseOid)}. Run git merge --abort there, then Resolve conflicts again`,
      )
    }
    return { base, baseOid, conflicts: await unmergedFiles(cwd), resumed: true }
  }
  const status = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`)
  if (status.stdout) {
    throw new Error(
      `The worktree at ${cwd} has uncommitted changes. Commit them from their post gate or discard them, then Resolve conflicts again`,
    )
  }
  if ((await git(cwd, ['merge-base', '--is-ancestor', baseOid, 'HEAD'])).code === 0) {
    throw new Error(`The branch already contains ${base}, so there is nothing to merge`)
  }
  const merged = await git(cwd, [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'merge.conflictStyle=diff3',
    'merge',
    '--no-ff',
    '--no-commit',
    base,
  ])
  if (!(await oidOf(cwd, 'MERGE_HEAD'))) {
    const detail = (merged.stderr || merged.stdout).trim()
    throw new Error(`git merge ${base} did not start${detail ? `: ${detail}` : ''}`)
  }
  return { base, baseOid, conflicts: await unmergedFiles(cwd), resumed: false }
}
