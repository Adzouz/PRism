import { useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Loader2 } from 'lucide-react'
import logo from '@/assets/logo.png'
import { ErrorText } from '@/components/page'
import { Button } from '@/components/ui/button'
import {
  invoke,
  keys,
  useAction,
  useAgentConfig,
  useConfigStatus,
  useGithubStatus,
  useRepos,
  useSkillsChanged,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { InitialScan } from './initial-scan'
import { RepoSetup } from './repo-setup'
import { StepAgent } from './step-agent'
import { StepGithub } from './step-github'
import { StepRepos } from './step-repos'
import { Summary, type EditTarget } from './summary'

const steps = [
  { id: 'github', label: 'GitHub', title: 'Connect GitHub' },
  { id: 'agent', label: 'Agent', title: 'Pick your agent' },
  { id: 'repos', label: 'Repositories', title: 'Add repositories' },
  { id: 'setup', label: 'Repository setup', title: 'Set up each repository' },
  { id: 'finish', label: 'Review', title: 'Review your setup' },
] as const

type StepId = (typeof steps)[number]['id']

function RepoTabs({
  selected,
  onSelect,
}: {
  selected: number | null
  onSelect: (id: number) => void
}) {
  const { data: repos = [] } = useRepos()
  const { data: status } = useConfigStatus()
  const current = repos.find((repo) => repo.id === selected) ?? repos[0]
  if (!current) return <p className="text-sm text-muted-foreground">Add a repository first.</p>

  return (
    <div className="space-y-5">
      {repos.length > 1 && (
        <div role="tablist" className="flex flex-wrap gap-2">
          {repos.map((repo) => {
            const ready = !status?.issues.some((issue) => issue.repoId === repo.id)
            return (
              <button
                key={repo.id}
                role="tab"
                type="button"
                aria-selected={repo.id === current.id}
                onClick={() => onSelect(repo.id)}
                className="flex items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-sm outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring aria-selected:bg-foreground aria-selected:text-background"
              >
                {ready && <Check className="size-3.5 text-success" />}
                {repo.owner}/{repo.name}
              </button>
            )
          })}
        </div>
      )}
      <RepoSetup key={current.id} repo={current} />
    </div>
  )
}

export function OnboardingPage() {
  useSkillsChanged()
  const [step, setStep] = useState<StepId>('github')
  const [repoTab, setRepoTab] = useState<number | null>(null)
  const [scanning, setScanning] = useState(false)
  const edit = (target: EditTarget) => {
    if (target.repoId) setRepoTab(target.repoId)
    setStep(target.step)
    document.querySelector('main')?.scrollTo({ top: 0 })
  }
  const { data: github } = useGithubStatus()
  const { data: agent } = useAgentConfig()
  const { data: repos = [] } = useRepos()
  const { data: status } = useConfigStatus()
  const complete = useAction(() => invoke('onboarding:complete'), [keys.config])

  const doneByStep: Record<StepId, boolean> = {
    github: Boolean(github?.loggedIn),
    agent: Boolean(agent),
    repos: repos.length > 0,
    setup: repos.length > 0 && !status?.issues.some((issue) => issue.repoId !== null),
    finish: Boolean(status?.valid && status.onboarded),
  }

  const index = steps.findIndex((item) => item.id === step)
  const current = steps[index]!
  const next = steps[index + 1]
  const previous = steps[index - 1]

  return (
    <div className="flex h-full">
      <div className="drag fixed inset-x-0 top-0 z-50 h-8" />
      <aside className="flex w-64 shrink-0 flex-col gap-8 px-6 pt-20">
        <div className="flex items-center gap-2">
          <img src={logo} alt="" className="size-8" draggable={false} />
          <span className="text-base font-semibold tracking-tight">PRism</span>
        </div>
        <ol className="space-y-1">
          {steps.map((item, itemIndex) => (
            <li key={item.id}>
              <button
                type="button"
                aria-current={item.id === step ? 'step' : undefined}
                onClick={() => setStep(item.id)}
                className={cn(
                  'flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] text-muted-foreground outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring',
                  item.id === step &&
                    'bg-foreground font-medium text-background hover:bg-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full border text-xs',
                    doneByStep[item.id] && 'border-success bg-success text-background',
                  )}
                >
                  {doneByStep[item.id] ? <Check className="size-3.5" /> : itemIndex + 1}
                </span>
                {item.label}
              </button>
            </li>
          ))}
        </ol>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto px-10 pt-16 pb-28">
        <div className="mx-auto max-w-3xl space-y-8">
          <header className="space-y-2">
            <p className="text-sm font-medium text-accent-foreground">
              {scanning ? 'Almost there' : `Step ${index + 1} of ${steps.length}`}
            </p>
            <h1 className="text-4xl font-semibold tracking-tight">
              {scanning ? 'Scanning your pull requests' : current.title}
            </h1>
          </header>
          {scanning && <InitialScan />}
          {!scanning && step === 'github' && <StepGithub />}
          {!scanning && step === 'agent' && <StepAgent />}
          {!scanning && step === 'repos' && <StepRepos />}
          {!scanning && step === 'setup' && <RepoTabs selected={repoTab} onSelect={setRepoTab} />}
          {!scanning && step === 'finish' && <Summary onEdit={edit} />}
          <ErrorText error={complete.error} />
        </div>
      </main>
      <footer
        hidden={scanning}
        className="fixed right-0 bottom-0 left-64 flex justify-between border-t bg-background/90 px-10 py-4 backdrop-blur"
      >
        <Button
          variant="ghost"
          disabled={!previous}
          onClick={() => previous && setStep(previous.id)}
        >
          <ArrowLeft />
          Back
        </Button>
        {next ? (
          <Button disabled={!doneByStep[step]} onClick={() => setStep(next.id)}>
            Continue
            <ArrowRight />
          </Button>
        ) : (
          <Button
            disabled={!status?.valid || complete.isPending}
            onClick={() => complete.mutate(undefined, { onSuccess: () => setScanning(true) })}
          >
            {complete.isPending && <Loader2 className="animate-spin" />}
            Open PRism
          </Button>
        )}
      </footer>
    </div>
  )
}
