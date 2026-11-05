import type { ReactNode } from 'react'
import { Check, Loader2, Pencil, TriangleAlert } from 'lucide-react'
import { agentModels, agentNames, stageLabels, type Repo } from '@shared/domain'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  useAgentConfig,
  useBindings,
  useConfigStatus,
  useGithubStatus,
  useRepos,
  useSources,
} from '@/lib/api'
import { originLabel } from './stage-bindings'

export type EditTarget = { step: 'github' | 'agent' | 'repos' | 'setup'; repoId?: number }

function Block({
  title,
  onEdit,
  children,
}: {
  title: ReactNode
  onEdit: () => void
  children: ReactNode
}) {
  return (
    <section className="space-y-3 rounded-2xl bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium">{title}</h3>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil />
          Edit
        </Button>
      </div>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] items-baseline gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

const mono = 'truncate font-mono text-xs select-text'

function RepoSummary({ repo, onEdit }: { repo: Repo; onEdit: (target: EditTarget) => void }) {
  const { data: sources = [] } = useSources()
  const { data: bindings = [] } = useBindings(repo.id)
  const source = sources.find((item) => item.id === repo.skillSourceId)

  return (
    <Block
      title={<span className="font-mono">{`${repo.owner}/${repo.name}`}</span>}
      onEdit={() => onEdit({ step: 'setup', repoId: repo.id })}
    >
      <div className="space-y-2">
        <Row label="Local clone">
          <p className={mono}>{repo.localPath ?? '—'}</p>
        </Row>
        <Row label="Worktrees">
          <p className={mono}>{repo.worktreeRoot ?? '—'}</p>
        </Row>
        <Row label="Skill engine">
          {source ? (
            <span>
              {source.name}
              {source.identity && (
                <span className="text-muted-foreground"> · as {source.identity}</span>
              )}
            </span>
          ) : (
            '—'
          )}
        </Row>
        <Row label="Auto-run">{repo.autoRun ? 'On (read-only stages)' : 'Off'}</Row>
        {repo.ignoredChecks.length > 0 && (
          <Row label="Expected-red checks">{repo.ignoredChecks.join(', ')}</Row>
        )}
        {repo.qaLabels.length > 0 && <Row label="QA labels">{repo.qaLabels.join(', ')}</Row>}
      </div>
      <ul className="divide-y rounded-xl border">
        {bindings.map((binding) => (
          <li key={binding.stage} className="flex items-center gap-3 px-4 py-2.5">
            <span className="w-36 shrink-0 text-sm">{stageLabels[binding.stage]}</span>
            {binding.skill ? (
              <>
                <span className="font-mono text-sm">{binding.skill.name}</span>
                <Badge variant="accent">{originLabel(binding.skill, binding.sourceName)}</Badge>
              </>
            ) : (
              <span className="text-sm text-warning">No skill</span>
            )}
            <span className="ml-auto">
              {binding.validated ? (
                <Check className="size-4 text-success" aria-label="Validated" />
              ) : (
                <TriangleAlert className="size-4 text-warning" aria-label="Not validated" />
              )}
            </span>
          </li>
        ))}
      </ul>
    </Block>
  )
}

export function Summary({ onEdit }: { onEdit: (target: EditTarget) => void }) {
  const { data: status } = useConfigStatus()
  const { data: github } = useGithubStatus()
  const { data: agent } = useAgentConfig()
  const { data: repos = [] } = useRepos()
  if (!status) return <Loader2 className="size-5 animate-spin" />

  const modelLabel = agent
    ? agent.model === ''
      ? 'Agent default'
      : (agentModels[agent.agent]?.find((model) => model.id === agent.model)?.label ?? agent.model)
    : null

  return (
    <div className="space-y-4">
      {status.valid ? (
        <p className="flex items-center gap-2 text-sm text-success">
          <Check className="size-4" />
          Everything is set. Check your choices, then open PRism.
        </p>
      ) : (
        <div className="space-y-1.5 rounded-2xl border border-warning/50 bg-warning/5 p-4">
          <p className="text-sm font-medium text-warning">A few things left</p>
          <ul className="space-y-1">
            {status.issues.map((issue) => (
              <li key={`${issue.key}-${issue.repoId}`} className="text-sm text-warning">
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Block title="GitHub" onEdit={() => onEdit({ step: 'github' })}>
        <Row label="Account">
          {github?.loggedIn ? `@${github.login ?? 'unknown'}` : 'Not connected'}
        </Row>
      </Block>
      <Block title="Agent" onEdit={() => onEdit({ step: 'agent' })}>
        <Row label="Default agent">{agent ? agentNames[agent.agent] : '—'}</Row>
        <Row label="Model">{modelLabel ?? '—'}</Row>
      </Block>
      {repos.map((repo) => (
        <RepoSummary key={repo.id} repo={repo} onEdit={onEdit} />
      ))}
    </div>
  )
}
