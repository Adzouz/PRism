import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type TimelineTone = 'open' | 'done' | 'muted' | 'live' | 'failed'

export const toneText: Record<TimelineTone, string> = {
  open: 'text-primary',
  done: 'text-success',
  muted: 'text-muted-foreground',
  live: 'text-warning',
  failed: 'text-destructive',
}

const toneDot: Record<TimelineTone, string> = {
  open: 'border-primary bg-primary/30',
  done: 'border-success bg-success/30',
  muted: 'border-muted-foreground/50',
  live: 'animate-pulse border-warning bg-warning/30',
  failed: 'border-destructive bg-destructive/30',
}

export type TimelineItem = { id: number; tone: TimelineTone; title: ReactNode }

export function Timeline({
  label,
  items,
  selectedId,
  onSelect,
  children,
}: {
  label: string
  items: TimelineItem[]
  selectedId: number | null
  onSelect: (id: number) => void
  children: ReactNode
}) {
  return (
    <ol aria-label={label} className="space-y-3">
      {items.map((item, index) => (
        <li key={item.id} className="relative pl-7">
          {index < items.length - 1 && (
            <span aria-hidden className="absolute top-5 -bottom-5 left-[7px] w-px bg-border" />
          )}
          <span
            aria-hidden
            className={cn(
              'absolute top-2 left-0.5 size-3 rounded-full border-2 bg-background',
              toneDot[item.tone],
            )}
          />
          {item.id === selectedId ? (
            children
          ) : (
            <button
              type="button"
              aria-expanded={false}
              onClick={() => onSelect(item.id)}
              className="-mx-2 flex min-h-7 w-[calc(100%+1rem)] flex-wrap items-center gap-x-2 rounded-md px-2 text-left text-sm outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.title}
            </button>
          )}
        </li>
      ))}
    </ol>
  )
}
