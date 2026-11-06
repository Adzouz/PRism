import { useCallback, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core'
import { Bot, GitPullRequest, Loader2 } from 'lucide-react'
import {
  boardColumns,
  type BoardColumn,
  type BoardPr,
  type BoardStage,
  type BoardTab,
  type Stage,
} from '@shared/domain'
import { EmptyState } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
  runStageFor,
  useCancelRun,
  useDismissRun,
  useSetFlags,
  useSetStage,
  useStartRun,
  usePrs,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { CardPreview, PrCard, type CardActions } from './card'
import { boardView, hasLiveRun, stageLabel, useBoardStore, useNow, type Density } from './model'
import { Toolbar } from './toolbar'

const runColumns = new Set<BoardStage>(['reviewing', 'addressing'])

const dropCopy: Record<Stage, { title: string; body: string }> = {
  review: {
    title: 'Start a review run?',
    body: 'Your default agent reviews this pull request in a worktree with the skill bound to Review, then reports a verdict and findings. It only reads and reports: it never commits, pushes or posts.',
  },
  're-review': {
    title: 'Start a re-review run?',
    body: 'Your default agent re-reviews this pull request in a worktree with the skill bound to Re-review, then reports a new verdict. It only reads and reports: it never commits, pushes or posts.',
  },
  address: {
    title: 'Start an address comments run?',
    body: 'Your default agent edits files in a worktree for this pull request to address its unresolved review threads, with the skill bound to Address comments, then reports what it changed. It never commits, pushes or posts.',
  },
  'test-plan': {
    title: 'Start a test plan run?',
    body: 'Your default agent reads this pull request in a worktree with the skill bound to Test plan, then writes how to test it. It never commits, pushes or posts.',
  },
  'draft-replies': {
    title: 'Start a draft replies run?',
    body: 'Your default agent drafts replies to the unresolved review threads with the skill bound to Draft replies. It never posts them.',
  },
}

type Failure = { prId: number; error: unknown }

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
  failure,
}: {
  tab: BoardTab
  column: BoardColumn
  prs: BoardPr[]
  now: number
  density: Density
  actions: CardActions
  failure: Failure | null
}) {
  const { active } = useDndContext()
  const dragged = active?.data.current?.pr as BoardPr | undefined
  const fromHere = dragged?.stage === column.stage
  const disabled = column.agent
    ? !(runColumns.has(column.stage) && dragged && !hasLiveRun(dragged) && dragged.state === 'OPEN')
    : Boolean(dragged && hasLiveRun(dragged) && !fromHere)
  const { setNodeRef, isOver } = useDroppable({ id: column.stage, disabled })
  return (
    <section
      ref={setNodeRef}
      aria-label={column.label}
      className={cn(
        'flex w-72 shrink-0 flex-col gap-2 rounded-2xl bg-secondary/50 p-2 transition-colors',
        dragged && !disabled && !fromHere && 'bg-accent/50',
        isOver && !disabled && !fromHere && 'bg-accent ring-2 ring-primary/40',
        dragged && disabled && 'opacity-50',
      )}
    >
      <header className="flex h-8 items-center gap-2 px-2">
        <h3 className="text-sm font-medium">{column.label}</h3>
        <span className="font-mono text-xs text-muted-foreground">{prs.length}</span>
        {column.agent && column.stage !== 'needs-you' && (
          <Bot className="ml-auto size-3.5 text-muted-foreground" />
        )}
        {column.needsMe && (!column.agent || column.stage === 'needs-you') && prs.length > 0 && (
          <Badge variant="accent" className="ml-auto">
            Needs you
          </Badge>
        )}
      </header>
      <div className="flex flex-col gap-2">
        {prs.map((pr) => (
          <PrCard
            key={pr.id}
            pr={pr}
            now={now}
            density={density}
            actions={actions}
            error={failure?.prId === pr.id ? failure.error : null}
          />
        ))}
        {prs.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {runColumns.has(column.stage)
              ? 'Drop a card here to start a run'
              : column.agent
                ? 'Agent runs land here'
                : tab === 'reviews'
                  ? 'Nothing here'
                  : 'Empty'}
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
  const dropConfirmed = useBoardStore((state) => state.dropConfirmed)
  const confirmDrop = useBoardStore((state) => state.confirmDrop)
  const now = useNow()
  const { mutateAsync: flag } = useSetFlags()
  const { mutateAsync: stage } = useSetStage()
  const { mutateAsync: start } = useStartRun()
  const { mutateAsync: cancel } = useCancelRun()
  const { mutateAsync: dismiss } = useDismissRun()
  const [failure, setFailure] = useState<Failure | null>(null)
  const [pendingDrop, setPendingDrop] = useState<{ pr: BoardPr; column: BoardStage } | null>(null)
  const [drag, setDrag] = useState<{ pr: BoardPr; columns: BoardColumn[] } | null>(null)
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
  const visibleColumns = useMemo(
    () =>
      boardColumns[tab].filter(
        (column) => !column.hideEmpty || (view.byStage.get(column.stage)?.length ?? 0) > 0,
      ),
    [tab, view],
  )

  const track = useCallback((pr: BoardPr, task?: Promise<unknown>) => {
    setFailure(null)
    task?.catch((error: unknown) => setFailure({ prId: pr.id, error }))
  }, [])

  const launch = useCallback(
    (pr: BoardPr, runAs?: Stage, show = false) =>
      track(
        pr,
        start({ prId: pr.id, stage: runAs ?? runStageFor(pr) }).then((run) => {
          if (show) openPr(pr.id, 'runs', run.id)
        }),
      ),
    [start, openPr, track],
  )

  const actions = useMemo<CardActions>(
    () => ({
      open: (pr) => {
        if (justDropped.current) return
        track(pr)
        const showRuns =
          pr.run && (hasLiveRun(pr) || pr.stage === 'verdict-ready' || pr.stage === 'ready-to-post')
        if (showRuns) openPr(pr.id, 'runs', pr.run?.id)
        else openPr(pr.id)
      },
      run: (pr, runAs) => launch(pr, runAs, true),
      cancel: (pr) => pr.run && track(pr, cancel(pr.run.id)),
      dismiss: (pr) => pr.run && track(pr, dismiss(pr.run.id)),
      star: (pr) => track(pr, flag({ id: pr.id, starred: !pr.starred })),
      hide: (pr) => track(pr, flag({ id: pr.id, hidden: !pr.hidden })),
      archive: (pr) => track(pr, flag({ id: pr.id, archived: true })),
      move: (pr, target) => track(pr, stage({ id: pr.id, stage: target })),
    }),
    [flag, stage, openPr, launch, cancel, dismiss, track],
  )

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      const pr = event.active.data.current?.pr as BoardPr | undefined
      setDrag(pr ? { pr, columns: visibleColumns } : null)
    },
    [visibleColumns],
  )

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDrag(null)
      justDropped.current = true
      setTimeout(() => {
        justDropped.current = false
      }, 0)
      const pr = event.active.data.current?.pr as BoardPr | undefined
      const target = event.over?.id
      if (!pr || typeof target !== 'string' || target === pr.stage) return
      const column = boardColumns[tab].find((item) => item.stage === target)
      if (!column || hasLiveRun(pr)) return
      if (runColumns.has(column.stage)) {
        if (pr.state !== 'OPEN') return
        if (dropConfirmed[column.stage]) launch(pr)
        else setPendingDrop({ pr, column: column.stage })
        return
      }
      if (column.agent) return
      track(pr, stage({ id: pr.id, stage: column.stage }))
    },
    [stage, tab, dropConfirmed, launch, track],
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
  const copy = pendingDrop && dropCopy[runStageFor(pendingDrop.pr)]

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
          onDragCancel={() => setDrag(null)}
          accessibility={{ announcements }}
          autoScroll={{ threshold: { x: 0.08, y: 0.15 }, acceleration: 6 }}
        >
          <div className="-mx-1 flex items-start gap-3 overflow-x-auto px-1 pb-4">
            {(drag?.columns ?? visibleColumns).map((column) => (
              <Column
                key={column.stage}
                tab={tab}
                column={column}
                prs={view.byStage.get(column.stage) ?? []}
                now={now}
                density={density}
                actions={actions}
                failure={failure}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {drag && <CardPreview pr={drag.pr} now={now} density={density} />}
          </DragOverlay>
        </DndContext>
      )}
      <Dialog open={pendingDrop !== null} onOpenChange={(open) => !open && setPendingDrop(null)}>
        {pendingDrop && copy && (
          <DialogContent
            title={copy.title}
            description={`${pendingDrop.pr.repo} #${pendingDrop.pr.number}`}
            className="w-[min(480px,calc(100vw-48px))]"
          >
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{copy.body}</p>
              <p className="text-xs text-muted-foreground">
                Next time, dropping a card on {stageLabel(tab, pendingDrop.column)} starts the run
                right away.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setPendingDrop(null)}>
                  Cancel
                </Button>
                <Button
                  autoFocus
                  onClick={() => {
                    confirmDrop(pendingDrop.column)
                    launch(pendingDrop.pr)
                    setPendingDrop(null)
                  }}
                >
                  Start run
                </Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
