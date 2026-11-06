import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Loader2, ShieldAlert, Wrench } from 'lucide-react'
import type { RunEvent } from '@shared/domain'
import { useRunEvents } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Markdown, statusLabel } from './parts'

const str = (value: unknown) => (typeof value === 'string' ? value : '')

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

function ToolCall({ event, result }: { event: RunEvent; result: RunEvent | undefined }) {
  const [open, setOpen] = useState(false)
  const { short, detail } = toolLabel(str(event.payload.name), event.payload.input)
  const failed = result && result.payload.ok === false
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
        {!result ? (
          <Loader2 className="ml-auto size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <span
            className={cn(
              'ml-auto size-1.5 shrink-0 rounded-full',
              failed ? 'bg-destructive' : 'bg-success',
            )}
          />
        )}
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

function Line({ event, results }: { event: RunEvent; results: Map<string, RunEvent> }) {
  const time = new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  switch (event.kind) {
    case 'text':
      return <Markdown text={str(event.payload.text)} />
    case 'tool':
      return <ToolCall event={event} result={results.get(str(event.payload.id))} />
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
}

export function Transcript({ runId, live }: { runId: number; live: boolean }) {
  const { data: events, isLoading } = useRunEvents(runId)
  const end = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const results = new Map(
    (events ?? [])
      .filter((event) => event.kind === 'tool_result')
      .map((event) => [str(event.payload.id), event]),
  )
  const count = events?.length ?? 0

  useEffect(() => {
    if (live && follow.current && count > 0) end.current?.scrollIntoView({ block: 'end' })
  }, [count, live])

  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading transcript…
      </p>
    )
  }
  const visible = (events ?? []).filter(
    (event) => event.kind !== 'tool_result' && event.kind !== 'result',
  )
  return (
    <div
      className="space-y-2"
      onWheel={(event) => {
        if (event.deltaY < 0) follow.current = false
      }}
    >
      {visible.length === 0 && <p className="text-sm text-muted-foreground">Nothing yet.</p>}
      {visible.map((event) => (
        <Line key={event.id} event={event} results={results} />
      ))}
      <div ref={end} />
    </div>
  )
}
