import { run } from '../system/exec'

export type DeltaCommit = { sha: string; subject: string }

export type Delta =
  | { kind: 'full'; reason: string }
  | { kind: 'none'; since: string }
  | { kind: 'base-only'; since: string; rebased: boolean }
  | {
      kind: 'commits'
      since: string
      rebased: boolean
      commits: DeltaCommit[]
      dropped: DeltaCommit[]
      files: string[]
    }

export type DeltaInput = {
  lastHead: string | null
  lastBase: string | null
  head: string
  base: string
}

async function git(cwd: string, args: string[]) {
  const result = await run('git', ['-C', cwd, ...args], { timeout: 120_000 })
  return { ok: result.code === 0, out: result.stdout }
}

async function gitOut(cwd: string, args: string[]) {
  const result = await git(cwd, args)
  if (!result.ok) throw new Error(`git ${args[0]} failed`)
  return result.out.trim()
}

const lines = (text: string) => text.split('\n').filter(Boolean)

function parseLog(text: string): DeltaCommit[] {
  return lines(text).map((line) => {
    const [sha = '', ...rest] = line.split('\t')
    return { sha, subject: rest.join('\t') }
  })
}

const rangeLine = /^\s*(?:-|\d+):\s+(-+|[0-9a-f]+)\s+([=!<>])\s+(?:-|\d+):\s+(-+|[0-9a-f]+)\s?(.*)$/

const isSha = (text: string) => !/^-+$/.test(text)

export function parseRangeDiff(output: string) {
  const commits: DeltaCommit[] = []
  const dropped: DeltaCommit[] = []
  for (const line of output.split('\n')) {
    const match = rangeLine.exec(line)
    if (!match) continue
    const [, oldSha = '', mark, sha = '', rest = ''] = match
    const subject = rest.trim()
    if ((mark === '!' || mark === '>') && isSha(sha)) commits.push({ sha, subject })
    if (mark === '<' && isSha(oldSha)) dropped.push({ sha: oldSha, subject })
  }
  const rewritten = new Set(commits.map((commit) => commit.subject))
  return { commits, dropped: dropped.filter((commit) => !rewritten.has(commit.subject)) }
}

async function filesOf(cwd: string, commits: DeltaCommit[]) {
  const files = new Set<string>()
  for (const commit of commits) {
    const out = await gitOut(cwd, ['show', '--no-renames', '--name-only', '--format=', commit.sha])
    for (const file of lines(out)) files.add(file)
  }
  return [...files].sort()
}

export async function computeDelta(cwd: string, input: DeltaInput): Promise<Delta> {
  const { lastHead, head, base } = input
  if (!lastHead) return { kind: 'full', reason: 'no earlier review' }
  if (lastHead === head) return { kind: 'none', since: lastHead }
  if (!(await git(cwd, ['cat-file', '-e', `${lastHead}^{commit}`])).ok) {
    return { kind: 'full', reason: `the last reviewed commit ${lastHead.slice(0, 12)} is gone` }
  }
  try {
    if ((await git(cwd, ['merge-base', '--is-ancestor', lastHead, head])).ok) {
      const commits = parseLog(
        await gitOut(cwd, [
          'log',
          '--no-merges',
          '--format=%H%x09%s',
          `${lastHead}..${head}`,
          `^${base}`,
        ]),
      ).reverse()
      if (commits.length === 0) return { kind: 'base-only', since: lastHead, rebased: false }
      return {
        kind: 'commits',
        since: lastHead,
        rebased: false,
        commits,
        dropped: [],
        files: await filesOf(cwd, commits),
      }
    }
    const oldBase = await gitOut(cwd, ['merge-base', lastHead, input.lastBase ?? base]).catch(() =>
      gitOut(cwd, ['merge-base', lastHead, base]),
    )
    const newBase = await gitOut(cwd, ['merge-base', head, base])
    const diff = await git(cwd, [
      'range-diff',
      '--no-color',
      `${oldBase}..${lastHead}`,
      `${newBase}..${head}`,
    ])
    if (!diff.ok) return { kind: 'full', reason: 'git range-diff failed after a force-push' }
    const parsed = parseRangeDiff(diff.out)
    const resolveShas = async (items: DeltaCommit[]) => {
      const resolved: DeltaCommit[] = []
      for (const item of items) {
        resolved.push({ ...item, sha: await gitOut(cwd, ['rev-parse', item.sha]) })
      }
      return resolved
    }
    const commits = await resolveShas(parsed.commits)
    const dropped = await resolveShas(parsed.dropped)
    if (commits.length === 0 && dropped.length === 0) {
      return { kind: 'base-only', since: lastHead, rebased: true }
    }
    return {
      kind: 'commits',
      since: lastHead,
      rebased: true,
      commits,
      dropped,
      files: await filesOf(cwd, [...commits, ...dropped]),
    }
  } catch (error) {
    return { kind: 'full', reason: error instanceof Error ? error.message : String(error) }
  }
}

export function describeDelta(delta: Delta) {
  if (delta.kind === 'full') return `Full re-review: ${delta.reason}.`
  const since = delta.since.slice(0, 12)
  if (delta.kind === 'none') return `No new commits since the last review at ${since}.`
  if (delta.kind === 'base-only') {
    return delta.rebased
      ? `The branch was rebased since ${since}, with no change to its own commits.`
      : `Only base-branch merges since ${since}.`
  }
  const plural = (n: number) => `${n} commit${n === 1 ? '' : 's'}`
  const removed = delta.dropped.length ? `, ${plural(delta.dropped.length)} removed` : ''
  return `Re-review covers ${plural(delta.commits.length)}${removed} since ${since}${delta.rebased ? ' (after a force-push, commits that only moved are left out)' : ''}.`
}
