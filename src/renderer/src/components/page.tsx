import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-13 shrink-0 items-center border-b px-6">
        <h1 className="text-sm font-semibold">{title}</h1>
      </header>
      <div className="flex-1 overflow-auto p-6">{children}</div>
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border bg-surface">
        <Icon className="size-5 text-accent-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
