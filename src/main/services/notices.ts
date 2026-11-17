import {
  activeRunStatuses,
  agentNeedsYou,
  boardColumns,
  boardTabs,
  defaultNotificationSettings,
  gateKindOf,
  isNeedsMe,
  notificationSettings,
  runStageLabel,
  verdictLabels,
  type BoardPr,
  type NoticeKind,
  type NotificationSettings,
  type OpenTarget,
  type Run,
  type RunStatus,
} from '@shared/domain'
import { getSetting, setSetting } from '../db/settings'
import type { Ctx } from './context'
import type { PrEvent } from './sync'

export function getNotificationSettings(ctx: Ctx): NotificationSettings {
  const stored = getSetting(ctx.db, 'notifications', notificationSettings.partial(), {})
  return { ...defaultNotificationSettings, ...stored }
}

export function setNotificationSettings(ctx: Ctx, patch: Partial<NotificationSettings>) {
  const next = { ...getNotificationSettings(ctx), ...patch }
  setSetting(ctx.db, 'notifications', next)
  return next
}

export type Notice = {
  id: string
  kind: NoticeKind
  title: string
  subtitle: string
  body: string
  target: OpenTarget | null
  ask: { id: number; options: string[] } | null
  dedupe: string | null
}

export function clip(text: string, max: number) {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

const muted = (pr: BoardPr) => pr.hidden || pr.archivedAt !== null

const prRef = (pr: BoardPr) => `${pr.repo} #${pr.number}`

const shortRef = (pr: BoardPr) => `${pr.repo.split('/').at(-1)} #${pr.number}`

function finishedBody(run: Run, pr: BoardPr) {
  if (run.stage === 'review' || run.stage === 're-review') {
    const findings = pr.run?.id === run.id ? pr.run.findings : null
    return [
      run.report ? verdictLabels[run.report.verdict] : null,
      findings === null ? null : plural(findings, 'finding', 'findings'),
      'Ready to post',
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (run.stage === 'address') {
    const threads = run.changes?.threads.length ?? 0
    const handled = threads > 0 ? `${plural(threads, 'thread', 'threads')} handled · ` : ''
    return `${handled}Ready to commit and push`
  }
  if (run.stage === 'draft-replies') {
    return `${plural(run.replies.length, 'draft reply', 'draft replies')} · Ready to post`
  }
  return run.report?.summary ? clip(run.report.summary, 200) : 'Ready to read'
}

export function runNotice(prev: RunStatus | undefined, run: Run, pr: BoardPr): Notice | null {
  if (prev === undefined || prev === run.status || muted(pr)) return null
  const label = runStageLabel(run.stage, pr)
  const target = (tab: OpenTarget['tab']): OpenTarget => ({
    prId: pr.id,
    page: pr.tab,
    tab,
    runId: run.id,
  })
  const base = { subtitle: `${prRef(pr)} · ${pr.title}`, dedupe: null }
  if (run.status === 'needs_you' && run.ask) {
    return {
      ...base,
      id: `ask:${run.ask.id}`,
      kind: 'needsYou',
      title: `${label} needs your answer`,
      body: clip(run.ask.prompt, 240),
      target: target('runs'),
      ask: { id: run.ask.id, options: run.ask.options },
    }
  }
  if (!activeRunStatuses.includes(prev)) return null
  if (run.status === 'done') {
    return {
      ...base,
      id: `run:${run.id}`,
      kind: 'runFinished',
      title: `${label} done`,
      body: finishedBody(run, pr),
      target: target(gateKindOf[run.stage] ? 'post' : 'runs'),
      ask: null,
    }
  }
  if (run.status === 'failed') {
    return {
      ...base,
      id: `run:${run.id}`,
      kind: 'runFinished',
      title: `${label} failed`,
      body: clip(run.error ?? 'The run stopped with an error', 240),
      target: target('runs'),
      ask: null,
    }
  }
  return null
}

export function prNotice(event: PrEvent, pr: BoardPr): Notice | null {
  if (muted(pr) || pr.state !== 'OPEN') return null
  const base = {
    subtitle: `${prRef(pr)} · ${pr.title}`,
    target: { prId: pr.id, page: pr.tab, tab: 'overview', runId: null } satisfies OpenTarget,
    ask: null,
  }
  if (event.kind === 'reviewRequested') {
    return {
      ...base,
      id: `review:${pr.id}`,
      kind: 'reviewRequested',
      title: pr.myReviewState ? 'Re-review requested' : 'Review requested',
      body: pr.requestedTeam
        ? `From @${pr.author}, for the ${pr.requestedTeam} team`
        : `From @${pr.author}`,
      dedupe: `review:${pr.id}`,
    }
  }
  return {
    ...base,
    id: `ci:${pr.id}`,
    kind: 'ciFailed',
    title: 'Checks failed',
    body: `A check failed on ${event.headOid.slice(0, 7)}`,
    dedupe: `ci:${pr.id}:${event.headOid}`,
  }
}

export type TrayItem = { label: string; detail: string; target: OpenTarget }

const liveStatuses: readonly RunStatus[] = ['queued', 'preparing', 'running']

export function needsYouItems(prs: BoardPr[]): TrayItem[] {
  return prs
    .filter(agentNeedsYou)
    .map((pr) => ({ pr, run: pr.run! }))
    .sort(
      (a, b) =>
        Number(b.run.status === 'needs_you') - Number(a.run.status === 'needs_you') ||
        b.run.id - a.run.id,
    )
    .map(({ pr, run }) => {
      const question = run.status === 'needs_you'
      return {
        label: `${shortRef(pr)} · ${pr.title}`,
        detail: question
          ? (run.ask?.prompt ?? 'Waiting for your answer')
          : `${runStageLabel(run.stage, pr)} ready to post`,
        target: { prId: pr.id, page: pr.tab, tab: question ? 'runs' : 'post', runId: run.id },
      }
    })
}

export function yourTurnItems(prs: BoardPr[]): TrayItem[] {
  const order = (pr: BoardPr) =>
    boardColumns[pr.tab].findIndex((column) => column.stage === pr.stage)
  return prs
    .filter((pr) => pr.archivedAt === null && !pr.hidden && isNeedsMe(pr) && !agentNeedsYou(pr))
    .sort(
      (a, b) =>
        boardTabs.indexOf(a.tab) - boardTabs.indexOf(b.tab) ||
        order(a) - order(b) ||
        b.updatedAt - a.updatedAt ||
        b.id - a.id,
    )
    .map((pr) => ({
      label: `${shortRef(pr)} · ${pr.title}`,
      detail: boardColumns[pr.tab][order(pr)]?.label ?? pr.stage,
      target: { prId: pr.id, page: pr.tab, tab: 'overview', runId: null },
    }))
}

export function runningItems(prs: BoardPr[]): TrayItem[] {
  return prs
    .flatMap((pr) => (pr.run && liveStatuses.includes(pr.run.status) ? [{ pr, run: pr.run }] : []))
    .sort((a, b) => b.run.id - a.run.id)
    .map(({ pr, run }) => ({
      label: `${runStageLabel(run.stage, pr)} · ${shortRef(pr)}`,
      detail: run.progress ?? (run.status === 'queued' ? 'Queued' : 'Running'),
      target: { prId: pr.id, page: pr.tab, tab: 'runs', runId: run.id },
    }))
}
