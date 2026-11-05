import { useCallback, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import { Bot, GitPullRequest, Loader2 } from 'lucide-react'
import { boardColumns, type BoardColumn, type BoardPr, type BoardTab } from '@shared/domain'
import { EmptyState } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { useSetFlags, useSetStage, usePrs } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CardPreview, PrCard, type CardActions } from './card'
import { boardView, useBoardStore, useNow, type Density } from './model'
import { Toolbar } from './toolbar'

const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args)
  return hits.length > 0 ? hits : rectIntersection(args)
}

const columnJump: KeyboardCoordinateGetter = (event, { context }) => {
  const { collisionRect, droppableRects, droppableContainers } = context
  if (!collisionRect) return undefined
  const direction = { ArrowRight: 1, ArrowLeft: -1 }[event.code]
  if (!direction) {
    if (event.code === 'ArrowUp' || event.code === 'ArrowDown') event.preventDefault()
    return undefined
  }
  event.preventDefault()
  const rects = droppableContainers
    .getEnabled()
    .flatMap((container) => {
      const rect = droppableRects.get(container.id)
      return rect ? [rect] : []
    })
    .sort((a, b) => a.left - b.left)
  const center = collisionRect.left + collisionRect.width / 2
  const current = rects.findIndex((rect) => center >= rect.left && center <= rect.left + rect.width)
  const target =
    current === -1
      ? rects.find((rect) => (direction > 0 ? rect.left > center : rect.left < center))
      : rects[current + direction]
  if (!target) return undefined
  return {
    x: target.left + (target.width - collisionRect.width) / 2,
    y: Math.max(target.top + 48, collisionRect.top),
  }
}

function Column({
  tab,
  column,
  prs,
  now,
  density,
  actions,
}: {
  tab: BoardTab
  column: BoardColumn
  prs: BoardPr[]
  now: number
  density: Density
  actions: CardActions
}) {
  const disabled = Boolean(column.agent)
  const { setNodeRef, isOver, active } = useDroppable({ id: column.stage, disabled })
  const fromHere = (active?.data.current?.pr as BoardPr | undefined)?.stage === column.stage
  return (
    <section
      ref={setNodeRef}
      aria-label={column.label}
      className={cn(
        'flex w-72 shrink-0 flex-col gap-2 rounded-2xl bg-secondary/50 p-2 transition-colors',
        active && !disabled && !fromHere && 'bg-accent/50',
        isOver && !disabled && !fromHere && 'bg-accent ring-2 ring-primary/40',
        active && disabled && 'opacity-50',
      )}
    >
      <header className="flex h-8 items-center gap-2 px-2">
        <h3 className="text-sm font-medium">{column.label}</h3>
        <span className="font-mono text-xs text-muted-foreground">{prs.length}</span>
        {column.agent && <Bot className="ml-auto size-3.5 text-muted-foreground" />}
        {column.needsMe && !column.agent && prs.length > 0 && (
          <Badge variant="accent" className="ml-auto">
            Needs you
          </Badge>
        )}
      </header>
      <div className="flex flex-col gap-2">
        {prs.map((pr) => (
          <PrCard key={pr.id} pr={pr} now={now} density={density} actions={actions} />
        ))}
        {prs.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {column.agent ? 'Agent runs land here' : tab === 'reviews' ? 'Nothing here' : 'Empty'}
          </p>
        )}
      </div>
    </section>
  )
}

export function Board({ tab }: { tab: BoardTab }) {
  const { data: prs, isLoading } = usePrs()
  const filters = useBoardStore((state) => state.filters[tab])
  const density = useBoardStore((state) => state.density)
  const openPr = useBoardStore((state) => state.openPr)
  const now = useNow()
  const setFlags = useSetFlags()
  const setStage = useSetStage()
  const [dragging, setDragging] = useState<BoardPr | null>(null)
  const justDropped = useRef(false)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: columnJump,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  )

  const view = useMemo(() => boardView(prs ?? [], tab, filters), [prs, tab, filters])
  const repoIds = useMemo(
    () => [
      ...new Map((prs ?? []).filter((pr) => pr.tab === tab).map((pr) => [pr.repoId, pr.repo])),
    ],
    [prs, tab],
  )

  const { mutate: flag } = setFlags
  const { mutate: stage } = setStage
  const actions = useMemo<CardActions>(
    () => ({
      open: (pr) => {
        if (!justDropped.current) openPr(pr.id)
      },
      star: (pr) => flag({ id: pr.id, starred: !pr.starred }),
      hide: (pr) => flag({ id: pr.id, hidden: !pr.hidden }),
      archive: (pr) => flag({ id: pr.id, archived: true }),
      move: (pr, target) => stage({ id: pr.id, stage: target }),
    }),
    [flag, stage, openPr],
  )

  const onDragStart = useCallback((event: DragStartEvent) => {
    setDragging((event.active.data.current?.pr as BoardPr | undefined) ?? null)
  }, [])

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragging(null)
      justDropped.current = true
      setTimeout(() => {
        justDropped.current = false
      }, 0)
      const pr = event.active.data.current?.pr as BoardPr | undefined
      const target = event.over?.id
      if (!pr || typeof target !== 'string' || target === pr.stage) return
      const column = boardColumns[tab].find((item) => item.stage === target)
      if (!column || column.agent) return
      stage({ id: pr.id, stage: column.stage })
    },
    [stage, tab],
  )

  const announcements = useMemo(
    () => ({
      onDragStart: ({ active }: { active: { data: { current?: Record<string, unknown> } } }) =>
        `Picked up #${(active.data.current?.pr as BoardPr | undefined)?.number}. Use left and right arrows to change column, space to drop.`,
      onDragOver: ({ over }: { over: { id: string | number } | null }) =>
        over
          ? `Over ${boardColumns[tab].find((c) => c.stage === over.id)?.label ?? over.id}`
          : 'Not over a column',
      onDragEnd: ({ over }: { over: { id: string | number } | null }) =>
        over
          ? `Moved to ${boardColumns[tab].find((c) => c.stage === over.id)?.label ?? over.id}`
          : 'Dropped',
      onDragCancel: () => 'Move cancelled',
    }),
    [tab],
  )

  const tabTotal = (prs ?? []).filter((pr) => pr.tab === tab && pr.archivedAt === null).length

  return (
    <div className="space-y-5">
      <Toolbar tab={tab} repos={repoIds} hiddenCount={view.hiddenCount} />
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading pull requests…
        </div>
      ) : tabTotal === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title={tab === 'reviews' ? 'No reviews yet' : 'No pull requests yet'}
          description={
            tab === 'reviews'
              ? 'Pull requests that request your review show up here after the next sync.'
              : 'Pull requests you author or take over show up here after the next sync.'
          }
        />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
          accessibility={{ announcements }}
          autoScroll={{ threshold: { x: 0.08, y: 0.15 }, acceleration: 6 }}
        >
          <div className="-mx-1 flex items-start gap-3 overflow-x-auto px-1 pb-4">
            {boardColumns[tab].map((column) => (
              <Column
                key={column.stage}
                tab={tab}
                column={column}
                prs={view.byStage.get(column.stage) ?? []}
                now={now}
                density={density}
                actions={actions}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {dragging && <CardPreview pr={dragging} now={now} density={density} />}
          </DragOverlay>
        </DndContext>
      )}
    </div>
  )
}
