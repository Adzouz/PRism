import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, FileText, Loader2, TriangleAlert, Wand2 } from 'lucide-react'
import {
  stageLabels,
  type EffectiveBinding,
  type Proposal,
  type Skill,
  type SkillSource,
  type Stage,
} from '@shared/domain'
import { ErrorText } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input, Label, NativeSelect, Textarea } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  errorMessage,
  invoke,
  keys,
  useBindings,
  useProposals,
  useScan,
  useSources,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { SourceLocator } from './source-picker'

type ImportMode = 'copy' | 'link'

export function originLabel(skill: Skill, sourceName: string | null) {
  if (skill.mode === 'custom') return 'Custom'
  if (skill.mode === 'linked_file') return 'Linked file'
  const from = sourceName ?? 'unknown source'
  return skill.mode === 'link' ? `Linked · ${from}` : `Imported · ${from}`
}

const reasonLabels: Record<Proposal['reason'], string> = {
  hint: 'Stage hint',
  match: 'Name match',
  builtin: 'Built-in starter',
  none: '',
}

function useBindingActions(repoId: number | null) {
  const client = useQueryClient()
  const [pending, setPending] = useState<Stage | 'all' | null>(null)
  const [error, setError] = useState<unknown>(null)

  const refresh = async () => {
    await Promise.all(
      [keys.bindings(repoId), keys.skills, keys.config].map((queryKey) =>
        client.invalidateQueries({ queryKey }),
      ),
    )
  }

  const run = async (key: Stage | 'all', task: () => Promise<unknown>) => {
    setPending(key)
    setError(null)
    try {
      await task()
      await refresh()
      return true
    } catch (caught) {
      setError(caught)
      return false
    } finally {
      setPending(null)
    }
  }

  const bindImported = async (
    stage: Stage,
    from: { sourceId: number; relDir: string },
    mode: ImportMode,
  ) => {
    const skill = await invoke('skills:import', { ...from, mode })
    await invoke('bindings:set', { repoId, stage, skillId: skill.id, validated: true })
  }

  return { pending, error, run, bindImported }
}

export function StageBindings({ repoId, sourceId }: { repoId: number; sourceId: number | null }) {
  const { data: bindings } = useBindings(repoId)
  const { data: proposals } = useProposals(sourceId)
  const [mode, setMode] = useState<ImportMode>('copy')
  const [picking, setPicking] = useState<Stage | null>(null)
  const actions = useBindingActions(repoId)

  if (!bindings || !proposals) return <Loader2 className="size-5 animate-spin" />

  const unbound = bindings.filter((binding) => !binding.skill)
  const usable = unbound
    .map((binding) => proposals.find((proposal) => proposal.stage === binding.stage))
    .filter((proposal): proposal is Proposal => Boolean(proposal?.sourceId && proposal.relDir))

  const pendingBound = bindings.filter((binding) => binding.skill && !binding.validated)
  const remaining = usable.length + pendingBound.length

  const validateAll = () =>
    actions.run('all', async () => {
      for (const proposal of usable) {
        await actions.bindImported(
          proposal.stage,
          { sourceId: proposal.sourceId!, relDir: proposal.relDir! },
          mode,
        )
      }
      for (const binding of pendingBound) {
        await invoke('bindings:validate', {
          repoId: binding.inherited ? null : repoId,
          stage: binding.stage,
          validated: true,
        })
      }
    })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          Import as
          <ToggleGroup
            type="single"
            value={mode}
            aria-label="Import mode"
            onValueChange={(value) => value && setMode(value as ImportMode)}
          >
            <ToggleGroupItem value="copy" title="You own the copy, it can diverge">
              Copy
            </ToggleGroupItem>
            <ToggleGroupItem value="link" title="Tracks the source, updated on pull">
              Link
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {remaining > 1 && (
          <Button
            size="sm"
            variant="outline"
            disabled={actions.pending !== null}
            onClick={() => void validateAll()}
          >
            {actions.pending === 'all' ? <Loader2 className="animate-spin" /> : <Wand2 />}
            Validate all ({remaining})
          </Button>
        )}
      </div>
      <ul className="space-y-2">
        {bindings.map((binding) => (
          <StageRow
            key={binding.stage}
            binding={binding}
            proposal={proposals.find((proposal) => proposal.stage === binding.stage)}
            busy={actions.pending === binding.stage || actions.pending === 'all'}
            disabled={actions.pending !== null}
            onUseProposal={(proposal) =>
              void actions.run(binding.stage, () =>
                actions.bindImported(
                  binding.stage,
                  { sourceId: proposal.sourceId!, relDir: proposal.relDir! },
                  mode,
                ),
              )
            }
            onValidate={(validated) =>
              void actions.run(binding.stage, () =>
                invoke('bindings:validate', {
                  repoId: binding.inherited ? null : repoId,
                  stage: binding.stage,
                  validated,
                }),
              )
            }
            onPick={() => setPicking(binding.stage)}
          />
        ))}
      </ul>
      <ErrorText error={actions.error} />
      <Dialog open={picking !== null} onOpenChange={(open) => !open && setPicking(null)}>
        {picking && (
          <SkillPicker
            stage={picking}
            sourceId={sourceId}
            mode={mode}
            error={actions.error}
            onPicked={async (pick) => {
              const ok = await actions.run(picking, async () => {
                const skill =
                  pick.kind === 'import'
                    ? await invoke('skills:import', { ...pick.from, mode })
                    : pick.skill
                await invoke('bindings:set', {
                  repoId,
                  stage: picking,
                  skillId: skill.id,
                  validated: true,
                })
              })
              if (ok) setPicking(null)
            }}
          />
        )}
      </Dialog>
    </div>
  )
}

function StageRow({
  binding,
  proposal,
  busy,
  disabled,
  onUseProposal,
  onValidate,
  onPick,
}: {
  binding: EffectiveBinding
  proposal: Proposal | undefined
  busy: boolean
  disabled: boolean
  onUseProposal: (proposal: Proposal) => void
  onValidate: (validated: boolean) => void
  onPick: () => void
}) {
  const missing = !binding.skill && !proposal?.skillName
  return (
    <li
      className={cn(
        'flex items-center gap-4 rounded-xl border bg-background px-4 py-3',
        missing && 'border-warning/60 bg-warning/5',
        binding.validated && 'border-success/40',
      )}
    >
      <div className="w-36 shrink-0 text-sm font-medium">{stageLabels[binding.stage]}</div>
      <div className="min-w-0 flex-1">
        {binding.skill ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{binding.skill.name}</span>
            <Badge variant="accent">{originLabel(binding.skill, binding.sourceName)}</Badge>
            {binding.inherited && <Badge>Global default</Badge>}
          </div>
        ) : proposal?.skillName ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Proposed</span>
            <span className="font-mono text-sm">{proposal.skillName}</span>
            <Badge>{reasonLabels[proposal.reason]}</Badge>
          </div>
        ) : (
          <span className="flex items-center gap-2 text-sm text-warning">
            <TriangleAlert className="size-4" />
            No skill for this stage
          </span>
        )}
        {binding.skill?.description && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {binding.skill.description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <Button size="sm" variant="ghost" disabled={disabled} onClick={onPick}>
          {missing ? 'Fill…' : 'Change'}
        </Button>
        {binding.skill ? (
          <Button
            size="sm"
            variant={binding.validated ? 'secondary' : 'default'}
            disabled={disabled}
            aria-pressed={binding.validated}
            title={binding.validated ? 'Click to unvalidate' : undefined}
            onClick={() => onValidate(!binding.validated)}
          >
            <Check />
            {binding.validated ? 'Validated' : 'Validate'}
          </Button>
        ) : (
          proposal?.skillName && (
            <Button size="sm" disabled={disabled} onClick={() => onUseProposal(proposal)}>
              <Check />
              Validate
            </Button>
          )
        )}
      </div>
    </li>
  )
}

type Pick =
  { kind: 'import'; from: { sourceId: number; relDir: string } } | { kind: 'skill'; skill: Skill }

function SkillPicker({
  stage,
  sourceId,
  mode,
  error,
  onPicked,
}: {
  stage: Stage
  sourceId: number | null
  mode: ImportMode
  error: unknown
  onPicked: (pick: Pick) => Promise<void>
}) {
  const [tab, setTab] = useState<'source' | 'other' | 'custom'>(sourceId ? 'source' : 'other')
  return (
    <DialogContent
      title={`Skill for ${stageLabels[stage]}`}
      description={`Picking a skill validates it for this stage. Imports use ${mode} mode.`}
    >
      <div className="space-y-4">
        <ToggleGroup
          type="single"
          value={tab}
          onValueChange={(value) => value && setTab(value as typeof tab)}
        >
          {sourceId && <ToggleGroupItem value="source">This source</ToggleGroupItem>}
          <ToggleGroupItem value="other">Another source</ToggleGroupItem>
          <ToggleGroupItem value="custom">Custom</ToggleGroupItem>
        </ToggleGroup>
        {tab === 'source' && sourceId && (
          <SourceSkillList sourceId={sourceId} onPicked={onPicked} />
        )}
        {tab === 'other' && <OtherSource exclude={sourceId} onPicked={onPicked} />}
        {tab === 'custom' && <CustomSkill stage={stage} onPicked={onPicked} />}
        <ErrorText error={error} />
      </div>
    </DialogContent>
  )
}

function SourceSkillList({
  sourceId,
  onPicked,
}: {
  sourceId: number
  onPicked: (pick: Pick) => Promise<void>
}) {
  const { data: sources = [] } = useSources()
  const { data: scanned, isLoading, error } = useScan(sourceId)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const source = sources.find((item) => item.id === sourceId)

  if (isLoading) return <Loader2 className="size-5 animate-spin" />
  if (error) return <ErrorText error={error} />
  const filtered = (scanned ?? []).filter((skill) =>
    `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()),
  )

  return (
    <div className="space-y-3">
      <Input
        placeholder="Filter skills"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {filtered.length === 0 && <p className="text-sm text-muted-foreground">No skills found.</p>}
      <ul className="space-y-1.5">
        {filtered.map((skill) => {
          const other = skill.identity && source?.identity && skill.identity !== source.identity
          return (
            <li key={skill.relDir} className="flex items-center gap-3 rounded-lg border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">{skill.name}</span>
                  {skill.identity && (
                    <Badge variant={other ? 'default' : 'accent'}>
                      {other ? skill.identity : 'yours'}
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{skill.description}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                title={
                  other && source?.manifest?.import ? 'Runs the source import command' : undefined
                }
                onClick={async () => {
                  setBusy(skill.relDir)
                  await onPicked({ kind: 'import', from: { sourceId, relDir: skill.relDir } })
                  setBusy(null)
                }}
              >
                {busy === skill.relDir && <Loader2 className="animate-spin" />}
                Use
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function OtherSource({
  exclude,
  onPicked,
}: {
  exclude: number | null
  onPicked: (pick: Pick) => Promise<void>
}) {
  const { data: sources = [] } = useSources()
  const choices = sources.filter((source) => source.id !== exclude)
  const [selected, setSelected] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const current = selected ?? choices[0]?.id ?? null

  return (
    <div className="space-y-3">
      {choices.length > 0 && !adding && (
        <div className="flex items-center gap-2">
          <NativeSelect
            aria-label="Source"
            className="flex-1"
            value={current ?? ''}
            onChange={(event) => setSelected(Number(event.target.value))}
          >
            {choices.map((source: SkillSource) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </NativeSelect>
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add source
          </Button>
        </div>
      )}
      {adding || choices.length === 0 ? (
        <SourceLocator
          onReady={(source) => {
            setSelected(source.id)
            setAdding(false)
          }}
        />
      ) : (
        current !== null && <SourceSkillList sourceId={current} onPicked={onPicked} />
      )}
    </div>
  )
}

function CustomSkill({
  stage,
  onPicked,
}: {
  stage: Stage
  onPicked: (pick: Pick) => Promise<void>
}) {
  const [name, setName] = useState(`my-${stage}`)
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const attempt = async (task: () => Promise<Skill>) => {
    setBusy(true)
    setError(null)
    try {
      await onPicked({ kind: 'skill', skill: await task() })
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const fromFile = async (fileMode: ImportMode) => {
    const path = await invoke('dialog:pickFile', {
      title: 'Choose a skill file',
      extensions: ['md'],
    })
    if (path) await attempt(() => invoke('skills:addFile', { path, mode: fileMode }))
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-xl border p-4">
        <p className="text-sm font-medium">From a file</p>
        <p className="text-xs text-muted-foreground">
          Copy it into the library, or link it: PRism picks up your edits automatically.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void fromFile('copy')}>
            <FileText />
            Copy a file…
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void fromFile('link')}>
            <FileText />
            Link a file…
          </Button>
        </div>
      </div>
      <div className="space-y-2 rounded-xl border p-4">
        <p className="text-sm font-medium">Write one</p>
        <div className="space-y-1.5">
          <Label htmlFor="custom-name">Name</Label>
          <Input id="custom-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <Textarea
          aria-label="Skill instructions"
          placeholder="Instructions for the agent. Markdown. Frontmatter is added for you."
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
        <Button
          size="sm"
          disabled={busy || !name.trim() || !content.trim()}
          onClick={() => void attempt(() => invoke('skills:createCustom', { name, content }))}
        >
          {busy && <Loader2 className="animate-spin" />}
          Save and use
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
