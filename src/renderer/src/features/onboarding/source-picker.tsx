import { useEffect, useState } from 'react'
import { FolderOpen, Loader2, Play, RefreshCw, Search } from 'lucide-react'
import type { SkillSource } from '@shared/domain'
import { ErrorText } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { invoke, keys, useAction, useSources } from '@/lib/api'

export const defaultSource = 'mattpocock/skills'

type Located = Awaited<ReturnType<typeof invoke<'sources:locate'>>>

export function SourceLocator({ onReady }: { onReady: (source: SkillSource) => void }) {
  const [input, setInput] = useState(defaultSource)
  const [installPath, setInstallPath] = useState('')
  const [located, setLocated] = useState<Located | null>(null)
  const locate = useAction((value: string) => invoke('sources:locate', value))
  const add = useAction(
    (value: { input: string; path: string }) => invoke('sources:add', value),
    [keys.sources],
  )
  const install = useAction(
    (value: { input: string; path: string }) => invoke('sources:install', value),
    [keys.sources],
  )

  const runLocate = (value: string) =>
    locate.mutate(value, {
      onSuccess: (result) => {
        setLocated(result)
        setInstallPath(result.defaultInstallPath)
      },
    })

  const pickFolder = async () => {
    const path = await invoke('dialog:pickFolder', { title: 'Choose a skills folder' })
    if (!path) return
    setInput(path)
    runLocate(path)
  }

  const busy = locate.isPending || add.isPending || install.isPending

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (input.trim()) runLocate(input.trim())
        }}
      >
        <Input
          aria-label="Skill source"
          placeholder="Git URL, owner/name or folder path"
          value={input}
          onChange={(event) => {
            setInput(event.target.value)
            setLocated(null)
          }}
        />
        <Button type="submit" variant="outline" disabled={!input.trim() || busy}>
          {locate.isPending ? <Loader2 className="animate-spin" /> : <Search />}
          Locate
        </Button>
        <Button type="button" variant="outline" onClick={() => void pickFolder()} disabled={busy}>
          <FolderOpen />
          Folder…
        </Button>
      </form>
      {locate.isPending && (
        <p className="text-sm text-muted-foreground">Looking for an existing clone…</p>
      )}
      {located && (
        <div className="space-y-3 rounded-xl border p-4">
          {located.candidates.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {located.kind === 'local' ? 'Folder' : 'Found on this Mac'}
              </p>
              {located.candidates.map((path) => (
                <div key={path} className="flex items-center justify-between gap-3">
                  <span className="truncate font-mono text-xs select-text">{path}</span>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => add.mutate({ input: located.key, path }, { onSuccess: onReady })}
                  >
                    Use
                  </Button>
                </div>
              ))}
            </div>
          ) : located.kind === 'local' ? (
            <p className="text-sm text-destructive">This folder does not exist.</p>
          ) : (
            <p className="text-sm text-muted-foreground">No clone of {located.name} found.</p>
          )}
          {located.kind === 'git' && (
            <div className="space-y-2">
              <p className="text-sm font-medium">
                {located.candidates.length > 0 ? 'Or clone a fresh copy' : 'Clone it'}
              </p>
              <div className="flex gap-2">
                <Input
                  aria-label="Install folder"
                  className="font-mono text-xs"
                  value={installPath}
                  onChange={(event) => setInstallPath(event.target.value)}
                />
                <Button
                  disabled={busy || !installPath.trim()}
                  onClick={() =>
                    install.mutate(
                      { input: located.key, path: installPath.trim() },
                      { onSuccess: onReady },
                    )
                  }
                >
                  {install.isPending && <Loader2 className="animate-spin" />}
                  Clone
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      <ErrorText error={locate.error ?? add.error ?? install.error} />
    </div>
  )
}

function useSourceLog(sourceId: number) {
  const [log, setLog] = useState('')
  useEffect(
    () =>
      window.prism.on('source:log', (event) => {
        if (event.sourceId === sourceId) setLog((current) => current + event.chunk)
      }),
    [sourceId],
  )
  return [log, setLog] as const
}

function SourceSetup({ source }: { source: SkillSource }) {
  const [log, setLog] = useSourceLog(source.id)
  const bootstrap = useAction((id: number) => invoke('sources:bootstrap', id), [keys.sources])
  const commands = [...(source.manifest?.setup ?? [])]
  if (source.manifest?.health) commands.push(source.manifest.health)
  if (commands.length === 0) return null

  return (
    <div className="space-y-2 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Setup</p>
          <p className="text-xs text-muted-foreground">
            This source asks to run these commands in its folder. Check them before running.
          </p>
        </div>
        {source.needsSetup ? (
          <Button
            size="sm"
            disabled={bootstrap.isPending}
            onClick={() => {
              setLog('')
              bootstrap.mutate(source.id)
            }}
          >
            {bootstrap.isPending ? <Loader2 className="animate-spin" /> : <Play />}
            Run setup
          </Button>
        ) : (
          <Badge variant="success">Done</Badge>
        )}
      </div>
      <pre className="rounded-lg bg-background p-3 font-mono text-xs whitespace-pre-wrap select-text">
        {commands.map((command) => `$ ${command}`).join('\n')}
      </pre>
      {log && (
        <pre className="max-h-56 overflow-y-auto rounded-lg bg-background p-3 font-mono text-xs whitespace-pre-wrap select-text">
          {log}
        </pre>
      )}
      {bootstrap.data && !bootstrap.data.ok && (
        <p className="text-sm text-destructive">Setup failed. Fix the error and run it again.</p>
      )}
      <ErrorText error={bootstrap.error} />
    </div>
  )
}

export function kindLabel(source: SkillSource) {
  if (source.kind === 'builtin') return 'Built-in'
  if (source.kind === 'local') return 'Local folder'
  return 'Git'
}

export function SourceCard({ source, onChange }: { source: SkillSource; onChange?: () => void }) {
  const sync = useAction(
    (id: number) => invoke('sources:sync', id),
    [keys.sources, keys.skills, ['bindings'], ['proposals'], ['sources', source.id, 'scan']],
  )
  const setIdentity = useAction(
    (identity: string | null) => invoke('sources:setIdentity', { id: source.id, identity }),
    [keys.sources, ['proposals']],
  )

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 rounded-xl border p-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{source.name}</p>
            <Badge>{kindLabel(source)}</Badge>
            {source.manifest && <Badge variant="accent">prism-source.json</Badge>}
          </div>
          {source.localPath && source.kind !== 'builtin' && (
            <p className="truncate font-mono text-xs text-muted-foreground select-text">
              {source.localPath}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {source.kind === 'git' && (
            <Button
              variant="outline"
              size="sm"
              disabled={sync.isPending}
              onClick={() => sync.mutate(source.id)}
            >
              {sync.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Pull
            </Button>
          )}
          {onChange && (
            <Button variant="ghost" size="sm" onClick={onChange}>
              Change
            </Button>
          )}
        </div>
      </div>
      {sync.data && !sync.data.ok && (
        <pre className="rounded-lg bg-background p-3 font-mono text-xs whitespace-pre-wrap text-destructive select-text">
          {sync.data.output}
        </pre>
      )}
      <ErrorText error={sync.error} />
      <SourceSetup source={source} />
      {source.identities.length > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border p-4">
          <div>
            <p className="text-sm font-medium">Who are you?</p>
            <p className="text-xs text-muted-foreground">
              This source keeps skills per person. PRism proposes yours first.
            </p>
          </div>
          <NativeSelect
            aria-label="Identity"
            value={source.identity ?? ''}
            onChange={(event) => setIdentity.mutate(event.target.value || null)}
          >
            <option value="">Pick…</option>
            {source.identities.map((identity) => (
              <option key={identity} value={identity}>
                {identity}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
    </div>
  )
}

export function SourcePicker({
  value,
  onSelect,
}: {
  value: number | null
  onSelect: (sourceId: number) => void
}) {
  const { data: sources = [] } = useSources()
  const [changing, setChanging] = useState(false)
  const builtin = useAction(() => invoke('sources:builtin'), [keys.sources])
  const current = sources.find((source) => source.id === value)

  if (current && !changing) {
    return <SourceCard source={current} onChange={() => setChanging(true)} />
  }

  const others = sources.filter((source) => source.kind !== 'builtin')
  const choose = (id: number) => {
    setChanging(false)
    onSelect(id)
  }

  return (
    <div className="space-y-3">
      {others.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {others.map((source) => (
            <Button key={source.id} variant="outline" size="sm" onClick={() => choose(source.id)}>
              {source.name}
            </Button>
          ))}
        </div>
      )}
      <SourceLocator onReady={(source) => choose(source.id)} />
      <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>No skills repo? PRism ships a small starter set.</span>
        <Button
          variant="link"
          size="sm"
          onClick={() => builtin.mutate(undefined, { onSuccess: (source) => choose(source.id) })}
        >
          Use built-in starter
        </Button>
      </div>
      {current && (
        <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
          Cancel
        </Button>
      )}
    </div>
  )
}
