import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Loader2, ShieldAlert, Wrench } from 'lucide-react'
import type { RunEvent } from '@shared/domain'
import { ErrorText } from '@/components/page'
import { useRunEvents } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Loading, Markdown, statusLabel } from './parts'

const str = (value: unknown) => (typeof value === 'string' ? value : '')

const followThreshold = 48

function scrollParent(node: HTMLElement | null) {
  for (let element = node?.parentElement ?? null; element; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element)
    if (overflowY === 'auto' || overflowY === 'scroll') return element
  }
  return null
}

const atBottom = (element: HTMLElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight <= followThreshold

function toolLabel(name: string, input: unknown) {
  const short = name.replace(/^mcp__prism__/, '').replace(/^mcp__/, '')
  const args = (input ?? {}) as Record<string, unknown>
  const detail =
    str(args.command) ||
    str(args.file_path) ||
    str(args.pattern) ||
    str(args.url) ||
    str(args.label)
  return { short, detail }
}

function ToolStatus({ result, live }: { result: RunEvent | undefined; live: boolean }) {
  if (result?.payload.ok === false) {
    return <span className="ml-auto shrink-0 font-medium text-destructive">failed</span>
  }
  if (result) {
    return (
      <span className="ml-auto size-1.5 shrink-0 rounded-full bg-success">
        <span className="sr-only">succeeded</span>
      </span>
    )
  }
  if (live) {
    return (
      <span className="ml-auto shrink-0">
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        <span className="sr-only">running</span>
      </span>
    )
  }
  return <span className="ml-auto shrink-0 text-muted-foreground">no result</span>
}

function ToolCall({
  event,
  result,
  live,
}: {
  event: RunEvent
  result: RunEvent | undefined
  live: boolean
}) {
  const [open, setOpen] = useState(false)
  const { short, detail } = toolLabel(str(event.payload.name), event.payload.input)
  const failed = result?.payload.ok === false
  return (
    <div className="rounded-lg border bg-surface text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{short}</span>
        <span className="truncate font-mono text-muted-foreground">{detail}</span>
        <ToolStatus result={result} live={live} />
      </button>
      {open && (
        <div className="space-y-2 border-t px-2.5 py-2">
          <pre className="max-h-48 overflow-auto font-mono text-[11px] whitespace-pre-wrap select-text">
            {JSON.stringify(event.payload.input, null, 2)}
          </pre>
          {result && (
            <pre
              className={cn(
                'max-h-64 overflow-auto rounded-md bg-secondary/60 p-2 font-mono text-[11px] whitespace-pre-wrap select-text',
                failed && 'text-destructive',
              )}
            >
              {str(result.payload.text) || '(no output)'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

const Line = memo(function Line({
  event,
  result,
  live,
}: {
  event: RunEvent
  result: RunEvent | undefined
  live: boolean
}) {
  const time = new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  switch (event.kind) {
    case 'text':
      return <Markdown text={str(event.payload.text)} />
    case 'tool':
      return <ToolCall event={event} result={result} live={live} />
    case 'progress':
      return (
        <p className="text-xs font-medium text-primary">
          <span className="text-muted-foreground">{time}</span> · {str(event.payload.label)}
        </p>
      )
    case 'status':
      return (
        <p className="text-xs text-muted-foreground">
          {time} ·{' '}
          {statusLabel[event.payload.status as keyof typeof statusLabel] ??
            str(event.payload.status)}
          {str(event.payload.error) && (
            <span className="text-destructive"> · {str(event.payload.error)}</span>
          )}
        </p>
      )
    case 'ask':
      return (
        <p className="rounded-lg bg-warning/10 px-2.5 py-1.5 text-sm">
          <span className="font-medium">Question:</span> {str(event.payload.question)}
        </p>
      )
    case 'message':
      return (
        <p className="ml-8 rounded-lg bg-accent px-2.5 py-1.5 text-sm text-accent-foreground select-text">
          {str(event.payload.text)}
        </p>
      )
    case 'answer':
      return (
        <p className="ml-8 rounded-lg bg-accent px-2.5 py-1.5 text-sm text-accent-foreground">
          {str(event.payload.answer)}
        </p>
      )
    case 'denied':
      return (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <ShieldAlert className="size-3.5" />
          Blocked {str(event.payload.tool)}: {str(event.payload.reason)}
        </p>
      )
    case 'error':
      return <p className="text-xs text-destructive">{str(event.payload.message)}</p>
    case 'note':
      return (
        <p className="font-mono text-[11px] text-muted-foreground">{str(event.payload.text)}</p>
      )
    default:
      return null
  }
})

export function Transcript({ runId, live }: { runId: number; live: boolean }) {
  const { data: events, isLoading, error } = useRunEvents(runId)
  const root = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const results = useMemo(
    () =>
      new Map(
        (events ?? [])
          .filter((event) => event.kind === 'tool_result')
          .map((event) => [str(event.payload.id), event]),
      ),
    [events],
  )
  const visible = useMemo(
    () => (events ?? []).filter((event) => event.kind !== 'tool_result' && event.kind !== 'result'),
    [events],
  )
  const turnStart = useMemo(
    () => (events ?? []).findLast((event) => event.kind === 'status')?.id ?? 0,
    [events],
  )
  const count = events?.length ?? 0

  useEffect(() => {
    const container = scrollParent(root.current)
    if (!container) return
    const onScroll = () => {
      follow.current = atBottom(container)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [])

  useLayoutEffect(() => {
    if (!live || !follow.current || count === 0) return
    const container = scrollParent(root.current)
    container?.scrollTo({ top: container.scrollHeight })
  }, [count, live])

  return (
    <div ref={root} className="space-y-2">
      {isLoading ? (
        <Loading>Loading transcript…</Loading>
      ) : error && !events ? (
        <ErrorText error={error} />
      ) : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet.</p>
      ) : (
        visible.map((event) => (
          <Line
            key={event.id}
            event={event}
            result={event.kind === 'tool' ? results.get(str(event.payload.id)) : undefined}
            live={event.kind === 'tool' && live && event.id > turnStart}
          />
        ))
      )}
    </div>
  )
}
