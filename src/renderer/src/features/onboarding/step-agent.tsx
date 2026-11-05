import { useState } from 'react'
import { Check, Download, Loader2, LogIn, RefreshCw, TerminalSquare } from 'lucide-react'
import {
  agentCommands,
  agentModels,
  agentNames,
  type AgentConfig,
  type AgentId,
  type AgentStatus,
} from '@shared/domain'
import { ErrorText, Panel } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { invoke, keys, useAction, useAgentConfig, useAgents } from '@/lib/api'
import { cn } from '@/lib/utils'

function statusBadge(agent: AgentStatus) {
  if (!agent.installed) return <Badge>Not installed</Badge>
  if (agent.loggedIn === true) return <Badge variant="success">Signed in</Badge>
  if (agent.loggedIn === false) return <Badge variant="warning">Signed out</Badge>
  return <Badge>Login unknown</Badge>
}

function TerminalAction({ agent, action }: { agent: AgentId; action: 'install' | 'login' }) {
  const open = useAction(() => invoke('agents:openTerminal', { agent, action }))
  const Icon = action === 'install' ? Download : LogIn
  return (
    <div className="space-y-2 rounded-lg bg-surface p-3">
      <p className="font-mono text-xs break-all text-muted-foreground select-text">
        $ {agentCommands[agent][action]}
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={open.isPending}
        onClick={(event) => {
          event.stopPropagation()
          open.mutate(undefined)
        }}
      >
        <Icon />
        {action === 'install' ? 'Install in Terminal' : 'Sign in in Terminal'}
      </Button>
      <ErrorText error={open.error} />
    </div>
  )
}

function AgentCard({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentStatus
  selected: boolean
  onSelect: () => void
}) {
  const selectable = agent.installed
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-disabled={!selectable}
      tabIndex={selectable ? 0 : -1}
      onClick={() => selectable && onSelect()}
      onKeyDown={(event) => {
        if (selectable && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-background p-4 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        selectable ? 'cursor-pointer hover:border-primary/60' : 'border-dashed',
        selected && 'border-primary bg-accent/40 hover:border-primary',
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface transition-colors',
            selected && 'bg-primary text-primary-foreground',
          )}
        >
          {selected ? <Check className="size-5" /> : <TerminalSquare className="size-5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">{agentNames[agent.id]}</p>
            {statusBadge(agent)}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {agent.version ?? agent.id}
          </p>
        </div>
      </div>
      {!agent.installed && <TerminalAction agent={agent.id} action="install" />}
      {agent.installed && agent.loggedIn === false && (
        <TerminalAction agent={agent.id} action="login" />
      )}
    </div>
  )
}

function ModelPicker({
  config,
  onChange,
}: {
  config: AgentConfig
  onChange: (model: string) => void
}) {
  const models = agentModels[config.agent] ?? []
  const known = config.model === '' || models.some((model) => model.id === config.model)
  const [custom, setCustom] = useState<string | null>(known ? null : config.model)
  const options = [
    { id: '', label: 'Agent default', hint: 'As configured in the agent' },
    ...models.map((model) => ({ ...model, hint: model.id })),
  ]
  const commit = () => {
    const value = custom?.trim()
    if (value && value !== config.model) onChange(value)
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Model</p>
      <div role="radiogroup" aria-label="Model" className="grid gap-2 sm:grid-cols-3">
        {options.map((option) => {
          const checked = custom === null && config.model === option.id
          return (
            <button
              key={option.id || 'default'}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => {
                setCustom(null)
                if (!checked) onChange(option.id)
              }}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-xl border bg-background px-4 py-3 text-left outline-none transition-colors hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring',
                checked && 'border-primary bg-accent/40 hover:border-primary',
              )}
            >
              <span className="flex w-full items-center justify-between gap-2 text-sm font-medium">
                {option.label}
                {checked && <Check className="size-4 text-primary" />}
              </span>
              <span className="w-full truncate font-mono text-xs text-muted-foreground">
                {option.hint}
              </span>
            </button>
          )
        })}
        <label
          className={cn(
            'flex flex-col gap-1.5 rounded-xl border bg-background px-4 py-3',
            custom !== null && 'border-primary bg-accent/40',
          )}
        >
          <span className="text-sm font-medium">Other</span>
          <Input
            placeholder="model id"
            className="h-7 font-mono text-xs"
            value={custom ?? ''}
            onFocus={() => setCustom((value) => value ?? '')}
            onChange={(event) => setCustom(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => event.key === 'Enter' && commit()}
          />
        </label>
      </div>
    </div>
  )
}

export function StepAgent() {
  const { data: agents, isFetching, refetch } = useAgents()
  const { data: config } = useAgentConfig()
  const save = useAction(
    (value: AgentConfig) => invoke('agents:setConfig', value),
    [keys.agentConfig],
  )

  return (
    <Panel
      title="Default agent"
      description="PRism runs skills through an agent you are signed in to. Pick one, then a model used for every run."
      status={
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Detect again
        </Button>
      }
    >
      {!agents ? (
        <Loader2 className="size-5 animate-spin" />
      ) : (
        <div role="radiogroup" aria-label="Default agent" className="grid gap-3 sm:grid-cols-2">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              selected={config?.agent === agent.id}
              onSelect={() =>
                config?.agent !== agent.id && save.mutate({ agent: agent.id, model: '' })
              }
            />
          ))}
        </div>
      )}
      {agents?.some((agent) => !agent.installed || agent.loggedIn === false) && (
        <p className="text-xs text-muted-foreground">
          Install and sign-in run in Terminal so you can follow them. PRism checks again when you
          come back.
        </p>
      )}
      {config && (
        <ModelPicker
          key={config.agent}
          config={config}
          onChange={(model) => save.mutate({ ...config, model })}
        />
      )}
      <ErrorText error={save.error} />
    </Panel>
  )
}
