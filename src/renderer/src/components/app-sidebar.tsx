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
import { ThemeSwitch } from '@/components/theme-switch'

const nav: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/reviews', label: 'Reviews', icon: GitPullRequest },
  { to: '/my-prs', label: 'My PRs', icon: GitPullRequestArrow },
  { to: '/archive', label: 'Archive', icon: Archive },
  { to: '/runs', label: 'Runs', icon: Bot },
]

const itemClass =
  'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&.active]:bg-sidebar-accent [&.active]:font-medium [&.active]:text-sidebar-accent-foreground'

export function AppSidebar() {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="drag h-13 shrink-0" />
      <div className="flex items-center gap-2 px-4 pb-4">
        <div className="size-5 rounded-md bg-gradient-to-br from-primary to-accent-foreground" />
        <span className="text-[15px] font-semibold tracking-tight">PRism</span>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 px-2">
        {nav.map(({ to, label, icon: Icon }) => (
          <Link key={to} to={to} className={itemClass} activeOptions={{ exact: to === '/' }}>
            <Icon className="size-4" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="flex flex-col gap-2 border-t border-sidebar-border p-2">
        <Link to="/settings" className={itemClass}>
          <Settings className="size-4" />
          Settings
        </Link>
        <div className="px-1 pb-1">
          <ThemeSwitch />
        </div>
      </div>
    </aside>
  )
}
