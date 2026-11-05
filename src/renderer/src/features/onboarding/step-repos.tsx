import { useDeferredValue, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Loader2, Lock, Plus, Search, Trash2 } from 'lucide-react'
import { parseRepoInput, type GithubRepoSummary } from '@shared/domain'
import { ErrorText, Panel } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { invoke, keys, useAction, useRepos } from '@/lib/api'

function timeAgo(iso: string | null) {
  if (!iso) return null
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

function SuggestionRow({
  repo,
  added,
  busy,
  onAdd,
}: {
  repo: GithubRepoSummary
  added: boolean
  busy: boolean
  onAdd: () => void
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm">{repo.fullName}</span>
          {repo.private && <Lock className="size-3 shrink-0 text-muted-foreground" />}
        </div>
        {repo.description && (
          <p className="truncate text-xs text-muted-foreground">{repo.description}</p>
        )}
      </div>
      {repo.pushedAt && (
        <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(repo.pushedAt)}</span>
      )}
      {added ? (
        <Badge variant="success">
          <Check />
          Added
        </Badge>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={onAdd}>
          <Plus />
          Add
        </Button>
      )}
    </li>
  )
}

export function StepRepos() {
  const { data: repos = [] } = useRepos()
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query.trim())
  const mine = useQuery({ queryKey: keys.githubRepos, queryFn: () => invoke('github:repos') })
  const direct = parseRepoInput(deferred)
  const searchTerm = direct ? '' : deferred
  const search = useQuery({
    queryKey: ['github', 'search', searchTerm],
    queryFn: () => invoke('github:searchRepos', searchTerm),
    enabled: searchTerm.length >= 3,
    staleTime: 60_000,
  })
  const add = useAction((value: string) => invoke('repos:add', value), [keys.repos])
  const remove = useAction((id: number) => invoke('repos:remove', id), [keys.repos, ['bindings']])

  const addedNames = new Set(repos.map((repo) => `${repo.owner}/${repo.name}`.toLowerCase()))
  const needle = deferred.toLowerCase()
  const fromMine = (mine.data ?? []).filter(
    (repo) =>
      !needle ||
      repo.fullName.toLowerCase().includes(needle) ||
      repo.description?.toLowerCase().includes(needle),
  )
  const seen = new Set(fromMine.map((repo) => repo.fullName.toLowerCase()))
  const suggestions = [
    ...fromMine,
    ...(search.data ?? []).filter((repo) => !seen.has(repo.fullName.toLowerCase())),
  ].slice(0, needle ? 12 : 8)

  const submit = () => {
    if (!query.trim()) return
    add.mutate(query.trim(), { onSuccess: () => setQuery('') })
  }

  return (
    <Panel
      title="Repositories"
      description="Pick from your repositories, search GitHub, or paste owner/name or a URL."
    >
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Repository"
            placeholder="acme/app, https://github.com/acme/app or a search"
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
        </div>
        <Button type="submit" disabled={!parseRepoInput(query) || add.isPending}>
          {add.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
          Add
        </Button>
      </form>
      <ErrorText error={add.error ?? remove.error ?? mine.error} />

      {repos.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
            Added
          </p>
          <ul className="divide-y rounded-xl border">
            {repos.map((repo) => (
              <li key={repo.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="font-mono text-sm">
                  {repo.owner}/{repo.name}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${repo.owner}/${repo.name}`}
                  onClick={() => remove.mutate(repo.id)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <p className="flex items-center gap-2 text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
          {needle ? 'Matches' : 'Your recent repositories'}
          {(mine.isLoading || search.isFetching) && <Loader2 className="size-3 animate-spin" />}
        </p>
        {suggestions.length > 0 ? (
          <ul className="divide-y rounded-xl border">
            {suggestions.map((repo) => (
              <SuggestionRow
                key={repo.fullName}
                repo={repo}
                added={addedNames.has(repo.fullName.toLowerCase())}
                busy={add.isPending}
                onAdd={() => add.mutate(repo.fullName)}
              />
            ))}
          </ul>
        ) : (
          !mine.isLoading &&
          !search.isFetching && (
            <p className="text-sm text-muted-foreground">
              {direct ? `Press Add to add ${direct}.` : 'No repositories found.'}
            </p>
          )
        )}
      </div>
    </Panel>
  )
}
