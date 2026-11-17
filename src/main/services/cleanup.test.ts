import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { RunStatus } from '@shared/domain'
import { openDb } from '../db/client'
import { prs, repos, runs } from '../db/schema'
import { cleanupDoneWorktrees, createWorktreeCleanup, type CleanupReport } from './cleanup'
import type { Ctx } from './context'
import type { WorktreeRemoval } from './worktrees'

const migrations = resolve(__dirname, '../../../drizzle')
const root = '/code/app-worktrees'

function setup() {
  const ctx: Ctx = {
    db: openDb(':memory:', migrations),
    userData: '',
    builtinSkillsDir: '',
    log: () => {},
    skillsChanged: () => {},
  }
  const addRepo = (name: string, localPath: string | null, worktreeRoot: string | null) =>
    ctx.db
      .insert(repos)
      .values({ owner: 'acme', name, localPath, worktreeRoot, addedAt: 0 })
      .returning()
      .get().id
  const repoId = addRepo('app', '/code/app', root)
  const addPr = (number: number, state: 'OPEN' | 'MERGED' | 'CLOSED', repo = repoId) =>
    ctx.db
      .insert(prs)
      .values({
        repoId: repo,
        nodeId: `PR_${repo}_${number}`,
        number,
        title: `Change ${number}`,
        url: `https://github.com/acme/app/pull/${number}`,
        author: 'octocat',
        isDraft: false,
        state,
        headRef: `feature-${number}`,
        headOid: `head${number}`,
        baseRef: 'main',
        baseOid: 'base1',
        ciState: 'none',
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        reviewRequested: false,
        myRole: 'reviewer',
        derivedStage: 'done',
        stageSince: 0,
        createdAt: 0,
        updatedAt: 0,
        syncedAt: 0,
      })
      .returning()
      .get().id
  const addRun = (prId: number, status: RunStatus, worktreePath: string | null) =>
    ctx.db
      .insert(runs)
      .values({
        prId,
        stage: 'review',
        agent: 'claude',
        model: 'claude-opus-5-5',
        status,
        worktreePath,
        createdAt: 1,
      })
      .returning()
      .get().id
  const pathOf = (runId: number) =>
    ctx.db.select().from(runs).where(eq(runs.id, runId)).get()?.worktreePath
  return { ctx, addRepo, addPr, addRun, pathOf }
}

type Remove = (
  options: { clone: string; root: string },
  pr: { number: number; headOid: string },
) => Promise<WorktreeRemoval>

describe('cleanupDoneWorktrees', () => {
  it('removes the worktrees of closed pull requests without an active run', async () => {
    const { ctx, addPr, addRun, pathOf } = setup()
    addPr(1, 'OPEN')
    const merged = addPr(2, 'MERGED')
    const closed = addPr(3, 'CLOSED')
    const busy = addPr(4, 'MERGED')
    const own = addRun(merged, 'done', `${root}/pr-2`)
    const reused = addRun(merged, 'done', '/code/app-feature')
    const dirty = addRun(closed, 'done', `${root}/pr-3`)
    addRun(busy, 'running', `${root}/pr-4`)
    const remove = vi.fn<Remove>(async (_options, pr) =>
      pr.number === 2
        ? { status: 'removed', path: `${root}/pr-2` }
        : { status: 'kept', path: `${root}/pr-3`, reason: 'uncommitted changes' },
    )

    const report = await cleanupDoneWorktrees(ctx, remove)

    expect(remove.mock.calls).toEqual([
      [
        { clone: '/code/app', root },
        { id: merged, number: 2, headOid: 'head2' },
      ],
      [
        { clone: '/code/app', root },
        { id: closed, number: 3, headOid: 'head3' },
      ],
    ])
    expect(report).toEqual({
      removed: [`${root}/pr-2`],
      kept: [{ path: `${root}/pr-3`, reason: 'uncommitted changes' }],
      runIds: [own],
    })
    expect(pathOf(own)).toBeNull()
    expect(pathOf(reused)).toBe('/code/app-feature')
    expect(pathOf(dirty)).toBe(`${root}/pr-3`)
  })

  it('skips repositories without a clone or a worktree folder, and goes on after a failure', async () => {
    const { ctx, addRepo, addPr } = setup()
    addPr(5, 'MERGED', addRepo('docs', null, null))
    addPr(6, 'MERGED')
    addPr(7, 'MERGED')
    const remove = vi.fn<Remove>(async (_options, pr) => {
      if (pr.number === 6) throw new Error('git worktree remove failed')
      return { status: 'missing' }
    })

    const report = await cleanupDoneWorktrees(ctx, remove)

    expect(remove.mock.calls.map(([, pr]) => pr.number)).toEqual([6, 7])
    expect(report.kept).toEqual([{ path: `${root}/pr-6`, reason: 'git worktree remove failed' }])
  })
})

describe('createWorktreeCleanup', () => {
  it('sweeps at most once per interval and reports the runs it changed', async () => {
    const { ctx } = setup()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const report: CleanupReport = {
      removed: [`${root}/pr-2`],
      kept: [{ path: `${root}/pr-3`, reason: 'uncommitted changes' }],
      runIds: [4],
    }
    const sweep = vi.fn<() => Promise<CleanupReport>>(async () => report)
    const runsChanged = vi.fn<(runIds: number[]) => void>()
    const cleanup = createWorktreeCleanup(ctx, { runsChanged, every: 60_000, sweep })

    const first = cleanup.run(0)
    expect(cleanup.run(10)).toBe(first)
    expect(await first).toBe(report)
    expect(await cleanup.run(30_000)).toBeNull()
    expect(await cleanup.run(60_000)).toBe(report)

    expect(sweep).toHaveBeenCalledTimes(2)
    expect(runsChanged).toHaveBeenCalledWith([4])
    const kept = info.mock.calls.filter(([line]) => String(line).startsWith('Kept'))
    expect(kept).toHaveLength(1)
    info.mockRestore()
  })
})
