import { Bot } from 'lucide-react'
import { stageLabels } from '@shared/domain'
import { EmptyState } from '@/components/page'
import { usePrs, useRuns } from '@/lib/api'
import { age, useBoardStore, useNow } from '../board/model'
import { RunStatusBadge, isLive, verdictLabel } from './parts'

export function RunsList() {
  const { data: runs, isLoading } = useRuns()
  const { data: prs } = usePrs()
  const openPr = useBoardStore((state) => state.openPr)
  const now = useNow()
  if (isLoading) return null
  if (!runs?.length) {
    return (
      <EmptyState
        icon={Bot}
        title="No agent runs"
        description="Drag a card into Reviewing, or open a pull request and start a run."
      />
    )
  }
  const byId = new Map((prs ?? []).map((pr) => [pr.id, pr]))
  return (
    <ul className="divide-y rounded-2xl border bg-surface">
      {runs.map((run) => {
        const pr = byId.get(run.prId)
        return (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => openPr(run.prId, 'runs')}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm outline-none first:rounded-t-2xl last:rounded-b-2xl hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RunStatusBadge status={run.status} />
              <span className="w-28 shrink-0 text-muted-foreground">{stageLabels[run.stage]}</span>
              <span className="min-w-0 flex-1 truncate">
                {pr ? (
                  <>
                    <span className="font-mono text-muted-foreground">
                      {pr.repo.split('/')[1]} #{pr.number}
                    </span>{' '}
                    {pr.title}
                  </>
                ) : (
                  `Pull request ${run.prId}`
                )}
              </span>
              <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block sm:max-w-48">
                {isLive(run.status)
                  ? run.progress
                  : run.status === 'needs_you'
                    ? run.ask?.prompt
                    : run.report
                      ? verdictLabel[run.report.verdict]
                      : run.error}
              </span>
              <span className="w-14 shrink-0 text-right font-mono text-xs text-muted-foreground">
                ${run.costUsd.toFixed(2)}
              </span>
              <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {age(run.createdAt, now)}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
