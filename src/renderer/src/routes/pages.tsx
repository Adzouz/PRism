import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Archive,
  ArrowUpRight,
  Bot,
  ChevronDown,
  GitPullRequest,
  GitPullRequestArrow,
  RotateCcw,
} from 'lucide-react'
import { GithubIcon } from '@/components/github-icon'
import { EmptyState, Page, QuickCard, Section } from '@/components/page'
import { ThemeSwitch } from '@/components/theme-switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RepoSetup } from '@/features/onboarding/repo-setup'
import { ResetConfiguration } from '@/features/onboarding/reset'
import { StepAgent } from '@/features/onboarding/step-agent'
import { StepGithub } from '@/features/onboarding/step-github'
import { StepRepos } from '@/features/onboarding/step-repos'
import { useConfigStatus, useRepos, useSkillsChanged } from '@/lib/api'
import { cn } from '@/lib/utils'

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function DashboardPage() {
  const { data: status } = useConfigStatus()
  return (
    <div className="pb-10">
      <div className="space-y-10">
        <section className="drag relative overflow-hidden rounded-2xl bg-surface px-10 py-14">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--primary)_0%,transparent_60%)] opacity-35" />
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,var(--accent-foreground)_0%,transparent_55%)] opacity-15" />
          <div className="relative space-y-3">
            <p className="text-sm font-medium text-accent-foreground">Dashboard</p>
            <h1 className="text-5xl font-semibold tracking-tight">{greeting()}</h1>
            <p className="text-lg text-muted-foreground">
              Your reviews, your pull requests and your agents, in one place.
            </p>
          </div>
        </section>

        {status && !status.valid && (
          <Link
            to="/onboarding"
            className="flex items-center gap-4 rounded-2xl bg-primary p-5 text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <div className="flex size-12 items-center justify-center rounded-full bg-white/15">
              <GithubIcon className="size-5" />
            </div>
            <div className="flex-1">
              <p className="text-lg font-medium">Finish setting up PRism</p>
              <p className="text-sm text-primary-foreground/75">
                {status.issues[0]?.message ?? 'Some settings need your attention.'}
              </p>
            </div>
            <ArrowUpRight className="size-5" />
          </Link>
        )}

        <Section title="Quick access">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <QuickCard
              to="/reviews"
              icon={GitPullRequest}
              label="Reviews"
              description="Pull requests waiting for your review"
              meta="0 to review"
            />
            <QuickCard
              to="/my-prs"
              icon={GitPullRequestArrow}
              label="My PRs"
              description="What you authored or took over"
              meta="0 open"
            />
            <QuickCard
              to="/runs"
              icon={Bot}
              label="Runs"
              description="Agents reviewing and addressing comments"
              meta="0 running"
            />
          </div>
        </Section>
      </div>
    </div>
  )
}

export function ReviewsPage() {
  return (
    <Page
      eyebrow="Pull requests"
      title="Reviews"
      description="Pull requests from others that need your review."
    >
      <EmptyState
        icon={GitPullRequest}
        title="No reviews"
        description="Pull requests that request your review will show up here."
      />
    </Page>
  )
}

export function MyPrsPage() {
  return (
    <Page
      eyebrow="Pull requests"
      title="My PRs"
      description="Pull requests you authored or took over."
    >
      <EmptyState
        icon={GitPullRequestArrow}
        title="No pull requests"
        description="Your open pull requests will show up here."
      />
    </Page>
  )
}

export function ArchivePage() {
  return (
    <Page eyebrow="Pull requests" title="Archive" description="Kept out of the way, restorable.">
      <EmptyState
        icon={Archive}
        title="Archive is empty"
        description="Archived pull requests are kept here and can be restored."
      />
    </Page>
  )
}

export function RunsPage() {
  return (
    <Page eyebrow="Agents" title="Runs" description="Every agent run, live and past.">
      <EmptyState
        icon={Bot}
        title="No agent runs"
        description="Review and address-comments runs will stream here live."
      />
    </Page>
  )
}

export function SettingsPage() {
  const { data: info } = useQuery({
    queryKey: ['app', 'info'],
    queryFn: () => window.prism.invoke('app:info'),
  })

  useSkillsChanged()
  const { data: repos = [] } = useRepos()
  const { data: status } = useConfigStatus()
  const [open, setOpen] = useState<number | null>(null)

  return (
    <Page eyebrow="Preferences" title="Settings">
      <Section title="GitHub">
        <div className="max-w-3xl">
          <StepGithub />
        </div>
      </Section>
      <Section title="Agent">
        <div className="max-w-3xl">
          <StepAgent />
        </div>
      </Section>
      <Section title="Repositories">
        <div className="max-w-3xl space-y-3">
          <StepRepos />
          {repos.map((repo) => {
            const issues = status?.issues.filter((issue) => issue.repoId === repo.id) ?? []
            const expanded = open === repo.id
            return (
              <div key={repo.id} className="rounded-2xl border">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : repo.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-2xl px-5 py-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-mono text-sm">
                    {repo.owner}/{repo.name}
                  </span>
                  <span className="flex items-center gap-2">
                    {issues.length > 0 ? (
                      <Badge variant="warning">{issues.length} to fix</Badge>
                    ) : (
                      <Badge variant="success">Ready</Badge>
                    )}
                    <ChevronDown
                      className={cn('size-4 transition-transform', expanded && 'rotate-180')}
                    />
                  </span>
                </button>
                {expanded && (
                  <div className="border-t p-4">
                    <RepoSetup repo={repo} />
                  </div>
                )}
              </div>
            )
          })}
          <Button variant="outline" asChild>
            <Link to="/onboarding">
              <RotateCcw />
              Run onboarding again
            </Link>
          </Button>
        </div>
      </Section>
      <Section title="Appearance">
        <div className="flex max-w-2xl items-center justify-between gap-4 rounded-2xl bg-surface p-5">
          <div>
            <p className="text-base font-medium">Theme</p>
            <p className="text-sm text-muted-foreground">Follow macOS or pick one.</p>
          </div>
          <ThemeSwitch showLabels />
        </div>
      </Section>
      <Section title="Danger zone">
        <ResetConfiguration />
      </Section>
      {info && (
        <p className="font-mono text-xs text-muted-foreground">
          PRism {info.version} · {info.platform}
        </p>
      )}
    </Page>
  )
}
