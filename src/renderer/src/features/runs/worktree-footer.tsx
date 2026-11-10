import { ChevronDown, Code, FolderGit2, SquareTerminal } from 'lucide-react'
import type { AppChoice, BoardPr } from '@shared/domain'
import { ErrorText } from '@/components/page'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useApps, useOpenWorktree, usePrRuns, useSetApps } from '@/lib/api'

function OpenButton({
  icon: Icon,
  label,
  menuLabel,
  apps,
  preferred,
  onOpen,
  onPick,
  disabled,
}: {
  icon: typeof Code
  label: string
  menuLabel: string
  apps: AppChoice[]
  preferred: string | null
  onOpen: () => void
  onPick: (id: string) => void
  disabled: boolean
}) {
  const current = apps.find((app) => app.id === preferred) ?? apps[0]
  return (
    <div className="flex">
      <Button
        size="sm"
        variant="outline"
        className="rounded-r-none"
        disabled={disabled || !current}
        onClick={onOpen}
      >
        <Icon />
        {current ? `${label} ${current.name}` : label}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="rounded-l-none border-l-0 px-1.5"
            aria-label={`Choose ${menuLabel.toLowerCase()} app`}
            disabled={disabled || apps.length === 0}
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{menuLabel}</DropdownMenuLabel>
          {apps.map((app) => (
            <DropdownMenuItem key={app.id} onSelect={() => onPick(app.id)}>
              {app.name}
              {app.id === current?.id && (
                <span className="ml-auto text-xs text-muted-foreground">default</span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function WorktreeFooter({ pr }: { pr: BoardPr }) {
  const { data: runs } = usePrRuns(pr.id)
  const { data: apps } = useApps()
  const setApps = useSetApps()
  const open = useOpenWorktree()
  const run = runs?.find((item) => item.worktreePath)
  if (!run?.worktreePath || !apps) return null
  const launch = (target: 'editor' | 'terminal') => open.mutate({ runId: run.id, target })
  const pick = (target: 'editor' | 'terminal', id: string) =>
    setApps.mutate({ [target]: id }, { onSuccess: () => launch(target) })
  return (
    <footer className="space-y-2 border-t px-6 py-3">
      <div className="flex items-center gap-2">
        <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground select-text">
          {run.worktreePath}
        </span>
        <OpenButton
          icon={Code}
          label="Open in"
          menuLabel="Editor"
          apps={apps.editors}
          preferred={apps.preferred.editor}
          onOpen={() => launch('editor')}
          onPick={(id) => pick('editor', id)}
          disabled={open.isPending}
        />
        <OpenButton
          icon={SquareTerminal}
          label="Open in"
          menuLabel="Terminal"
          apps={apps.terminals}
          preferred={apps.preferred.terminal}
          onOpen={() => launch('terminal')}
          onPick={(id) => pick('terminal', id)}
          disabled={open.isPending}
        />
      </div>
      <ErrorText error={open.error ?? setApps.error} />
    </footer>
  )
}
