import { Bot } from 'lucide-react'
import { stageLabels, type Run } from '@shared/domain'
import { EmptyState, ErrorText } from '@/components/page'
import { usePrs, useRuns } from '@/lib/api'
import { age, useBoardStore, useNow } from '../board/model'
import { Loading, RunStatusBadge, isLive, verdictLabel } from './parts'

function runNote(run: Run) {
  if (isLive(run.status)) return run.progress
  if (run.status === 'needs_you') return run.ask?.prompt
  if (run.report && run.stage !== 'test-plan') return verdictLabel[run.report.verdict]
  return run.error
}

export function RunsList() {
  const { data: runs, isLoading, error } = useRuns()
  const { data: prs } = usePrs()
  const openPr = useBoardStore((state) => state.openPr)
  const now = useNow()
  if (isLoading) return <Loading>Loading runs…</Loading>
  if (error && !runs) return <ErrorText error={error} />
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
              onClick={() => openPr(run.prId, 'runs', run.id)}
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
                {runNote(run)}
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
