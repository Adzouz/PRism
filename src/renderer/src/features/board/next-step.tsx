import { useState } from 'react'
import { BadgeCheck, ChevronDown, Loader2, MoveRight, Play } from 'lucide-react'
import { nextSteps, runStageLabel, type BoardPr, type NextStep } from '@shared/domain'
import { ErrorText } from '@/components/page'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useSetStage, useStartRun } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ApproveDialog } from './approve-dialog'
import { hasLiveRun, stageLabel, useBoardStore } from './model'

const stepIcon = { run: Play, move: MoveRight, approve: BadgeCheck }

function stepLabel(step: NextStep, pr: BoardPr) {
  if (step.kind === 'run') return `Run ${runStageLabel(step.stage, pr).toLowerCase()}`
  if (step.kind === 'approve') return pr.role === 'author' ? 'Post GO' : 'Approve'
  return `Move to ${stageLabel(pr.tab, step.stage)}`
}

function StepItem({
  step,
  pr,
  onSelect,
}: {
  step: NextStep
  pr: BoardPr
  onSelect: (step: NextStep) => void
}) {
  const Icon = stepIcon[step.kind]
  return (
    <DropdownMenuItem onSelect={() => onSelect(step)}>
      <Icon />
      {step.kind === 'run'
        ? runStageLabel(step.stage, pr)
        : step.kind === 'move'
          ? stageLabel(pr.tab, step.stage)
          : stepLabel(step, pr)}
    </DropdownMenuItem>
  )
}

export function NextStepButton({ pr, className }: { pr: BoardPr; className?: string }) {
  const steps = nextSteps(pr)
  const start = useStartRun()
  const move = useSetStage()
  const openPr = useBoardStore((state) => state.openPr)
  const [approving, setApproving] = useState(false)
  const [pendingLabel, setPendingLabel] = useState<string | null>(null)
  if (!steps) return null

  const pending = start.isPending || move.isPending
  const disabled = pending || hasLiveRun(pr)
  const { primary, others } = steps
  const runs = others.filter((step) => step.kind === 'run')
  const moves = others.filter((step) => step.kind === 'move')
  const approve = others.find((step) => step.kind === 'approve')
  const primaryPending = pending && !!primary && pendingLabel === stepLabel(primary, pr)
  const menuPending = pending && !primaryPending

  function act(step: NextStep) {
    start.reset()
    move.reset()
    setPendingLabel(stepLabel(step, pr))
    if (step.kind === 'run') {
      start.mutate(
        { prId: pr.id, stage: step.stage },
        { onSuccess: (run) => openPr(pr.id, 'runs', run.id) },
      )
    } else if (step.kind === 'move') {
      move.mutate({ id: pr.id, stage: step.stage })
    } else {
      setApproving(true)
    }
  }

  const PrimaryIcon = primary ? stepIcon[primary.kind] : null
  return (
    <div className={cn('space-y-1', className)}>
      <div className="inline-flex">
        {primary && PrimaryIcon && (
          <Button
            size="sm"
            className="rounded-r-none"
            disabled={disabled}
            onClick={() => act(primary)}
          >
            {primaryPending ? <Loader2 className="animate-spin" /> : <PrimaryIcon />}
            {stepLabel(primary, pr)}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <Button
              size="sm"
              variant={primary ? 'default' : 'outline'}
              aria-label={primary ? 'Other next steps' : undefined}
              className={cn(primary && 'rounded-l-none border-l border-primary-foreground/20 px-2')}
            >
              {!primary && (menuPending ? <Loader2 className="animate-spin" /> : <MoveRight />)}
              {!primary && 'Next step'}
              {primary && menuPending ? <Loader2 className="animate-spin" /> : <ChevronDown />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {runs.length > 0 && <DropdownMenuLabel>Run</DropdownMenuLabel>}
            {runs.map((step) => (
              <StepItem key={stepLabel(step, pr)} step={step} pr={pr} onSelect={act} />
            ))}
            {approve && (
              <>
                <DropdownMenuSeparator />
                <StepItem step={approve} pr={pr} onSelect={act} />
              </>
            )}
            {moves.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Move to</DropdownMenuLabel>
              </>
            )}
            {moves.map((step) => (
              <StepItem key={stepLabel(step, pr)} step={step} pr={pr} onSelect={act} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ErrorText error={start.error ?? move.error} />
      <ApproveDialog pr={approving ? pr : null} onClose={() => setApproving(false)} />
    </div>
  )
}
