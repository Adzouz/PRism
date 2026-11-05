import type { ReactNode } from 'react'
import { Eye, Rows2, Rows3, Search, Sparkles, Star, X } from 'lucide-react'
import type { BoardTab } from '@shared/domain'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { useBoardStore, type Density } from './model'

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5',
        active && 'border-foreground bg-foreground text-background hover:text-background',
      )}
    >
      {children}
    </button>
  )
}

export function Toolbar({
  tab,
  repos,
  hiddenCount,
}: {
  tab: BoardTab
  repos: [number, string][]
  hiddenCount: number
}) {
  const filters = useBoardStore((state) => state.filters[tab])
  const setFilters = useBoardStore((state) => state.setFilters)
  const density = useBoardStore((state) => state.density)
  const setDensity = useBoardStore((state) => state.setDensity)
  const set = (patch: Parameters<typeof setFilters>[1]) => setFilters(tab, patch)

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-72">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={filters.search}
          onChange={(event) => set({ search: event.target.value })}
          onKeyDown={(event) => event.key === 'Escape' && set({ search: '' })}
          placeholder="Search  #123  @user  words"
          aria-label="Search pull requests"
          className="h-8 w-full rounded-full border bg-surface pr-8 pl-9 text-sm outline-none select-text placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
        />
        {filters.search && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => set({ search: '' })}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {repos.length > 1 &&
        repos.map(([id, slug]) => (
          <Chip
            key={id}
            active={filters.repoIds.includes(id)}
            onClick={() =>
              set({
                repoIds: filters.repoIds.includes(id)
                  ? filters.repoIds.filter((repoId) => repoId !== id)
                  : [...filters.repoIds, id],
              })
            }
          >
            <span className="font-mono text-xs">{slug}</span>
          </Chip>
        ))}
      <Chip active={filters.starred} onClick={() => set({ starred: !filters.starred })}>
        <Star />
        Starred
      </Chip>
      <Chip active={filters.needsMe} onClick={() => set({ needsMe: !filters.needsMe })}>
        <Sparkles />
        Needs me
      </Chip>
      {(hiddenCount > 0 || filters.showHidden) && (
        <Chip active={filters.showHidden} onClick={() => set({ showHidden: !filters.showHidden })}>
          <Eye />
          Show hidden ({hiddenCount})
        </Chip>
      )}
      <ToggleGroup
        type="single"
        value={density}
        onValueChange={(value) => value && setDensity(value as Density)}
        aria-label="Card density"
        className="ml-auto"
      >
        <ToggleGroupItem value="comfortable" aria-label="Comfortable">
          <Rows2 />
        </ToggleGroupItem>
        <ToggleGroupItem value="compact" aria-label="Compact">
          <Rows3 />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}
