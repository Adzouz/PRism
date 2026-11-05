import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { ArrowUpRight, type LucideIcon } from 'lucide-react'

export function Page({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="pb-10">
      <div>
        <header className="drag mb-8 space-y-2 pt-9">
          <p className="text-sm font-medium text-accent-foreground">{eyebrow}</p>
          <h1 className="text-4xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-base text-muted-foreground">{description}</p>}
        </header>
        <div className="space-y-10">{children}</div>
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
