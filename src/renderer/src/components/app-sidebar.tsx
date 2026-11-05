import { Link } from '@tanstack/react-router'
import {
  Archive,
  Bot,
  GitPullRequest,
  GitPullRequestArrow,
  LayoutDashboard,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import logo from '@/assets/logo.png'
import { GithubIcon } from '@/components/github-icon'
import { useGithubStatus } from '@/lib/api'

type NavItem = { to: string; label: string; icon: LucideIcon }

const groups: { label?: string; items: NavItem[] }[] = [
  { items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    label: 'Pull requests',
    items: [
      { to: '/reviews', label: 'Reviews', icon: GitPullRequest },
      { to: '/my-prs', label: 'My PRs', icon: GitPullRequestArrow },
      { to: '/archive', label: 'Archive', icon: Archive },
    ],
  },
  { label: 'Agents', items: [{ to: '/runs', label: 'Runs', icon: Bot }] },
]

const itemClass =
  'flex h-10 items-center gap-3 rounded-xl px-3 text-[15px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&.active]:bg-foreground [&.active]:font-medium [&.active]:text-background outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar'

function NavLink({ to, label, icon: Icon }: NavItem) {
  return (
    <Link to={to} className={itemClass} activeOptions={{ exact: to === '/' }}>
      <Icon className="size-[18px]" strokeWidth={1.75} />
      {label}
    </Link>
  )
}

function githubLabel(status: ReturnType<typeof useGithubStatus>['data']) {
  if (!status) return 'Checking…'
  if (!status.loggedIn) return 'Not connected'
  return status.login ? `@${status.login}` : 'Connected'
}

export function AppSidebar() {
  const { data: github } = useGithubStatus()
  return (
    <aside className="flex w-60 shrink-0 flex-col rounded-2xl border border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="drag h-12 shrink-0" />
      <div className="flex items-center gap-2 px-4 pb-5">
        <img src={logo} alt="" className="size-8" draggable={false} />
        <span className="text-base font-semibold tracking-tight">PRism</span>
      </div>
      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-1">
        {groups.map((group, index) => (
          <div key={group.label ?? index} className="flex flex-col gap-1">
            {group.label && (
              <p className="px-3 pb-1 text-[11px] font-medium tracking-[0.12em] text-muted-foreground uppercase">
                {group.label}
              </p>
            )}
            {group.items.map((item) => (
              <NavLink key={item.to} {...item} />
            ))}
          </div>
        ))}
      </nav>
      <div className="mx-3 border-t border-sidebar-border pt-3">
        <NavLink to="/settings" label="Settings" icon={Settings} />
      </div>
      <div className="m-3 flex items-center gap-3 rounded-xl bg-sidebar-accent p-2.5">
        <div className="flex size-9 items-center justify-center rounded-full bg-background">
          <GithubIcon
            className={github?.loggedIn ? 'size-4 text-foreground' : 'size-4 text-muted-foreground'}
          />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">GitHub</p>
          <p className="truncate text-xs text-muted-foreground">{githubLabel(github)}</p>
        </div>
      </div>
    </aside>
  )
}
