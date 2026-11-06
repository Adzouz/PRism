import { useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import type { ReviewThread } from '@shared/domain'
import { ErrorText } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { usePrThreads } from '@/lib/api'
import { cn } from '@/lib/utils'

export const threadWhere = (thread: Pick<ReviewThread, 'path' | 'line'>) =>
  `${thread.path}${thread.line ? `:${thread.line}` : ''}`

export function lastComment(thread: ReviewThread) {
  const comment = thread.comments.at(-1)
  return comment ? `@${comment.author}: ${comment.body.replace(/\s+/g, ' ').trim()}` : ''
}

function ThreadRow({
  thread,
  checked,
  onToggle,
}: {
  thread: ReviewThread
  checked: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring',
        !checked && 'opacity-60',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border',
          checked && 'border-primary bg-primary text-primary-foreground',
        )}
      >
        {checked && <Check className="size-3" />}
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex items-center gap-1.5 text-xs">
          <span className="truncate font-mono text-muted-foreground">{threadWhere(thread)}</span>
          {thread.isOutdated && <Badge className="px-1.5 py-0 text-[10px]">outdated</Badge>}
          {thread.isResolved && <Badge className="px-1.5 py-0 text-[10px]">resolved</Badge>}
          <span className="ml-auto shrink-0 text-muted-foreground">{thread.totalComments}</span>
        </span>
        <span className="line-clamp-2 text-sm">{lastComment(thread)}</span>
      </span>
    </button>
  )
}

export function ThreadPicker({
  prId,
  selected,
  onChange,
}: {
  prId: number
  selected: Set<string> | null
  onChange: (next: Set<string>) => void
}) {
  const { data: threads, isLoading, error } = usePrThreads(prId)
  const [showResolved, setShowResolved] = useState(false)
  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading review threads…
      </p>
    )
  }
  if (error) return <ErrorText error={error} />
  const all = threads ?? []
  const open = all.filter((thread) => !thread.isResolved)
  const resolved = all.filter((thread) => thread.isResolved)
  const chosen = selected ?? new Set(open.map((thread) => thread.id))
  const toggle = (id: string) => {
    const next = new Set(chosen)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(next)
  }
  if (all.length === 0) {
    return <p className="text-sm text-muted-foreground">No review threads on this pull request.</p>
  }
  const visible = showResolved ? [...open, ...resolved] : open
  return (
    <div className="rounded-xl border">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <span>
          {chosen.size} of {open.length} open thread{open.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          className="ml-auto rounded px-1 hover:text-foreground"
          onClick={() => onChange(new Set(open.map((thread) => thread.id)))}
        >
          All open
        </button>
        <button
          type="button"
          className="rounded px-1 hover:text-foreground"
          onClick={() => onChange(new Set())}
        >
          None
        </button>
        {resolved.length > 0 && (
          <button
            type="button"
            className="rounded px-1 hover:text-foreground"
            aria-pressed={showResolved}
            onClick={() => setShowResolved(!showResolved)}
          >
            {showResolved ? 'Hide' : 'Show'} resolved ({resolved.length})
          </button>
        )}
      </div>
      <div className="max-h-64 space-y-0.5 overflow-y-auto p-1">
        {visible.length === 0 && (
          <p className="px-2.5 py-2 text-sm text-muted-foreground">No open threads.</p>
        )}
        {visible.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            checked={chosen.has(thread.id)}
            onToggle={() => toggle(thread.id)}
          />
        ))}
      </div>
    </div>
  )
}
