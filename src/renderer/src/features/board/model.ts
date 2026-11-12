import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { boardColumns, type BoardPr, type BoardStage, type BoardTab } from '@shared/domain'

export type Density = 'comfortable' | 'compact'

export type Filters = {
  repoIds: number[]
  starred: boolean
  needsMe: boolean
  showHidden: boolean
  search: string
}

const emptyFilters: Filters = {
  repoIds: [],
  starred: false,
  needsMe: false,
  showHidden: false,
  search: '',
}

export type DrawerTab = 'overview' | 'runs' | 'post'

type BoardStore = {
  filters: Record<BoardTab, Filters>
  density: Density
  openPrId: number | null
  drawerTab: DrawerTab
  openRunId: number | null
  dropConfirmed: Partial<Record<BoardStage, boolean>>
  setFilters: (tab: BoardTab, patch: Partial<Filters>) => void
  setDensity: (density: Density) => void
  openPr: (id: number | null, tab?: DrawerTab, runId?: number | null) => void
  setDrawerTab: (tab: DrawerTab) => void
  selectRun: (runId: number | null) => void
  confirmDrop: (column: BoardStage) => void
}

type PersistedBoard = Pick<BoardStore, 'filters' | 'density' | 'dropConfirmed'>

export function migrateBoard(persisted: unknown, version: number) {
  const { agentDropConfirmed, ...state } = (persisted ?? {}) as Partial<PersistedBoard> & {
    agentDropConfirmed?: boolean
  }
  if (version >= 1) return state as PersistedBoard
  return {
    ...state,
    dropConfirmed: agentDropConfirmed ? { reviewing: true } : {},
  } as PersistedBoard
}

export const useBoardStore = create<BoardStore>()(
  persist(
    (set) => ({
      filters: { reviews: emptyFilters, mine: emptyFilters },
      density: 'comfortable',
      openPrId: null,
      drawerTab: 'overview',
      openRunId: null,
      dropConfirmed: {},
      setFilters: (tab, patch) =>
        set((state) => ({
          filters: { ...state.filters, [tab]: { ...state.filters[tab], ...patch } },
        })),
      setDensity: (density) => set({ density }),
      openPr: (openPrId, drawerTab = 'overview', openRunId = null) =>
        set({ openPrId, drawerTab, openRunId }),
      setDrawerTab: (drawerTab) => set({ drawerTab }),
      selectRun: (openRunId) => set({ openRunId }),
      confirmDrop: (column) =>
        set((state) => ({ dropConfirmed: { ...state.dropConfirmed, [column]: true } })),
    }),
    {
      name: 'prism-board',
      version: 1,
      partialize: ({ filters, density, dropConfirmed }): PersistedBoard => ({
        density,
        dropConfirmed,
        filters: {
          reviews: { ...filters.reviews, search: '' },
          mine: { ...filters.mine, search: '' },
        },
      }),
      migrate: migrateBoard,
    },
  ),
)

const needsMeStages = (tab: BoardTab) =>
  new Set(boardColumns[tab].filter((column) => column.needsMe).map((column) => column.stage))

export const readyToPost = (pr: BoardPr) =>
  pr.run?.status === 'done' &&
  !pr.run.gateClosed &&
  (pr.stage === 'reviewing' || pr.stage === 'addressing')

export function isNeedsMe(pr: BoardPr) {
  return (
    pr.run?.status === 'needs_you' ||
    (pr.state === 'OPEN' && (needsMeStages(pr.tab).has(pr.stage) || readyToPost(pr)))
  )
}

export const hasLiveRun = (pr: BoardPr) =>
  pr.run !== null && ['queued', 'preparing', 'running', 'needs_you'].includes(pr.run.status)

export function matchesSearch(pr: BoardPr, search: string) {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return terms.every((term) => {
    if (/^#\d+$/.test(term)) return String(pr.number).startsWith(term.slice(1))
    if (term.startsWith('@')) return pr.author.toLowerCase().includes(term.slice(1))
    return (
      pr.title.toLowerCase().includes(term) ||
      pr.repo.toLowerCase().includes(term) ||
      pr.labels.some((label) => label.name.toLowerCase().includes(term))
    )
  })
}

export function boardView(prs: BoardPr[], tab: BoardTab, filters: Filters) {
  const onTab = prs.filter((pr) => pr.tab === tab && pr.archivedAt === null)
  const hiddenCount = onTab.filter((pr) => pr.hidden).length
  const visible = onTab
    .filter((pr) => filters.showHidden || !pr.hidden)
    .filter((pr) => filters.repoIds.length === 0 || filters.repoIds.includes(pr.repoId))
    .filter((pr) => !filters.starred || pr.starred)
    .filter((pr) => !filters.needsMe || isNeedsMe(pr))
    .filter((pr) => matchesSearch(pr, filters.search))
    .sort(
      (a, b) => Number(b.starred) - Number(a.starred) || b.updatedAt - a.updatedAt || b.id - a.id,
    )
  const byStage = new Map<BoardStage, BoardPr[]>()
  for (const pr of visible) byStage.set(pr.stage, [...(byStage.get(pr.stage) ?? []), pr])
  return { byStage, hiddenCount, total: visible.length }
}

export function prSize(pr: Pick<BoardPr, 'additions' | 'deletions'>) {
  const lines = pr.additions + pr.deletions
  if (lines < 10) return 'XS'
  if (lines < 50) return 'S'
  if (lines < 250) return 'M'
  if (lines < 1000) return 'L'
  return 'XL'
}

export function age(from: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - from) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

export const stageLabel = (tab: BoardTab, stage: BoardStage) =>
  boardColumns[tab].find((column) => column.stage === stage)?.label ?? stage
