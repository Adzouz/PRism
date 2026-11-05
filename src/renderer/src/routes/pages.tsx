import { useQuery } from '@tanstack/react-query'
import { Archive, Bot, GitPullRequest, GitPullRequestArrow, LayoutDashboard } from 'lucide-react'
import { EmptyState, Page } from '@/components/page'
import { ThemeSwitch } from '@/components/theme-switch'

export function DashboardPage() {
  return (
    <Page title="Dashboard">
      <EmptyState
        icon={LayoutDashboard}
        title="Nothing to show yet"
        description="Add a repository to see open PRs, your review queue and daily activity."
      />
    </Page>
  )
}

export function ReviewsPage() {
  return (
    <Page title="Reviews">
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
    <Page title="My PRs">
      <EmptyState
        icon={GitPullRequestArrow}
        title="No pull requests"
        description="Pull requests you authored or took over will show up here."
      />
    </Page>
  )
}

export function ArchivePage() {
  return (
    <Page title="Archive">
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
    <Page title="Runs">
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
    <Page title="Settings">
      <div className="max-w-xl space-y-6">
        <section className="rounded-lg border bg-surface">
          <div className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="text-sm font-medium">Appearance</p>
              <p className="text-sm text-muted-foreground">Follow macOS or pick a theme.</p>
            </div>
            <ThemeSwitch showLabels />
          </div>
        </section>
        {info && (
          <p className="font-mono text-xs text-muted-foreground">
            PRism {info.version} · {info.platform}
          </p>
        )}
      </div>
    </Page>
  )
}
