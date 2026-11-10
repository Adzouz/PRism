import { useState, type FormEvent, type ReactNode } from 'react'
import {
  Bot,
  CircleCheck,
  CircleX,
  FolderGit2,
  GitCommitHorizontal,
  Loader2,
  Play,
  Send,
  Square,
  SquareTerminal,
  X,
} from 'lucide-react'
import {
  gateKindOf,
  runStagesByTab,
  stageLabels,
  threadStages,
  type BoardPr,
  type ChangesReport,
  type Finding,
  type ReviewThread,
  type Run,
  type Stage,
} from '@shared/domain'
import { ErrorText } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  runStageFor,
  useApps,
  useCancelRun,
  useDismissRun,
  useFollowUp,
  usePrRuns,
  usePrThreads,
  useResumeInTerminal,
  useRunFindings,
  useStartRun,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { age, useBoardStore, useNow } from '../board/model'
import {
  AnswerForm,
  isLive,
  Loading,
  Markdown,
  RunStatusBadge,
  verdictLabel,
  verdictTone,
} from './parts'
import { lastComment, threadWhere, ThreadPicker } from './threads'
import { Transcript } from './transcript'

export const severityOrder: Finding['severity'][] = ['blocking', 'refactor', 'nit']

export const severityTone: Record<Finding['severity'], 'destructive' | 'warning' | 'default'> = {
  blocking: 'destructive',
  refactor: 'warning',
  nit: 'default',
}

const actionLabel: Record<ChangesReport['threads'][number]['action'], string> = {
  fix: 'Fixed',
  push_back: 'Push back',
  defer: 'Deferred',
}

const actionTone: Record<
  ChangesReport['threads'][number]['action'],
  'success' | 'warning' | 'default'
> = {
  fix: 'success',
  push_back: 'warning',
  defer: 'default',
}

const terminal = (run: Run) =>
  run.status === 'done' || run.status === 'failed' || run.status === 'cancelled'

export function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
      {children}
    </h3>
  )
}

function Findings({ runId }: { runId: number }) {
  const { data: findings, error } = useRunFindings(runId)
  if (error && !findings) return <ErrorText error={error} />
  if (!findings?.length) return null
  const sorted = [...findings].sort(
    (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity),
  )
  return (
    <ul className="space-y-2">
      {sorted.map((finding) => (
        <li key={finding.id} className="space-y-1.5 rounded-xl border p-3">
          <div className="flex items-center gap-2 text-xs">
            <Badge variant={severityTone[finding.severity]}>{finding.severity}</Badge>
            <span className="truncate font-mono text-muted-foreground select-text">
              {finding.path}
              {finding.line ? `:${finding.line}` : ''}
            </span>
          </div>
          <p className="text-sm font-medium select-text">{finding.title}</p>
          <Markdown text={finding.body} className="text-muted-foreground" />
          {finding.suggestion && (
            <pre className="overflow-x-auto rounded-md bg-secondary/60 p-2 font-mono text-xs select-text">
              {finding.suggestion}
            </pre>
          )}
        </li>
      ))}
    </ul>
  )
}

export function ThreadContext({ thread, id }: { thread: ReviewThread | undefined; id: string }) {
  return (
    <div className="mb-1.5 space-y-0.5">
      <p className="truncate font-mono text-xs text-muted-foreground">
        {thread ? threadWhere(thread) : id}
      </p>
      {thread && (
        <p className="line-clamp-2 text-xs text-muted-foreground">{lastComment(thread)}</p>
      )}
    </div>
  )
}

function Changes({
  changes,
  threads,
}: {
  changes: ChangesReport
  threads: Map<string, ReviewThread>
}) {
  return (
    <section className="space-y-2">
      <Heading>Changes</Heading>
      {changes.summary && <Markdown text={changes.summary} />}
      {changes.threads.map((item) => (
        <div key={item.threadId} className="rounded-xl border p-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <ThreadContext thread={threads.get(item.threadId)} id={item.threadId} />
            </div>
            <Badge variant={actionTone[item.action]}>{actionLabel[item.action]}</Badge>
          </div>
          {item.note && <Markdown text={item.note} />}
        </div>
      ))}
      {changes.filesTouched.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Files touched:{' '}
          <span className="font-mono select-text">{changes.filesTouched.join(', ')}</span>
        </p>
      )}
      {changes.checks.length > 0 && (
        <ul className="space-y-1 text-xs">
          {changes.checks.map((check, index) => (
            <li key={`${check.command}-${index}`} className="flex items-center gap-1.5">
              {check.ok ? (
                <CircleCheck className="size-3.5 text-success" />
              ) : (
                <CircleX className="size-3.5 text-destructive" />
              )}
              <span className="font-mono select-text">{check.command}</span>
              {check.note && <span className="text-muted-foreground">· {check.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function FollowUp({ run }: { run: Run }) {
  const [text, setText] = useState('')
  const followUp = useFollowUp()
  const send = (event?: FormEvent) => {
    event?.preventDefault()
    if (!text.trim() || followUp.isPending) return
    followUp.mutate({ runId: run.id, message: text.trim() }, { onSuccess: () => setText('') })
  }
  return (
    <form onSubmit={send} className="space-y-1.5">
      <div className="flex items-end gap-1.5">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send()
          }}
          rows={2}
          aria-label="Follow-up message"
          placeholder="Ask the agent to check or change something in this run…"
          className="min-h-9 flex-1 resize-none rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button
          type="submit"
          size="icon"
          className="size-9"
          aria-label="Send follow-up"
          disabled={!text.trim() || followUp.isPending}
        >
          {followUp.isPending ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </div>
      <ErrorText error={followUp.error} />
    </form>
  )
}

function Duration({ run }: { run: Run }) {
  const now = useNow(10_000)
  if (!run.startedAt) return null
  return <span>{age(run.startedAt, run.endedAt ?? now).replace('now', '<1m')}</span>
}

function useTerminalName() {
  const { data: apps } = useApps()
  const iterm =
    apps?.preferred.terminal === 'iterm' && apps.terminals.some((app) => app.id === 'iterm')
  return iterm ? 'iTerm' : 'Terminal'
}

function RunDetail({
  run,
  canFollowUp,
  stale,
}: {
  run: Run
  canFollowUp: boolean
  stale: boolean
}) {
  const cancel = useCancelRun()
  const dismiss = useDismissRun()
  const resume = useResumeInTerminal()
  const terminalName = useTerminalName()
  const selectRun = useBoardStore((state) => state.selectRun)
  const setDrawerTab = useBoardStore((state) => state.setDrawerTab)
  const live = isLive(run.status)
  const wantsThreads = run.threadIds.length > 0 || run.replies.length > 0 || run.changes !== null
  const { data: threadList } = usePrThreads(run.prId, wantsThreads)
  const threads = new Map((threadList ?? []).map((thread) => [thread.id, thread]))
  const done = terminal(run)
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <RunStatusBadge status={run.status} />
        <span className="font-medium">{stageLabels[run.stage]}</span>
        {run.skillName && <span className="text-muted-foreground">· {run.skillName}</span>}
        <span className="ml-auto flex gap-1.5">
          {(live || run.status === 'needs_you') && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(run.id)}
            >
              <Square />
              Stop
            </Button>
          )}
          {done && run.sessionId && run.worktreePath && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={resume.isPending}
              onClick={() => resume.mutate(run.id)}
            >
              <SquareTerminal />
              Resume in {terminalName}
            </Button>
          )}
          {run.status === 'done' && gateKindOf[run.stage] && (
            <Button
              size="sm"
              className="h-7"
              onClick={() => {
                selectRun(run.id)
                setDrawerTab('post')
              }}
            >
              <Send />
              Post
            </Button>
          )}
          {done && run.dismissedAt === null && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={dismiss.isPending}
              onClick={() => dismiss.mutate(run.id)}
            >
              <X />
              Dismiss
            </Button>
          )}
        </span>
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{run.model}</span>
        <Duration run={run} />
        <span>
          {(run.tokensIn + run.tokensOut).toLocaleString()} tokens · ${run.costUsd.toFixed(2)}
        </span>
        {run.threadIds.length > 0 && (
          <span>
            {run.threadIds.length} thread{run.threadIds.length === 1 ? '' : 's'}
          </span>
        )}
        {run.dismissedAt !== null && <span>Dismissed</span>}
        {run.worktreePath && (
          <span className="flex min-w-0 items-center gap-1 font-mono select-text">
            <FolderGit2 className="size-3.5 shrink-0" />
            <span className="truncate">{run.worktreePath}</span>
          </span>
        )}
      </p>
      {run.progress && live && <p className="text-sm text-primary">{run.progress}…</p>}
      <ErrorText error={cancel.error ?? dismiss.error ?? resume.error} />
      {run.error && <p className="text-sm text-destructive select-text">{run.error}</p>}

      {run.ask && (
        <div className="rounded-xl border border-warning/40 bg-warning/5 p-3">
          <AnswerForm ask={run.ask} />
        </div>
      )}

      {run.report && run.stage === 'test-plan' && (
        <section className="space-y-3">
          <Heading>How to test</Heading>
          <Markdown text={run.report.summary} />
        </section>
      )}

      {run.report && run.stage !== 'test-plan' && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Heading>Verdict</Heading>
            <Badge variant={verdictTone[run.report.verdict]}>
              {verdictLabel[run.report.verdict]}
            </Badge>
          </div>
          {stale && (
            <p className="flex items-center gap-1.5 text-sm text-warning">
              <GitCommitHorizontal className="size-4 shrink-0" />
              New commits since this review. Run a re-review to cover them.
            </p>
          )}
          <Markdown text={run.report.summary} />
          <Findings runId={run.id} />
        </section>
      )}

      {run.changes && <Changes changes={run.changes} threads={threads} />}

      {run.replies.length > 0 && (
        <section className="space-y-2">
          <Heading>Draft replies</Heading>
          {run.replies.map((reply) => (
            <div key={reply.threadId} className="rounded-xl border p-3">
              <ThreadContext thread={threads.get(reply.threadId)} id={reply.threadId} />
              <Markdown text={reply.body} />
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <Heading>Transcript</Heading>
        <Transcript runId={run.id} live={live} />
      </section>

      {done && run.sessionId && run.worktreePath && canFollowUp && <FollowUp run={run} />}
    </div>
  )
}

function RunPicker({
  runs,
  current,
  onSelect,
}: {
  runs: Run[]
  current: Run | null
  onSelect: (runId: number) => void
}) {
  const now = useNow()
  return (
    <div className="border-t pt-4">
      <div
        role="group"
        aria-label="Run history"
        className="-m-0.5 flex max-h-20 flex-wrap gap-1 overflow-y-auto p-0.5"
      >
        {runs.map((item) => {
          const selected = item.id === current?.id
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(item.id)}
              className={cn(
                'rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring',
                selected && 'bg-secondary font-medium text-foreground shadow-sm',
              )}
            >
              {stageLabels[item.stage]} · {age(item.createdAt, now)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function RunsPanel({ pr }: { pr: BoardPr }) {
  const { data: runs, isLoading, error } = usePrRuns(pr.id)
  const start = useStartRun()
  const openRunId = useBoardStore((state) => state.openRunId)
  const selectRun = useBoardStore((state) => state.selectRun)
  const [pickedStage, setStage] = useState<Stage | null>(null)
  const stage = pickedStage ?? runStageFor(pr)
  const [chosenThreads, setChosenThreads] = useState<Set<string> | null>(null)
  const isOpen = pr.state === 'OPEN'
  const needsThreads = isOpen && threadStages.includes(stage)
  const { data: threads } = usePrThreads(pr.id, needsThreads)
  const openThreads = (threads ?? []).filter((thread) => !thread.isResolved).length
  const threadCount = chosenThreads ? chosenThreads.size : openThreads
  const active = runs?.find((run) => isLive(run.status) || run.status === 'needs_you')
  const current = runs?.find((run) => run.id === openRunId) ?? runs?.[0] ?? null
  const blocked = stage === 'draft-replies' && threads !== undefined && threadCount === 0

  const run = () =>
    start.mutate(
      {
        prId: pr.id,
        stage,
        threadIds: needsThreads && chosenThreads ? [...chosenThreads] : undefined,
      },
      { onSuccess: (created) => selectRun(created.id) },
    )

  return (
    <div className="space-y-5">
      {isOpen && (
        <div className="space-y-3">
          <ToggleGroup
            type="single"
            value={stage}
            onValueChange={(value) => value && setStage(value as Stage)}
            aria-label="Run stage"
            className="flex-wrap bg-secondary/50"
          >
            {runStagesByTab[pr.tab].map((item) => (
              <ToggleGroupItem key={item} value={item} className="h-7 px-2.5 text-xs">
                {stageLabels[item]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {needsThreads && (
            <ThreadPicker prId={pr.id} selected={chosenThreads} onChange={setChosenThreads} />
          )}
          <Button
            size="sm"
            disabled={!runs || Boolean(active) || start.isPending || blocked}
            onClick={run}
          >
            {start.isPending ? <Loader2 className="animate-spin" /> : <Play />}
            Run {stageLabels[stage].toLowerCase()}
            {needsThreads && threads && ` · ${threadCount} thread${threadCount === 1 ? '' : 's'}`}
          </Button>
          <ErrorText error={start.error} />
        </div>
      )}
      {runs && runs.length > 1 && <RunPicker runs={runs} current={current} onSelect={selectRun} />}
      {isLoading ? (
        <Loading>Loading runs…</Loading>
      ) : error && !runs ? (
        <ErrorText error={error} />
      ) : current ? (
        <RunDetail
          key={current.id}
          run={current}
          canFollowUp={!active}
          stale={pr.run?.id === current.id && pr.run.stale}
        />
      ) : (
        <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
          <Bot className="size-6" />
          No runs yet. Pick a stage and run it, or drag the card into{' '}
          {pr.tab === 'reviews' ? 'Reviewing' : 'Addressing'}.
        </div>
      )}
    </div>
  )
}
