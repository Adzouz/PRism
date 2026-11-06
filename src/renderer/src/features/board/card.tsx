import { memo, type KeyboardEvent, type ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import {
  Archive,
  ArrowUpRight,
  Bot,
  Eye,
  EyeOff,
  Loader2,
  MessageSquare,
  MoveRight,
  Play,
  RotateCcw,
  Square,
  Star,
  Users,
  X,
} from 'lucide-react'
import {
  boardColumns,
  runStagesByTab,
  stageLabels,
  type BoardPr,
  type BoardStage,
  type Stage,
} from '@shared/domain'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Tooltip } from '@/components/ui/tooltip'
import { runStageFor } from '@/lib/api'
import { cn } from '@/lib/utils'
import { AnswerForm, verdictLabel } from '../runs/parts'
import { age, hasLiveRun, prSize, type Density } from './model'

export type CardActions = {
  open: (pr: BoardPr) => void
  star: (pr: BoardPr) => void
  hide: (pr: BoardPr) => void
  archive: (pr: BoardPr) => void
  move: (pr: BoardPr, stage: BoardStage | null) => void
  run: (pr: BoardPr, stage?: Stage) => void
  cancel: (pr: BoardPr) => void
  dismiss: (pr: BoardPr) => void
}

function RunStrip({ pr, interactive }: { pr: BoardPr; interactive: boolean }) {
  const run = pr.run
  if (!run) return null
  if (run.status === 'needs_you' && run.ask) {
    return interactive ? (
      <div className="rounded-lg border border-warning/40 bg-warning/5 p-2">
        <AnswerForm ask={run.ask} compact />
      </div>
    ) : (
      <p className="line-clamp-2 text-xs text-warning">{run.ask.prompt}</p>
    )
  }
  if (run.status === 'queued' || run.status === 'preparing' || run.status === 'running') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-primary">
        <Loader2 className="size-3 shrink-0 animate-spin" />
        <span className="truncate">{run.progress ?? `${stageLabels[run.stage]} starting`}</span>
      </p>
    )
  }
  if (
    run.status === 'done' &&
    run.verdict &&
    (pr.stage === 'verdict-ready' || pr.stage === 'ready-to-post')
  ) {
    return (
      <p className="text-xs">
        <span
          className={cn(
            'font-medium',
            run.verdict === 'approve' && 'text-success',
            run.verdict === 'request_changes' && 'text-destructive',
          )}
        >
          {verdictLabel[run.verdict]}
        </span>
        <span className="text-muted-foreground">
          {' '}
          · {run.findings} finding{run.findings === 1 ? '' : 's'}
        </span>
      </p>
    )
  }
  if (run.status === 'failed') {
    return (
      <Tooltip content={run.error ?? 'Run failed'}>
        <p className="truncate text-xs text-destructive">{stageLabels[run.stage]} run failed</p>
      </Tooltip>
    )
  }
  return null
}

const ciColor: Record<BoardPr['ciState'], string> = {
  success: 'bg-success',
  failure: 'bg-destructive',
  pending: 'bg-warning',
  none: 'bg-muted-foreground/40',
}

const ciLabel: Record<BoardPr['ciState'], string> = {
  success: 'Checks passing',
  failure: 'Checks failing',
  pending: 'Checks running',
  none: 'No checks',
}

export function Avatar({
  src,
  name,
  className,
}: {
  src: string | null
  name: string
  className?: string
}) {
  return src ? (
    <img
      src={src}
      alt=""
      className={cn('size-5 rounded-full bg-secondary', className)}
      draggable={false}
    />
  ) : (
    <span
      className={cn(
        'flex size-5 items-center justify-center rounded-full bg-secondary text-[10px] font-medium uppercase',
        className,
      )}
    >
      {name.slice(0, 1)}
    </span>
  )
}

function IconAction({
  label,
  onClick,
  active,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onClick()
        }}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground [&_svg]:size-3.5"
      >
        {children}
      </button>
    </Tooltip>
  )
}

function CardBody({
  pr,
  now,
  density,
  interactive = false,
}: {
  pr: BoardPr
  now: number
  density: Density
  interactive?: boolean
}) {
  const repoName = pr.repo.split('/')[1] ?? pr.repo
  return (
    <>
      <div className="flex items-center gap-2 pr-16 text-xs text-muted-foreground">
        <span className="truncate rounded bg-secondary px-1.5 py-0.5 font-mono">{repoName}</span>
        <span className="font-mono">#{pr.number}</span>
        <Tooltip content={ciLabel[pr.ciState]}>
          <span className={cn('size-2 shrink-0 rounded-full', ciColor[pr.ciState])} />
        </Tooltip>
        {pr.starred && <Star className="size-3 fill-warning text-warning" />}
      </div>
      <p
        className={cn(
          'text-sm font-medium leading-snug',
          density === 'compact' ? 'line-clamp-1' : 'line-clamp-2',
        )}
      >
        {pr.title}
      </p>
      {density === 'comfortable' && pr.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {pr.labels.slice(0, 3).map((label) => (
            <span
              key={label.name}
              className="inline-flex max-w-full items-center gap-1 truncate rounded-full border px-1.5 py-px text-[11px] text-muted-foreground"
            >
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: `#${label.color}` }}
              />
              <span className="truncate">{label.name}</span>
            </span>
          ))}
          {pr.labels.length > 3 && (
            <span className="text-[11px] text-muted-foreground">+{pr.labels.length - 3}</span>
          )}
        </div>
      )}
      <RunStrip pr={pr} interactive={interactive} />
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Avatar src={pr.authorAvatar} name={pr.author} />
        {density === 'comfortable' && <span className="truncate">{pr.author}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {pr.manual && (
            <Tooltip content="Moved by you. Resets when GitHub's state changes.">
              <span className="rounded bg-accent px-1 text-[10px] font-medium text-accent-foreground uppercase">
                manual
              </span>
            </Tooltip>
          )}
          {pr.requestedTeam && (
            <Tooltip content={`Requested from team ${pr.requestedTeam}`}>
              <Users className="size-3.5" />
            </Tooltip>
          )}
          {pr.unresolvedThreads > 0 && (
            <Tooltip content={`${pr.unresolvedThreads} unresolved threads`}>
              <span className="flex items-center gap-0.5">
                <MessageSquare className="size-3.5" />
                {pr.unresolvedThreads}
              </span>
            </Tooltip>
          )}
          <Tooltip content={`+${pr.additions} −${pr.deletions} in ${pr.changedFiles} files`}>
            <span className="font-mono">{prSize(pr)}</span>
          </Tooltip>
          <Tooltip content="Time in this column">
            <span className="font-mono">{age(pr.stageSince, now)}</span>
          </Tooltip>
        </span>
      </div>
    </>
  )
}

export const cardClass =
  'group relative flex w-full flex-col gap-2 rounded-xl border bg-surface p-3 text-left shadow-xs outline-none transition-[box-shadow,opacity] focus-visible:ring-2 focus-visible:ring-ring'

export function CardPreview({ pr, now, density }: { pr: BoardPr; now: number; density: Density }) {
  return (
    <div className={cn(cardClass, 'rotate-1 cursor-grabbing shadow-xl ring-2 ring-primary/40')}>
      <CardBody pr={pr} now={now} density={density} />
    </div>
  )
}

export const PrCard = memo(function PrCard({
  pr,
  now,
  density,
  actions,
}: {
  pr: BoardPr
  now: number
  density: Density
  actions: CardActions
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: pr.id,
    data: { pr },
  })
  const needsMe =
    pr.stage === 'verdict-ready' || pr.stage === 'ready-to-post' || pr.stage === 'needs-you'
  const live = hasLiveRun(pr)
  const defaultStage = runStageFor(pr)
  const finished = pr.run !== null && ['done', 'failed', 'cancelled'].includes(pr.run.status)
  const columns = boardColumns[pr.tab].filter((column) => !column.agent)

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    listeners?.onKeyDown?.(event)
    if (event.defaultPrevented || isDragging || event.metaKey || event.ctrlKey) return
    const handlers: Record<string, () => void> = {
      Enter: () => actions.open(pr),
      s: () => actions.star(pr),
      h: () => actions.hide(pr),
      e: () => actions.archive(pr),
      o: () => window.open(pr.url, '_blank'),
    }
    const handler = handlers[event.key]
    if (handler) {
      event.preventDefault()
      handler()
    }
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          onKeyDown={onKeyDown}
          onClick={() => actions.open(pr)}
          aria-label={`${pr.repo} #${pr.number} ${pr.title}`}
          aria-roledescription="Draggable pull request"
          className={cn(
            cardClass,
            'cursor-pointer hover:shadow-md',
            isDragging && 'opacity-30',
            pr.hidden && 'opacity-60',
            needsMe && 'shadow-[0_0_0_1px_var(--primary),0_0_18px_-4px_var(--primary)]',
          )}
        >
          <CardBody pr={pr} now={now} density={density} interactive />
          <div className="absolute top-2 right-2 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <IconAction
              label={pr.starred ? 'Unstar (s)' : 'Star (s)'}
              active={pr.starred}
              onClick={() => actions.star(pr)}
            >
              <Star className={cn(pr.starred && 'fill-warning text-warning')} />
            </IconAction>
            <IconAction
              label={pr.hidden ? 'Show (h)' : 'Hide (h)'}
              active={pr.hidden}
              onClick={() => actions.hide(pr)}
            >
              {pr.hidden ? <Eye /> : <EyeOff />}
            </IconAction>
            <IconAction label="Archive (e)" onClick={() => actions.archive(pr)}>
              <Archive />
            </IconAction>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.open(pr)} shortcut="↵">
          Open details
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => window.open(pr.url, '_blank')} shortcut="O">
          <ArrowUpRight />
          Open on GitHub
        </ContextMenuItem>
        <ContextMenuSeparator />
        {live ? (
          <ContextMenuItem onSelect={() => actions.cancel(pr)}>
            <Square />
            Stop {stageLabels[pr.run!.stage].toLowerCase()} run
          </ContextMenuItem>
        ) : (
          pr.state === 'OPEN' && (
            <>
              <ContextMenuItem onSelect={() => actions.run(pr)}>
                <Play />
                Run {stageLabels[defaultStage].toLowerCase()}
              </ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger>
                  <Bot />
                  Other runs
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {runStagesByTab[pr.tab]
                    .filter((stage) => stage !== defaultStage)
                    .map((stage) => (
                      <ContextMenuItem key={stage} onSelect={() => actions.run(pr, stage)}>
                        {stageLabels[stage]}
                      </ContextMenuItem>
                    ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            </>
          )
        )}
        {finished && (
          <ContextMenuItem onSelect={() => actions.dismiss(pr)}>
            <X />
            Dismiss {pr.run?.verdict && pr.stage === 'verdict-ready' ? 'verdict' : 'run'}
          </ContextMenuItem>
        )}
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <MoveRight />
            Move to
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {columns.map((column) => (
              <ContextMenuItem
                key={column.stage}
                disabled={column.stage === pr.stage}
                onSelect={() => actions.move(pr, column.stage)}
              >
                {column.label}
                {column.stage === pr.derivedStage && (
                  <span className="ml-auto text-xs text-muted-foreground">GitHub</span>
                )}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {pr.manual && (
          <ContextMenuItem onSelect={() => actions.move(pr, null)}>
            <RotateCcw />
            Back to GitHub stage
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.star(pr)} shortcut="S">
          <Star />
          {pr.starred ? 'Unstar' : 'Star'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.hide(pr)} shortcut="H">
          {pr.hidden ? <Eye /> : <EyeOff />}
          {pr.hidden ? 'Show on board' : 'Hide'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.archive(pr)} shortcut="E">
          <Archive />
          Archive
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})
