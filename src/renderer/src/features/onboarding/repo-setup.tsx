import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, FolderOpen, Loader2 } from 'lucide-react'
import type { Repo } from '@shared/domain'
import { ErrorText, Panel } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { invoke, keys, useAction, useBindings } from '@/lib/api'
import { SourcePicker } from './source-picker'
import { StageBindings } from './stage-bindings'

const done = (
  <Badge variant="success">
    <Check />
    Done
  </Badge>
)

function useRepoAction<I>(fn: (input: I) => Promise<Repo>) {
  return useAction(fn, [keys.repos])
}

function CloneSection({ repo }: { repo: Repo }) {
  const [changing, setChanging] = useState(false)
  const show = !repo.localPath || changing
  const located = useQuery({
    queryKey: ['repos', repo.id, 'locate'],
    queryFn: () => invoke('repos:locate', repo.id),
    enabled: show,
  })
  const [clonePath, setClonePath] = useState<string | null>(null)
  const setPath = useRepoAction((path: string) => invoke('repos:setPath', { id: repo.id, path }))
  const clone = useRepoAction((path: string) => invoke('repos:clone', { id: repo.id, path }))
  const target = clonePath ?? located.data?.suggestedClonePath ?? ''
  const use = (path: string) => setPath.mutate(path, { onSuccess: () => setChanging(false) })

  return (
    <Panel
      title="1. Local clone"
      description="PRism creates worktrees from this clone."
      status={repo.localPath && !changing ? done : undefined}
    >
      {!show ? (
        <div className="flex items-center justify-between gap-3">
          <span className="truncate font-mono text-xs select-text">{repo.localPath}</span>
          <Button variant="ghost" size="sm" onClick={() => setChanging(true)}>
            Change
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {located.isLoading && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Looking for a clone on this Mac…
            </p>
          )}
          {located.data?.candidates.map((path) => (
            <div
              key={path}
              className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
            >
              <span className="truncate font-mono text-xs select-text">{path}</span>
              <Button size="sm" disabled={setPath.isPending} onClick={() => use(path)}>
                Use
              </Button>
            </div>
          ))}
          {located.data && located.data.candidates.length === 0 && (
            <p className="text-sm text-muted-foreground">No clone found in the usual folders.</p>
          )}
          <div className="flex gap-2">
            <Input
              aria-label="Clone into"
              className="font-mono text-xs"
              value={target}
              onChange={(event) => setClonePath(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={clone.isPending || !target.trim()}
              onClick={() => clone.mutate(target.trim(), { onSuccess: () => setChanging(false) })}
            >
              {clone.isPending && <Loader2 className="animate-spin" />}
              Clone here
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                const path = await invoke('dialog:pickFolder', { title: 'Choose the local clone' })
                if (path) use(path)
              }}
            >
              <FolderOpen />
              Existing…
            </Button>
          </div>
          {changing && (
            <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
              Cancel
            </Button>
          )}
          <ErrorText error={setPath.error ?? clone.error ?? located.error} />
        </div>
      )}
    </Panel>
  )
}

function WorktreeSection({ repo }: { repo: Repo }) {
  const [draft, setDraft] = useState<string | null>(null)
  const save = useRepoAction((path: string) =>
    invoke('repos:setWorktreeRoot', { id: repo.id, path }),
  )
  const value = draft ?? repo.worktreeRoot ?? ''
  const dirty = draft !== null && draft !== repo.worktreeRoot

  return (
    <Panel
      title="2. Worktree folder"
      description="One worktree per pull request, as pr-<number> inside this folder."
      status={repo.worktreeRoot && !dirty ? done : undefined}
      disabled={!repo.localPath}
    >
      <div className="flex gap-2">
        <Input
          aria-label="Worktree folder"
          className="font-mono text-xs"
          value={value}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          variant="outline"
          onClick={async () => {
            const path = await invoke('dialog:pickFolder', {
              title: 'Choose the worktree folder',
              defaultPath: value || undefined,
            })
            if (path) save.mutate(path, { onSuccess: () => setDraft(null) })
          }}
        >
          <FolderOpen />
          Choose…
        </Button>
        <Button
          disabled={!dirty || !value.trim() || save.isPending}
          onClick={() => save.mutate(value.trim(), { onSuccess: () => setDraft(null) })}
        >
          Save
        </Button>
      </div>
      <ErrorText error={save.error} />
    </Panel>
  )
}

function SourceSection({ repo }: { repo: Repo }) {
  const setSource = useAction(
    (sourceId: number) => invoke('repos:setSource', { id: repo.id, sourceId }),
    [keys.repos, ['proposals']],
  )
  return (
    <Panel
      title="3. Skill engine"
      description="Where this repo's skills come from: a git repo, a local folder, or the built-in starter."
      status={repo.skillSourceId ? done : undefined}
    >
      <SourcePicker value={repo.skillSourceId} onSelect={(id) => setSource.mutate(id)} />
      <ErrorText error={setSource.error} />
    </Panel>
  )
}

function BindingsSection({ repo }: { repo: Repo }) {
  const { data: bindings = [] } = useBindings(repo.id)
  const validated = bindings.filter((binding) => binding.skill && binding.validated).length
  return (
    <Panel
      title="4. Stage skills"
      description="Choose and validate the skill PRism runs for each stage."
      status={
        bindings.length > 0 && validated === bindings.length ? (
          done
        ) : (
          <Badge variant="warning">
            {validated}/{bindings.length || 5} validated
          </Badge>
        )
      }
    >
      <StageBindings repoId={repo.id} sourceId={repo.skillSourceId} />
    </Panel>
  )
}

const splitList = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

function OptionsSection({ repo }: { repo: Repo }) {
  const [checks, setChecks] = useState<string | null>(null)
  const [labels, setLabels] = useState<string | null>(null)
  const save = useRepoAction(
    (options: { autoRun: boolean; ignoredChecks: string[]; qaLabels: string[] }) =>
      invoke('repos:setOptions', { id: repo.id, ...options }),
  )
  const checksValue = checks ?? repo.ignoredChecks.join(', ')
  const labelsValue = labels ?? repo.qaLabels.join(', ')
  const persist = (autoRun = repo.autoRun) =>
    save.mutate(
      { autoRun, ignoredChecks: splitList(checksValue), qaLabels: splitList(labelsValue) },
      {
        onSuccess: () => {
          setChecks(null)
          setLabels(null)
        },
      },
    )

  return (
    <Panel title="5. Options" description="Optional. You can change these later in Settings.">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor={`auto-run-${repo.id}`}>Auto-run read-only stages</Label>
          <p className="text-xs text-muted-foreground">
            Start reviews and test plans as soon as a PR lands in To review.
          </p>
        </div>
        <Switch
          id={`auto-run-${repo.id}`}
          checked={repo.autoRun}
          onCheckedChange={(value) => persist(value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`checks-${repo.id}`}>CI checks expected to fail</Label>
          <Input
            id={`checks-${repo.id}`}
            placeholder="e.g. nightly-e2e, coverage"
            value={checksValue}
            onChange={(event) => setChecks(event.target.value)}
            onBlur={() => checks !== null && persist()}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`labels-${repo.id}`}>Labels meaning “QA pending”</Label>
          <Input
            id={`labels-${repo.id}`}
            placeholder="e.g. needs-qa"
            value={labelsValue}
            onChange={(event) => setLabels(event.target.value)}
            onBlur={() => labels !== null && persist()}
          />
        </div>
      </div>
      <ErrorText error={save.error} />
    </Panel>
  )
}

export function RepoSetup({ repo }: { repo: Repo }) {
  return (
    <div className="space-y-4">
      <CloneSection repo={repo} />
      <WorktreeSection repo={repo} />
      <SourceSection repo={repo} />
      <BindingsSection repo={repo} />
      <OptionsSection repo={repo} />
    </div>
  )
}
