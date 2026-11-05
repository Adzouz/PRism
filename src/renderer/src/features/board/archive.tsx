import { useState } from 'react'
import { Archive, ArchiveRestore } from 'lucide-react'
import { EmptyState } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { usePrs, useSetFlags } from '@/lib/api'
import { Avatar } from './card'
import { age, matchesSearch, useBoardStore, useNow } from './model'

export function ArchiveList() {
  const { data: prs = [] } = usePrs()
  const setFlags = useSetFlags()
  const openPr = useBoardStore((state) => state.openPr)
  const now = useNow()
  const [search, setSearch] = useState('')
  const archived = prs
    .filter((pr) => pr.archivedAt !== null && matchesSearch(pr, search))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))

  if (prs.every((pr) => pr.archivedAt === null)) {
    return (
      <EmptyState
        icon={Archive}
        title="Archive is empty"
        description="Archived pull requests are kept here and can be restored. Done PRs land here after 24 hours."
      />
    )
  }

  return (
    <div className="space-y-4">
      <input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search  #123  @user  words"
        aria-label="Search archive"
        className="h-8 w-72 rounded-full border bg-surface px-4 text-sm outline-none select-text placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
      />
      <ul className="divide-y rounded-2xl border bg-surface">
        {archived.map((pr) => (
          <li key={pr.id} className="flex items-center gap-4 px-4 py-3">
            <button
              type="button"
              onClick={() => openPr(pr.id)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Avatar src={pr.authorAvatar} name={pr.author} />
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {pr.repo.split('/')[1]} #{pr.number}
              </span>
              <span className="truncate text-sm">{pr.title}</span>
            </button>
            {pr.state !== 'OPEN' && (
              <Badge variant={pr.state === 'MERGED' ? 'accent' : 'default'}>
                {pr.state.toLowerCase()}
              </Badge>
            )}
            <span className="shrink-0 text-xs text-muted-foreground">
              {pr.tab === 'reviews' ? 'Review' : 'Mine'} · archived{' '}
              {age(pr.archivedAt ?? now, now) === 'now'
                ? 'just now'
                : `${age(pr.archivedAt ?? now, now)} ago`}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setFlags.mutate({ id: pr.id, archived: false })}
            >
              <ArchiveRestore />
              Restore
            </Button>
          </li>
        ))}
        {archived.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-muted-foreground">No match</li>
        )}
      </ul>
    </div>
  )
}
