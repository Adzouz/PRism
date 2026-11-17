import { count, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { reviewStageFor, type Run, type RunStatus, type Stage } from '@shared/domain'
import { prs, repos, runs } from '../db/schema'
import { getSetting, setSetting } from '../db/settings'
import type { Ctx } from './context'
import { getPr } from './prs'
import { activeRunFor } from './runs'
import type { PrEvent } from './sync'

export const autoRunLimit = 2
export const autoRunNote = 'Started automatically: your review was requested.'

const busyStatuses: readonly RunStatus[] = ['queued', 'preparing', 'running']
const queueKey = 'autoRunQueue'
const queueSchema = z.array(z.object({ prId: z.number(), at: z.number() }))
type Entry = z.infer<typeof queueSchema>[number]

export const autoRunQueue = (ctx: Ctx) => getSetting(ctx.db, queueKey, queueSchema, [])

function autoRunOn(ctx: Ctx, prId: number) {
  const row = ctx.db
    .select({ autoRun: repos.autoRun })
    .from(prs)
    .innerJoin(repos, eq(repos.id, prs.repoId))
    .where(eq(prs.id, prId))
    .get()
  return row?.autoRun ?? false
}

export function autoRunStage(ctx: Ctx, entry: Entry): Stage | null {
  if (!autoRunOn(ctx, entry.prId)) return null
  const pr = getPr(ctx, entry.prId)
  if (pr.state !== 'OPEN' || pr.tab !== 'reviews' || !pr.reviewRequested) return null
  if (pr.hidden || pr.archivedAt !== null || pr.stage === 'reviewing') return null
  if (activeRunFor(ctx, entry.prId)) return null
  const latest = ctx.db
    .select({ createdAt: runs.createdAt })
    .from(runs)
    .where(eq(runs.prId, entry.prId))
    .orderBy(desc(runs.createdAt))
    .get()
  if (latest && latest.createdAt >= entry.at) return null
  return reviewStageFor(pr)
}

export function createAutoRun(
  ctx: Ctx,
  deps: {
    start: (input: { prId: number; stage: Stage; note: string }) => Run
    limit?: number
  },
) {
  const limit = deps.limit ?? autoRunLimit
  const busy = () =>
    ctx.db
      .select({ value: count() })
      .from(runs)
      .where(inArray(runs.status, [...busyStatuses]))
      .get()?.value ?? 0

  const safely = (task: () => void) => {
    try {
      task()
    } catch (error) {
      console.warn('Auto-run failed:', error)
    }
  }

  function drainQueue() {
    const queue = autoRunQueue(ctx)
    if (queue.length === 0) return
    let active = busy()
    const waiting: Entry[] = []
    for (const entry of queue) {
      if (active >= limit) {
        waiting.push(entry)
        continue
      }
      try {
        const stage = autoRunStage(ctx, entry)
        if (!stage) continue
        deps.start({ prId: entry.prId, stage, note: autoRunNote })
        active += 1
      } catch (error) {
        console.warn(`Auto-run did not start on pull request ${entry.prId}:`, error)
      }
    }
    setSetting(ctx.db, queueKey, waiting)
  }

  function enqueue(events: PrEvent[], now: number) {
    const queue = autoRunQueue(ctx)
    const before = queue.length
    const queued = new Set(queue.map((entry) => entry.prId))
    for (const event of events) {
      if (event.kind !== 'reviewRequested' || !event.direct || queued.has(event.prId)) continue
      if (!autoRunOn(ctx, event.prId)) continue
      queue.push({ prId: event.prId, at: now })
      queued.add(event.prId)
    }
    if (queue.length > before) setSetting(ctx.db, queueKey, queue)
  }

  return {
    handle(events: PrEvent[], now = Date.now()) {
      safely(() => {
        enqueue(events, now)
        drainQueue()
      })
    },
    drain: () => safely(drainQueue),
  }
}

export type AutoRun = ReturnType<typeof createAutoRun>
