import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Archive, ArrowUpRight, Bot, GitPullRequest, GitPullRequestArrow } from 'lucide-react'
import { GithubIcon } from '@/components/github-icon'
import { EmptyState, Page, QuickCard, Section } from '@/components/page'
import { ThemeSwitch } from '@/components/theme-switch'

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

export function DashboardPage() {
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

        <Link
          to="/settings"
          className="flex items-center gap-4 rounded-2xl bg-primary p-5 text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <div className="flex size-12 items-center justify-center rounded-full bg-white/15">
            <GithubIcon className="size-5" />
          </div>
          <div className="flex-1">
            <p className="text-lg font-medium">Connect GitHub and add a repository</p>
            <p className="text-sm text-primary-foreground/75">
              PRism uses your gh login. Nothing is posted without your go.
            </p>
          </div>
          <ArrowUpRight className="size-5" />
        </Link>

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

  return (
    <Page eyebrow="Preferences" title="Settings">
      <Section title="Appearance">
        <div className="flex max-w-2xl items-center justify-between gap-4 rounded-2xl bg-surface p-5">
          <div>
            <p className="text-base font-medium">Theme</p>
            <p className="text-sm text-muted-foreground">Follow macOS or pick one.</p>
          </div>
          <ThemeSwitch showLabels />
        </div>
      </Section>
      {info && (
        <p className="font-mono text-xs text-muted-foreground">
          PRism {info.version} · {info.platform}
        </p>
      )}
    </Page>
  )
}
