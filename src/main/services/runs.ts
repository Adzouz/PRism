import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import {
  activeRunStatuses,
  askOptions,
  changesReport,
  draftReply,
  reviewReport,
  runEventKind,
  type Ask,
  type BoardRun,
  type BoardStage,
  type BoardTab,
  type ChangesReport,
  type DraftReply,
  type Finding,
  type ReviewReport,
  type Run,
  type RunEvent,
  type RunEventKind,
  type RunStatus,
  type Stage,
} from '@shared/domain'
import { redact } from '../agents/redact'
import { asks, findings, runEvents, runs } from '../db/schema'
import type { Ctx } from './context'

type RunRow = typeof runs.$inferSelect
type AskRow = typeof asks.$inferSelect

function parse<T>(schema: z.ZodType<T>, json: string | null, fallback: T): T {
  if (!json) return fallback
  try {
    return schema.parse(JSON.parse(json))
  } catch {
    return fallback
  }
}

function toAsk(row: AskRow): Ask {
  const schema = parse(askOptions, row.schemaJson, {})
  return {
    id: row.id,
    runId: row.runId,
    prompt: row.prompt,
    options: schema.options ?? [],
    placeholder: schema.placeholder ?? null,
    answer: parse(z.string(), row.answerJson, null as string | null),
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
  }
}

export function pendingAsk(ctx: Ctx, runId: number) {
  const row = ctx.db
    .select()
    .from(asks)
    .where(and(eq(asks.runId, runId), isNull(asks.answeredAt)))
    .orderBy(desc(asks.id))
    .get()
  return row ? toAsk(row) : null
}

export function latestAsk(ctx: Ctx, runId: number) {
  const row = ctx.db.select().from(asks).where(eq(asks.runId, runId)).orderBy(desc(asks.id)).get()
  return row ? toAsk(row) : null
}

function toRun(ctx: Ctx, row: RunRow): Run {
  return {
    id: row.id,
    prId: row.prId,
    stage: row.stage as Stage,
    skillName: row.skillName,
    agent: row.agent as Run['agent'],
    model: row.model,
    status: row.status,
    progress: row.progress,
    sessionId: row.sessionId,
    worktreePath: row.worktreePath,
    reviewedHeadOid: row.reviewedHeadOid,
    report: parse(reviewReport, row.reportJson, null as ReviewReport | null),
    changes: parse(changesReport, row.changesJson, null as ChangesReport | null),
    replies: parse(z.array(draftReply), row.repliesJson, [] as DraftReply[]),
    threadIds: parse(z.array(z.string()), row.threadsJson, [] as string[]),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    dismissedAt: row.dismissedAt,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costUsd: row.costUsd,
    error: row.error,
    ask: row.status === 'needs_you' ? pendingAsk(ctx, row.id) : null,
  }
}

export function createRun(
  ctx: Ctx,
  input: {
    prId: number
    stage: Stage
    skillId: number | null
    skillName: string | null
    agent: string
    model: string
    threadIds?: string[]
  },
) {
  const { threadIds, ...values } = input
  const row = ctx.db
    .insert(runs)
    .values({
      ...values,
      threadsJson: threadIds ? JSON.stringify(threadIds) : null,
      status: 'queued',
      createdAt: Date.now(),
    })
    .returning()
    .get()
  return toRun(ctx, row)
}

export function getRunRow(ctx: Ctx, id: number) {
  const row = ctx.db.select().from(runs).where(eq(runs.id, id)).get()
  if (!row) throw new Error(`Run ${id} not found`)
  return row
}

export function getRun(ctx: Ctx, id: number) {
  return toRun(ctx, getRunRow(ctx, id))
}

export function updateRun(ctx: Ctx, id: number, set: Partial<Omit<RunRow, 'id'>>) {
  ctx.db.update(runs).set(set).where(eq(runs.id, id)).run()
  return getRun(ctx, id)
}

export function addUsage(
  ctx: Ctx,
  id: number,
  usage: { tokensIn: number; tokensOut: number; costUsd: number },
) {
  const row = getRunRow(ctx, id)
  return updateRun(ctx, id, {
    tokensIn: row.tokensIn + usage.tokensIn,
    tokensOut: row.tokensOut + usage.tokensOut,
    costUsd: row.costUsd + usage.costUsd,
  })
}

export function listRunsForPr(ctx: Ctx, prId: number) {
  return ctx.db
    .select()
    .from(runs)
    .where(eq(runs.prId, prId))
    .orderBy(desc(runs.id))
    .all()
    .map((row) => toRun(ctx, row))
}

export function listRuns(ctx: Ctx, statuses?: readonly RunStatus[]) {
  const query = ctx.db.select().from(runs)
  const rows = statuses
    ? query
        .where(inArray(runs.status, [...statuses]))
        .orderBy(desc(runs.id))
        .all()
    : query.orderBy(desc(runs.id)).limit(200).all()
  return rows.map((row) => toRun(ctx, row))
}

export function activeRunFor(ctx: Ctx, prId: number) {
  return (
    ctx.db
      .select()
      .from(runs)
      .where(and(eq(runs.prId, prId), inArray(runs.status, [...activeRunStatuses])))
      .get() ?? null
  )
}

export function addEvent(
  ctx: Ctx,
  runId: number,
  kind: RunEventKind,
  payload: Record<string, unknown>,
): RunEvent {
  const clean = redact(payload)
  const row = ctx.db
    .insert(runEvents)
    .values({ runId, ts: Date.now(), kind, payloadJson: JSON.stringify(clean) })
    .returning()
    .get()
  return { id: row.id, runId, ts: row.ts, kind, payload: clean }
}

export function listEvents(ctx: Ctx, runId: number, afterId = 0): RunEvent[] {
  return ctx.db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.id, afterId)))
    .orderBy(runEvents.id)
    .all()
    .map((row) => ({
      id: row.id,
      runId: row.runId,
      ts: row.ts,
      kind: runEventKind.catch('note').parse(row.kind),
      payload: parse(z.record(z.string(), z.unknown()), row.payloadJson, {}),
    }))
}

export type NewFinding = {
  path: string
  line: number | null
  side: 'LEFT' | 'RIGHT'
  severity: 'blocking' | 'nit' | 'refactor'
  nitDecision?: 'address' | 'followup' | 'skip'
  title: string
  body: string
  suggestion?: string
  priorFindingId?: number
}

export function saveReview(
  ctx: Ctx,
  runId: number,
  report: ReviewReport,
  items: NewFinding[],
): Run {
  const row = getRunRow(ctx, runId)
  ctx.db.transaction((tx) => {
    tx.delete(findings).where(eq(findings.runId, runId)).run()
    for (const item of items) {
      tx.insert(findings)
        .values({
          prId: row.prId,
          runId,
          anchorPath: item.path,
          anchorLine: item.line,
          side: item.side,
          severity: item.severity,
          nitDecision: item.nitDecision ?? null,
          title: item.title,
          body: item.body,
          suggestion: item.suggestion ?? null,
          priorFindingId: item.priorFindingId ?? null,
        })
        .run()
    }
    tx.update(runs)
      .set({ reportJson: JSON.stringify(redact(report)) })
      .where(eq(runs.id, runId))
      .run()
  })
  return getRun(ctx, runId)
}

export function setPriorStatus(
  ctx: Ctx,
  prId: number,
  items: { findingId: number; status: Finding['status'] }[],
) {
  let updated = 0
  for (const item of items) {
    updated += ctx.db
      .update(findings)
      .set({ status: item.status })
      .where(and(eq(findings.id, item.findingId), eq(findings.prId, prId)))
      .run().changes
  }
  return updated
}

export function listFindings(ctx: Ctx, runId: number): Finding[] {
  return ctx.db
    .select()
    .from(findings)
    .where(eq(findings.runId, runId))
    .orderBy(findings.id)
    .all()
    .map((row) => ({
      id: row.id,
      runId: row.runId,
      path: row.anchorPath,
      line: row.anchorLine,
      side: row.side,
      severity: row.severity,
      nitDecision: row.nitDecision,
      title: row.title,
      body: row.body,
      suggestion: row.suggestion,
      status: row.status,
    }))
}

export function createAsk(
  ctx: Ctx,
  runId: number,
  input: { prompt: string; options?: string[]; placeholder?: string },
) {
  const row = ctx.db
    .insert(asks)
    .values({
      runId,
      prompt: input.prompt,
      schemaJson: JSON.stringify({ options: input.options, placeholder: input.placeholder }),
      createdAt: Date.now(),
    })
    .returning()
    .get()
  return toAsk(row)
}

export function answerAsk(ctx: Ctx, askId: number, answer: string) {
  const row = ctx.db.select().from(asks).where(eq(asks.id, askId)).get()
  if (!row) throw new Error(`Question ${askId} not found`)
  if (row.answeredAt) throw new Error('This question was already answered')
  ctx.db
    .update(asks)
    .set({ answerJson: JSON.stringify(answer), answeredAt: Date.now() })
    .where(eq(asks.id, askId))
    .run()
  return toAsk({ ...row, answerJson: JSON.stringify(answer), answeredAt: Date.now() })
}

const reviewStages = new Set<Stage>(['review', 're-review'])

export function runStage(
  tab: BoardTab,
  run: Pick<BoardRun, 'stage' | 'status'> & { endedAt: number | null },
  pr: { state: string; myReviewAt: number | null },
): BoardStage | null {
  if (run.status === 'needs_you') return 'needs-you'
  const active = run.status === 'queued' || run.status === 'preparing' || run.status === 'running'
  if (!active && pr.state !== 'OPEN') return null
  if (tab === 'reviews' && reviewStages.has(run.stage)) {
    if (active) return 'reviewing'
    if (run.status === 'done' && (pr.myReviewAt ?? 0) < (run.endedAt ?? 0)) return 'verdict-ready'
  }
  if (tab === 'mine' && run.stage === 'address') {
    if (active) return 'addressing'
    if (run.status === 'done') return 'ready-to-post'
  }
  return null
}

export type BoardRunInfo = BoardRun & { endedAt: number | null }

export type PrRuns = {
  latest: BoardRunInfo
  active: BoardRunInfo | null
  reviewed: BoardRunInfo | null
  addressed: BoardRunInfo | null
}

const isActive = (status: RunStatus) => activeRunStatuses.includes(status)

export function latestBoardRuns(ctx: Ctx) {
  const rows = ctx.db
    .select()
    .from(runs)
    .where(isNull(runs.dismissedAt))
    .orderBy(desc(runs.id))
    .all()
  type Picked = { latest: RunRow; active?: RunRow; reviewed?: RunRow; addressed?: RunRow }
  const picked = new Map<number, Picked>()
  for (const row of rows) {
    const entry = picked.get(row.prId) ?? { latest: row }
    entry.active ??= isActive(row.status) ? row : undefined
    entry.reviewed ??=
      row.status === 'done' && reviewStages.has(row.stage as Stage) ? row : undefined
    entry.addressed ??= row.status === 'done' && row.stage === 'address' ? row : undefined
    picked.set(row.prId, entry)
  }
  const used = new Set<number>()
  for (const entry of picked.values()) {
    for (const row of [entry.latest, entry.active, entry.reviewed, entry.addressed]) {
      if (row) used.add(row.id)
    }
  }
  const counts = new Map<number, number>()
  if (used.size > 0) {
    for (const item of ctx.db
      .select({ runId: findings.runId })
      .from(findings)
      .where(inArray(findings.runId, [...used]))
      .all()) {
      counts.set(item.runId, (counts.get(item.runId) ?? 0) + 1)
    }
  }
  const info = (row: RunRow | undefined): BoardRunInfo | null =>
    row
      ? {
          id: row.id,
          stage: row.stage as Stage,
          status: row.status,
          progress: row.progress,
          error: row.error,
          verdict:
            parse(reviewReport, row.reportJson, null as ReviewReport | null)?.verdict ?? null,
          findings: counts.get(row.id) ?? 0,
          ask: row.status === 'needs_you' ? pendingAsk(ctx, row.id) : null,
          endedAt: row.endedAt,
        }
      : null
  const result = new Map<number, PrRuns>()
  for (const [prId, entry] of picked) {
    result.set(prId, {
      latest: info(entry.latest)!,
      active: info(entry.active),
      reviewed: info(entry.reviewed),
      addressed: info(entry.addressed),
    })
  }
  return result
}

export function boardRunFor(
  tab: BoardTab,
  set: PrRuns,
  pr: { state: string; myReviewAt: number | null },
): { run: BoardRunInfo; stage: BoardStage | null } {
  const activeStage = set.active ? runStage(tab, set.active, pr) : null
  const done = tab === 'reviews' ? set.reviewed : set.addressed
  const doneStage = done ? runStage(tab, done, pr) : null
  return {
    stage: activeStage ?? doneStage,
    run: set.active ?? (doneStage && done ? done : set.latest),
  }
}

export function dismissRunsForPr(ctx: Ctx, prId: number) {
  ctx.db
    .update(runs)
    .set({ dismissedAt: Date.now() })
    .where(
      and(
        eq(runs.prId, prId),
        isNull(runs.dismissedAt),
        inArray(runs.status, ['done', 'failed', 'cancelled']),
      ),
    )
    .run()
}

export function saveChanges(ctx: Ctx, runId: number, changes: ChangesReport) {
  return updateRun(ctx, runId, { changesJson: JSON.stringify(redact(changes)) })
}

export function saveReplies(ctx: Ctx, runId: number, replies: DraftReply[]) {
  const existing = getRun(ctx, runId).replies
  const merged = new Map(existing.map((reply) => [reply.threadId, reply]))
  for (const reply of replies) merged.set(reply.threadId, reply)
  return updateRun(ctx, runId, { repliesJson: JSON.stringify(redact([...merged.values()])) })
}
