import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, type LucideIcon } from 'lucide-react'
import { errorMessage } from '@/lib/api'

export function Page({
  eyebrow,
  title,
  description,
  actions,
  fill = false,
  children,
}: {
  eyebrow: string
  title: string
  description?: string
  actions?: ReactNode
  fill?: boolean
  children: ReactNode
}) {
  return (
    <div className={fill ? 'flex h-full flex-col pb-3' : 'pb-10'}>
      <div className={fill ? 'flex min-h-0 flex-1 flex-col' : undefined}>
        <header className="drag mb-8 flex shrink-0 items-end justify-between gap-6 pt-9">
          <div className="space-y-2">
            <p className="text-sm font-medium text-accent-foreground">{eyebrow}</p>
            <h1 className="text-4xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="text-base text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </header>
        <div className={fill ? 'min-h-0 flex-1' : 'space-y-10'}>{children}</div>
      </div>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-base font-medium text-accent-foreground">{title}</h2>
      {children}
    </section>
  )
}

export function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="flex size-11 items-center justify-center rounded-xl bg-background">
      <Icon className="size-5" strokeWidth={1.75} />
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl bg-surface px-6 py-20 text-center">
      <IconTile icon={icon} />
      <div className="space-y-1">
        <p className="text-base font-medium">{title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

export function QuickCard({
  to,
  icon,
  label,
  description,
  meta,
}: {
  to: string
  icon: LucideIcon
  label: string
  description: string
  meta?: string
}) {
  return (
    <Link
      to={to}
      className="group flex flex-col gap-10 rounded-2xl bg-surface p-6 outline-none transition-colors hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="flex items-start justify-between">
        <IconTile icon={icon} />
        <ArrowUpRight className="size-5 text-muted-foreground transition-colors group-hover:text-foreground" />
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
          {label}
        </p>
        <p className="text-lg">{description}</p>
        {meta && <p className="text-sm text-muted-foreground">{meta}</p>}
      </div>
    </Link>
  )
}

export function Panel({
  title,
  description,
  status,
  disabled = false,
  children,
}: {
  title: string
  description?: ReactNode
  status?: ReactNode
  disabled?: boolean
  children?: ReactNode
}) {
  return (
    <section
      aria-disabled={disabled}
      className="space-y-4 rounded-2xl bg-surface p-5 aria-disabled:pointer-events-none aria-disabled:opacity-50"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-base font-medium">{title}</h3>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {status}
      </div>
      {children}
    </section>
  )
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p role="alert" className="text-sm text-destructive select-text">
      {errorMessage(error)}
    </p>
  )
}
