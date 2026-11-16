import { create } from 'zustand'
import { ArrowDownRight, ArrowUpRight, Check, ChevronDown, Minus } from 'lucide-react'
import {
  dashboardMetricLabels,
  stageLabels,
  type BoardPr,
  type Dashboard,
  type Run,
} from '@shared/domain'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ErrorText, Panel } from '@/components/page'
import { useDashboard, usePrs, useRepos, useRuns } from '@/lib/api'
import { cn } from '@/lib/utils'
import { age, useBoardStore, useNow } from '../board/model'
import { RunStatusBadge, isLive } from '../runs/parts'
import { ActivityChart, TrendChart } from './charts'

const useDashboardRepo = create<{ repoId: number | null; set: (repoId: number | null) => void }>()(
  (set) => ({ repoId: null, set: (repoId) => set({ repoId }) }),
)

function RepoPicker() {
  const { data: repos = [] } = useRepos()
  const { repoId: selected, set } = useDashboardRepo()
  if (repos.length < 2) return null
  const current = repos.find((repo) => repo.id === selected)
  const repoId = current ? selected : null
  const label = (repo: (typeof repos)[number]) => `${repo.owner}/${repo.name}`
  const options = [
    { id: null, name: 'All repositories' },
    ...repos.map((repo) => ({ id: repo.id, name: label(repo) })),
  ]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="no-drag">
          {current ? label(current) : 'All repositories'}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((option) => (
          <DropdownMenuItem key={option.id ?? 'all'} onSelect={() => set(option.id)}>
            <Check className={cn(option.id !== repoId && 'invisible')} />
            {option.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Change({ from, to }: { from: number | null; to: number | null }) {
  if (from === null || to === null) {
    return <span className="text-muted-foreground">No snapshot yesterday</span>
  }
  if (from === to) {
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Minus className="size-3.5" /> Same as yesterday
      </span>
    )
  }
  const Icon = to > from ? ArrowUpRight : ArrowDownRight
  const text =
    from === 0
      ? `+${to}`
      : `${to > from ? '+' : '−'}${Math.round((Math.abs(to - from) / from) * 100)}%`
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      <Icon className="size-3.5" />
      <span className="font-medium text-foreground tabular-nums">{text}</span> vs yesterday
    </span>
  )
}

function Tiles({ tiles }: { tiles: Dashboard['tiles'] }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {tiles.map((tile) => (
        <div key={tile.metric} className="space-y-2 rounded-2xl bg-surface p-5">
          <p className="text-sm text-muted-foreground">{dashboardMetricLabels[tile.metric]}</p>
          <p className="text-3xl font-semibold tracking-tight tabular-nums">
            {tile.value?.toLocaleString('en') ?? '—'}
          </p>
          <div className="text-xs">
            <Change from={tile.from} to={tile.to} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function formatDuration(seconds: number) {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`
}

function Latency({ latency }: { latency: Dashboard['latency'] }) {
  const windows = [
    { label: 'Last 7 days', value: latency.week },
    { label: 'Last 30 days', value: latency.month },
  ]
  return (
    <div className="grid grid-cols-2 gap-4">
      {windows.map(({ label, value }) => (
        <div key={label} className="space-y-1">
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-3xl font-semibold tracking-tight tabular-nums">
            {value.medianS === null ? '—' : formatDuration(value.medianS)}
          </p>
          <p className="text-xs text-muted-foreground">
            {value.count === 0
              ? 'No reviews'
              : `${value.count} review${value.count === 1 ? '' : 's'}`}
          </p>
        </div>
      ))}
    </div>
  )
}

function prLabel(pr: BoardPr | undefined, run: Run) {
  return pr ? `${pr.repo.split('/')[1]} #${pr.number}` : `Pull request ${run.prId}`
}

function Agents() {
  const { data: runs = [] } = useRuns()
  const { data: prs = [] } = usePrs()
  const openPr = useBoardStore((state) => state.openPr)
  const now = useNow()
  const byId = new Map(prs.map((pr) => [pr.id, pr]))
  const needsYou = runs.filter((run) => run.status === 'needs_you' && run.dismissedAt === null)
  const live = runs.filter((run) => isLive(run.status))
  if (!needsYou.length && !live.length) return null
  return (
    <div className="space-y-4">
      {needsYou.length > 0 && (
        <Panel title="Needs you" description="Agents waiting for an answer.">
          <ul className="-mx-2 divide-y">
            {needsYou.map((run) => {
              const pr = byId.get(run.prId)
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => openPr(run.prId, 'runs', run.id)}
                    className="no-drag flex w-full items-start gap-3 rounded-lg px-2 py-3 text-left text-sm outline-none hover:bg-secondary/50 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <RunStatusBadge status={run.status} />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="block truncate">
                        <span className="font-mono text-muted-foreground">{prLabel(pr, run)}</span>{' '}
                        {pr?.title}
                      </span>
                      {run.ask && (
                        <span className="block truncate text-muted-foreground">
                          {run.ask.prompt}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {age(run.ask?.createdAt ?? run.createdAt, now)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </Panel>
      )}
      {live.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm text-muted-foreground">Running</span>
          {live.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => openPr(run.prId, 'runs', run.id)}
              className="no-drag flex items-center gap-2 rounded-full bg-surface py-1 pr-3 pl-1 text-sm outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RunStatusBadge status={run.status} />
              <span>{stageLabels[run.stage]}</span>
              <span className="font-mono text-muted-foreground">
                {prLabel(byId.get(run.prId), run)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function DashboardOverview() {
  const selected = useDashboardRepo((state) => state.repoId)
  const { data: repos } = useRepos()
  const repoId = repos && !repos.some((repo) => repo.id === selected) ? null : selected
  const { data, error } = useDashboard(repoId)
  const trendDays = data?.trend.filter((entry) => entry.openPrs !== null).length ?? 0
  return (
    <div className="space-y-6">
      <Agents />
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-medium text-accent-foreground">Overview</h2>
        <RepoPicker />
      </div>
      {error && !data && <ErrorText error={error} />}
      {data && (
        <>
          <Tiles tiles={data.tiles} />
          <div className="grid gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <Panel title="Pull requests per day" description="Last 14 days, from GitHub search.">
                <ActivityChart data={data.activity.slice(-14)} />
              </Panel>
            </div>
            <Panel
              title="Review latency"
              description="Median time from a review request to my review."
            >
              <Latency latency={data.latency} />
            </Panel>
          </div>
          <Panel title="Open pull requests" description="At the end of each day, last 30 days.">
            {trendDays < 2 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                The trend appears once GitHub search has answered.
              </p>
            ) : (
              <TrendChart data={data.trend} />
            )}
          </Panel>
        </>
      )}
    </div>
  )
}
