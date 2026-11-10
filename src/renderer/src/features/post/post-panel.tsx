import { useState, type FormEvent, type ReactNode } from 'react'
import {
  ArrowUpRight,
  Check,
  CircleCheck,
  CircleX,
  GitCommitHorizontal,
  Inbox,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Upload,
} from 'lucide-react'
import {
  findingComment,
  gateKindOf,
  postModeLabels,
  stageLabels,
  type BoardPr,
  type Finding,
  type GateCheck,
  type GateReply,
  type PostGate,
  type PostMode,
  type ReviewThread,
  type Run,
} from '@shared/domain'
import { ErrorText } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  useCommit,
  useGate,
  usePost,
  usePrRuns,
  usePrThreads,
  usePush,
  useRunFindings,
  useSkipPost,
  useUpdateFinding,
  useUpdateGate,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { age, useBoardStore, useNow } from '../board/model'
import { Loading, Markdown, verdictLabel } from '../runs/parts'
import { Heading, severityOrder, severityTone, ThreadContext } from '../runs/runs-panel'

type Verdict = PostGate['event']

const events: Verdict[] = ['approve', 'comment', 'request_changes']
const modes: PostMode[] = ['draft', 'submit']

const short = (oid: string | null) => (oid ? oid.slice(0, 7) : '—')

const ago = (from: number, now: number) => {
  const value = age(from, now)
  return value === 'now' ? 'just now' : `${value} ago`
}

function Checkbox({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        checked && 'border-primary bg-primary text-primary-foreground',
      )}
    >
      {checked && <Check className="size-3" />}
    </button>
  )
}

function BlurText({
  value,
  onSave,
  label,
  placeholder,
  rows = 4,
  disabled,
}: {
  value: string
  onSave: (value: string) => void
  label: string
  placeholder?: string
  rows?: number
  disabled?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const [base, setBase] = useState(value)
  if (value !== base) {
    setBase(value)
    setDraft(value)
  }
  return (
    <Textarea
      aria-label={label}
      value={draft}
      rows={rows}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
      className="min-h-0 resize-y font-sans"
    />
  )
}

function CheckRow({
  check,
  action,
  children,
}: {
  check: GateCheck
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <li className="flex flex-wrap items-start gap-2.5 py-1.5">
      {check.ok ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
      ) : (
        <CircleX className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm', !check.ok && 'font-medium')}>{check.label}</p>
        {check.detail && <p className="text-xs text-muted-foreground">{check.detail}</p>}
      </div>
      {action}
      {children && <div className="w-full pl-6.5">{children}</div>}
    </li>
  )
}

function Checklist({ gate }: { gate: PostGate }) {
  const update = useUpdateGate()
  const push = usePush()
  const busy = update.isPending || push.isPending || gate.live
  const actionFor = (check: GateCheck): ReactNode => {
    if (check.key === 'findings' && gate.confirmedAt === null) {
      return (
        <Button
          size="sm"
          className="h-7"
          disabled={busy}
          onClick={() => update.mutate({ runId: gate.runId, confirmed: true })}
        >
          <Check />
          Confirm findings
        </Button>
      )
    }
    if (check.key === 'push' && !check.ok && gate.worktree && gate.worktree.dirty.length === 0) {
      return (
        <Button size="sm" className="h-7" disabled={busy} onClick={() => push.mutate(gate.runId)}>
          {push.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
          Push
        </Button>
      )
    }
    return null
  }
  return (
    <section className="space-y-1">
      <ul className="divide-y rounded-xl border px-3">
        {gate.checks.map((check) => (
          <CheckRow key={check.key} check={check} action={actionFor(check)}>
            {check.key === 'commit' && !check.ok && gate.worktree && (
              <CommitForm gate={gate} busy={busy} />
            )}
          </CheckRow>
        ))}
      </ul>
      <ErrorText error={update.error ?? push.error} />
    </section>
  )
}

function FindingRow({ finding, gate }: { finding: Finding; gate: PostGate }) {
  const [editing, setEditing] = useState(false)
  const update = useUpdateFinding(gate.runId)
  const original = findingComment(finding)
  const text = finding.editedBody ?? original
  const locked = finding.posted || gate.live
  return (
    <li className={cn('space-y-2 rounded-xl border p-3', !finding.included && 'opacity-60')}>
      <div className="flex items-start gap-2.5">
        <Checkbox
          checked={finding.included}
          disabled={locked || update.isPending}
          label={`Include ${finding.title}`}
          onChange={(included) => update.mutate({ id: finding.id, included })}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 text-xs">
            <Badge variant={severityTone[finding.severity]}>{finding.severity}</Badge>
            <span className="truncate font-mono text-muted-foreground select-text">
              {finding.path}
              {finding.line ? `:${finding.line}` : ''}
            </span>
            {finding.posted && <Badge variant="success">Posted</Badge>}
            {finding.editedBody !== null && !finding.posted && <Badge>Edited</Badge>}
          </div>
          {!editing && <Markdown text={text} />}
        </div>
        {!locked && (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={editing ? 'Done editing' : `Edit ${finding.title}`}
            onClick={() => setEditing(!editing)}
          >
            {editing ? <Check /> : <Pencil />}
          </Button>
        )}
      </div>
      {editing && (
        <div className="space-y-1.5">
          <BlurText
            label={`Comment for ${finding.title}`}
            value={text}
            rows={6}
            onSave={(value) =>
              update.mutate({ id: finding.id, editedBody: value === original ? null : value })
            }
          />
          {finding.editedBody !== null && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              onClick={() => update.mutate({ id: finding.id, editedBody: null })}
            >
              <RotateCcw />
              Reset to the agent's text
            </Button>
          )}
        </div>
      )}
      <ErrorText error={update.error} />
    </li>
  )
}

function ReviewSection({ gate, run }: { gate: PostGate; run: Run }) {
  const update = useUpdateGate()
  const { data: findings } = useRunFindings(run.id)
  const sorted = [...(findings ?? [])].sort(
    (a, b) => severityOrder.indexOf(a.severity) - severityOrder.indexOf(b.severity),
  )
  const ownPr = gate.allowedEvents.length === 1
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <Heading>Post as</Heading>
        <ToggleGroup
          type="single"
          value={gate.mode}
          onValueChange={(value) =>
            value && update.mutate({ runId: gate.runId, mode: value as PostMode })
          }
          aria-label="Post mode"
        >
          {modes.map((mode) => (
            <ToggleGroupItem key={mode} value={mode}>
              {postModeLabels[mode]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {gate.modeFromRepo && (
          <p className="text-xs text-muted-foreground">Default for this repository</p>
        )}
      </section>
      {gate.mode === 'submit' && (
        <section className="space-y-2">
          <Heading>Review status</Heading>
          <ToggleGroup
            type="single"
            value={gate.event}
            onValueChange={(value) =>
              value && update.mutate({ runId: gate.runId, event: value as Verdict })
            }
            aria-label="Review status"
          >
            {events.map((event) => (
              <ToggleGroupItem
                key={event}
                value={event}
                disabled={!gate.allowedEvents.includes(event)}
              >
                {verdictLabel[event]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {ownPr && (
            <p className="text-xs text-muted-foreground">
              GitHub only lets you comment on your own pull request.
            </p>
          )}
        </section>
      )}
      <section className="space-y-2">
        <Heading>Summary</Heading>
        <BlurText
          label="Review summary"
          value={gate.body}
          placeholder="Optional summary for the review body"
          onSave={(body) => update.mutate({ runId: gate.runId, body })}
        />
      </section>
      <section className="space-y-2">
        <Heading>
          Findings · {gate.findings.included} of {gate.findings.total}
        </Heading>
        {sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No findings in this run.</p>
        ) : (
          <ul className="space-y-2">
            {sorted.map((finding) => (
              <FindingRow key={finding.id} finding={finding} gate={gate} />
            ))}
          </ul>
        )}
      </section>
      <ErrorText error={update.error} />
    </div>
  )
}

function AddressSection({ gate }: { gate: PostGate }) {
  const worktree = gate.worktree
  if (!worktree) return null
  return (
    <section className="space-y-3">
      <Heading>Changes</Heading>
      {worktree.dirty.length > 0 ? (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-xl border p-2.5 font-mono text-xs select-text">
          {worktree.dirty.map((file) => (
            <li key={file} className="truncate">
              {file}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing left to commit.</p>
      )}
      <p className="flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground">
        {worktree.branch && <span>{worktree.branch}</span>}
        <span>local {short(worktree.localHead)}</span>
        <span>GitHub {short(worktree.remoteHead)}</span>
      </p>
    </section>
  )
}

function CommitForm({ gate, busy }: { gate: PostGate; busy: boolean }) {
  const [message, setMessage] = useState(gate.commitMessage)
  const commit = useCommit()
  const send = (event: FormEvent) => {
    event.preventDefault()
    if (message.trim()) commit.mutate({ runId: gate.runId, message: message.trim() })
  }
  return (
    <form onSubmit={send} className="space-y-1.5 pt-1.5">
      <div className="flex gap-1.5">
        <Input
          aria-label="Commit message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          className="h-8 font-mono text-xs"
        />
        <Button
          size="sm"
          type="submit"
          className="h-8"
          disabled={busy || commit.isPending || !message.trim()}
        >
          {commit.isPending ? <Loader2 className="animate-spin" /> : <GitCommitHorizontal />}
          Commit
        </Button>
      </div>
      <ErrorText error={commit.error} />
    </form>
  )
}

function ReplyRow({
  reply,
  thread,
  gate,
}: {
  reply: GateReply
  thread: ReviewThread | undefined
  gate: PostGate
}) {
  const update = useUpdateGate()
  const save = (patch: Partial<Pick<GateReply, 'body' | 'selected'>>) =>
    update.mutate({
      runId: gate.runId,
      replies: [{ threadId: reply.threadId, body: reply.body, selected: reply.selected, ...patch }],
    })
  return (
    <li className={cn('rounded-xl border p-3', !reply.selected && 'opacity-60')}>
      <div className="flex items-start gap-2.5">
        <Checkbox
          checked={reply.selected}
          disabled={Boolean(reply.postedUrl) || gate.live}
          label="Answer this thread"
          onChange={(selected) => save({ selected })}
        />
        <div className="min-w-0 flex-1 space-y-1.5">
          <ThreadContext thread={thread} id={reply.threadId} />
          {reply.postedUrl ? (
            <a
              href={reply.postedUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Posted
              <ArrowUpRight className="size-3" />
            </a>
          ) : (
            <BlurText
              label="Reply"
              value={reply.body}
              rows={3}
              placeholder="Write a reply"
              disabled={gate.live}
              onSave={(body) => save({ body })}
            />
          )}
        </div>
      </div>
      <ErrorText error={update.error} />
    </li>
  )
}

function RepliesSection({ gate }: { gate: PostGate }) {
  const { data: threads } = usePrThreads(gate.prId)
  const byId = new Map((threads ?? []).map((thread) => [thread.id, thread]))
  if (gate.replies.length === 0) return null
  return (
    <section className="space-y-2">
      <Heading>Replies</Heading>
      <ul className="space-y-2">
        {gate.replies.map((reply) => (
          <ReplyRow
            key={reply.threadId}
            reply={reply}
            thread={byId.get(reply.threadId)}
            gate={gate}
          />
        ))}
      </ul>
    </section>
  )
}

function postLabel(gate: PostGate) {
  if (gate.kind === 'review')
    return gate.mode === 'submit' ? 'Submit review' : 'Stage pending review'
  const count = gate.replies.filter((reply) => reply.selected && !reply.postedUrl).length
  return `Post ${count} repl${count === 1 ? 'y' : 'ies'}`
}

function Closed({ gate }: { gate: PostGate }) {
  const skip = useSkipPost()
  const now = useNow()
  const posted = gate.replies.filter((reply) => reply.postedUrl)
  if (gate.skippedAt !== null) {
    return (
      <div className="space-y-3 rounded-xl border p-4">
        <p className="text-sm">Posting skipped {ago(gate.skippedAt, now)}.</p>
        <Button
          size="sm"
          variant="outline"
          disabled={skip.isPending}
          onClick={() => skip.mutate({ runId: gate.runId, skipped: false })}
        >
          <RotateCcw />
          Undo
        </Button>
        <ErrorText error={skip.error} />
      </div>
    )
  }
  return (
    <div className="space-y-3 rounded-xl border border-success/40 bg-success/5 p-4">
      <p className="flex items-center gap-2 text-sm font-medium">
        <CircleCheck className="size-4 text-success" />
        {gate.kind === 'review'
          ? `${gate.mode === 'submit' ? 'Review submitted' : 'Pending review staged'} with ${gate.findings.included} finding${gate.findings.included === 1 ? '' : 's'}`
          : `${posted.length} repl${posted.length === 1 ? 'y' : 'ies'} posted`}
        <span className="font-normal text-muted-foreground">· {ago(gate.postedAt!, now)}</span>
      </p>
      {gate.kind === 'review' && gate.mode === 'draft' && (
        <p className="text-sm text-muted-foreground">
          Open it on GitHub to pick the status and submit it.
        </p>
      )}
      {gate.reviewUrl && (
        <Button size="sm" variant="outline" asChild>
          <a href={gate.reviewUrl} target="_blank" rel="noreferrer">
            <ArrowUpRight />
            Open on GitHub
          </a>
        </Button>
      )}
      {posted.length > 0 && (
        <ul className="space-y-1 text-sm">
          {posted.map((reply) => (
            <li key={reply.threadId}>
              <a
                href={reply.postedUrl!}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Reply on thread
                <ArrowUpRight className="size-3" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Gate({ run }: { run: Run }) {
  const { data: gate, error, isLoading, refetch, isFetching } = useGate(run.id)
  const post = usePost()
  const skip = useSkipPost()
  if (isLoading) return <Loading>Checking what is ready to post…</Loading>
  if (!gate) return <ErrorText error={error} />
  const closed = gate.postedAt !== null || gate.skippedAt !== null
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{stageLabels[run.stage]}</span>
        {run.report && run.stage !== 'draft-replies' && (
          <span className="text-muted-foreground">· {verdictLabel[run.report.verdict]}</span>
        )}
        {!closed && (
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto size-7"
            aria-label="Check again"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            <RefreshCw className={cn(isFetching && 'animate-spin')} />
          </Button>
        )}
      </div>
      {closed ? (
        <Closed gate={gate} />
      ) : (
        <>
          {gate.live && (
            <p className="text-sm text-warning">
              An agent run is in progress on this pull request. Actions unlock when it ends.
            </p>
          )}
          {gate.warning && <p className="text-sm text-warning select-text">{gate.warning}</p>}
          <Checklist gate={gate} />
          {gate.kind === 'review' && <ReviewSection gate={gate} run={run} />}
          {gate.kind === 'address' && <AddressSection gate={gate} />}
          {gate.kind !== 'review' && <RepliesSection gate={gate} />}
          {run.changes?.summary && gate.kind === 'address' && (
            <section className="space-y-2">
              <Heading>Agent summary</Heading>
              <Markdown text={run.changes.summary} />
            </section>
          )}
          <div className="sticky bottom-0 -mx-6 space-y-2 border-t bg-background px-6 py-3">
            <div className="flex items-center gap-2">
              <Button disabled={!gate.ready || post.isPending} onClick={() => post.mutate(run.id)}>
                {post.isPending ? <Loader2 className="animate-spin" /> : <Send />}
                {postLabel(gate)}
              </Button>
              <Button
                variant="ghost"
                disabled={skip.isPending || post.isPending}
                onClick={() => skip.mutate({ runId: run.id, skipped: true })}
              >
                Skip posting
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              PRism adds an AI tag line to everything it posts.
            </p>
            <ErrorText error={post.error ?? skip.error} />
          </div>
        </>
      )}
    </div>
  )
}

export const gateRuns = (runs: Run[]) =>
  runs.filter((run) => run.status === 'done' && gateKindOf[run.stage] !== undefined)

export function PostPanel({ pr }: { pr: BoardPr }) {
  const { data: runs, isLoading, error } = usePrRuns(pr.id)
  const openRunId = useBoardStore((state) => state.openRunId)
  const selectRun = useBoardStore((state) => state.selectRun)
  const now = useNow()
  if (isLoading) return <Loading>Loading runs…</Loading>
  if (!runs) return <ErrorText error={error} />
  const candidates = gateRuns(runs)
  const run =
    candidates.find((item) => item.id === openRunId) ??
    candidates.find((item) => item.dismissedAt === null) ??
    candidates[0] ??
    null
  if (!run) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
        <Inbox className="size-6" />
        Nothing to post yet. Finished review, address and draft-replies runs show up here.
      </div>
    )
  }
  return (
    <div className="space-y-5">
      {candidates.length > 1 && (
        <div role="group" aria-label="Run to post" className="flex flex-wrap gap-1">
          {candidates.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={item.id === run.id}
              onClick={() => selectRun(item.id)}
              className={cn(
                'rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring',
                item.id === run.id && 'bg-secondary font-medium text-foreground shadow-sm',
              )}
            >
              {stageLabels[item.stage]} · {age(item.createdAt, now)}
            </button>
          ))}
        </div>
      )}
      <Gate key={run.id} run={run} />
    </div>
  )
}
