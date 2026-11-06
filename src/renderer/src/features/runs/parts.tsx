import { useState, type FormEvent } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleX,
  Loader2,
  MessageCircleQuestion,
  Send,
} from 'lucide-react'
import type { Ask, ReviewReport, RunStatus } from '@shared/domain'
import { ErrorText } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAnswer } from '@/lib/api'
import { cn } from '@/lib/utils'

export const statusLabel: Record<RunStatus, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  running: 'Running',
  needs_you: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const statusTone: Record<RunStatus, 'default' | 'accent' | 'success' | 'warning' | 'destructive'> =
  {
    queued: 'default',
    preparing: 'default',
    running: 'accent',
    needs_you: 'warning',
    done: 'success',
    failed: 'destructive',
    cancelled: 'default',
  }

export const isLive = (status: RunStatus) =>
  status === 'queued' || status === 'preparing' || status === 'running'

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const Icon = isLive(status)
    ? Loader2
    : status === 'needs_you'
      ? MessageCircleQuestion
      : status === 'done'
        ? CircleCheck
        : status === 'failed'
          ? CircleAlert
          : status === 'cancelled'
            ? CircleX
            : CircleDot
  return (
    <Badge variant={statusTone[status]}>
      <Icon className={cn(isLive(status) && 'animate-spin')} />
      {statusLabel[status]}
    </Badge>
  )
}

export const verdictLabel: Record<ReviewReport['verdict'], string> = {
  approve: 'Approve',
  comment: 'Comment',
  request_changes: 'Request changes',
}

export const verdictTone: Record<ReviewReport['verdict'], 'success' | 'default' | 'destructive'> = {
  approve: 'success',
  comment: 'default',
  request_changes: 'destructive',
}

const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('markdown-body select-text', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

export function AnswerForm({ ask, compact = false }: { ask: Ask; compact?: boolean }) {
  const [text, setText] = useState('')
  const answer = useAnswer()
  const send = (value: string) => {
    if (!value.trim() || answer.isPending) return
    answer.mutate({ askId: ask.id, answer: value.trim() }, { onSuccess: () => setText('') })
  }
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    send(text)
  }
  return (
    <form
      onSubmit={onSubmit}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      className="space-y-2"
    >
      <p className={cn('font-medium select-text', compact ? 'text-xs' : 'text-sm')}>{ask.prompt}</p>
      {ask.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {ask.options.map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant="outline"
              className={cn(compact && 'h-6 px-2 text-xs')}
              disabled={answer.isPending}
              onClick={() => send(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              send(text)
            }
          }}
          rows={compact ? 1 : 2}
          aria-label="Your answer"
          placeholder={
            ask.placeholder ?? (ask.options.length ? 'Or write an answer…' : 'Your answer…')
          }
          className="min-h-8 flex-1 resize-none rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button
          type="submit"
          size="icon"
          className="size-8"
          aria-label="Send answer"
          disabled={!text.trim() || answer.isPending}
        >
          {answer.isPending ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </div>
      <ErrorText error={answer.error} />
    </form>
  )
}
