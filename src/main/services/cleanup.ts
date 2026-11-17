import { join } from 'node:path'
import { and, eq, inArray, ne } from 'drizzle-orm'
import { prs, runs } from '../db/schema'
import type { Ctx } from './context'
import { listRepos } from './repos'
import { activeRunFor } from './runs'
import { removePrWorktree } from './worktrees'

export type CleanupReport = {
  removed: string[]
  kept: { path: string; reason: string }[]
  runIds: number[]
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export async function cleanupDoneWorktrees(
  ctx: Ctx,
  remove = removePrWorktree,
): Promise<CleanupReport> {
  const report: CleanupReport = { removed: [], kept: [], runIds: [] }
  for (const repo of listRepos(ctx)) {
    const { localPath: clone, worktreeRoot: root } = repo
    if (!clone || !root) continue
    const done = ctx.db
      .select({ id: prs.id, number: prs.number, headOid: prs.headOid })
      .from(prs)
      .where(and(eq(prs.repoId, repo.id), ne(prs.state, 'OPEN')))
      .all()
    for (const pr of done) {
      if (activeRunFor(ctx, pr.id)) continue
      const folder = join(root, `pr-${pr.number}`)
      try {
        const result = await remove({ clone, root }, pr)
        if (result.status === 'kept') report.kept.push({ path: result.path, reason: result.reason })
        if (result.status !== 'removed') continue
        report.removed.push(result.path)
        const cleared = ctx.db
          .update(runs)
          .set({ worktreePath: null })
          .where(
            and(
              eq(runs.prId, pr.id),
              inArray(runs.worktreePath, [...new Set([result.path, folder])]),
            ),
          )
          .returning({ id: runs.id })
          .all()
        report.runIds.push(...cleared.map((row) => row.id))
      } catch (error) {
        report.kept.push({ path: folder, reason: message(error) })
      }
    }
  }
  return report
}

export function createWorktreeCleanup(
  ctx: Ctx,
  options: {
    runsChanged: (runIds: number[]) => void
    every?: number
    sweep?: () => Promise<CleanupReport>
  },
) {
  const every = options.every ?? 30 * 60_000
  const sweep = options.sweep ?? (() => cleanupDoneWorktrees(ctx))
  const reported = new Map<string, string>()
  let lastRunAt: number | null = null
  let current: Promise<CleanupReport | null> | null = null

  function log(report: CleanupReport) {
    for (const path of report.removed) {
      reported.delete(path)
      console.info(`Removed the worktree ${path}: its pull request is closed`)
    }
    for (const { path, reason } of report.kept) {
      if (reported.get(path) === reason) continue
      reported.set(path, reason)
      console.info(`Kept the worktree ${path}: ${reason}`)
    }
  }

  return {
    run(now = Date.now()): Promise<CleanupReport | null> {
      if (current) return current
      if (lastRunAt !== null && now - lastRunAt < every) return Promise.resolve(null)
      lastRunAt = now
      current = sweep()
        .then((report) => {
          log(report)
          if (report.runIds.length > 0) options.runsChanged(report.runIds)
          return report
        })
        .catch((error: unknown) => {
          console.warn('Worktree cleanup failed:', error)
          return null
        })
        .finally(() => {
          current = null
        })
      return current
    },
  }
}

export type WorktreeCleanup = ReturnType<typeof createWorktreeCleanup>
