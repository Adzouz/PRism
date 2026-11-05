import { Check, Copy, Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { ErrorText, Panel } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useGithubStatus } from '@/lib/api'

export function CommandHint({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-lg bg-background px-3 py-2 font-mono text-sm">
      <span className="flex-1 select-text">{command}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          void navigator.clipboard.writeText(command).then(() => setCopied(true))
        }}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

export function StepGithub() {
  const { data: status, isFetching, refetch, error } = useGithubStatus()

  const recheck = (
    <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
      {isFetching ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      Check again
    </Button>
  )

  if (!status) {
    return (
      <Panel title="GitHub" description="Checking your gh login…">
        {error ? <ErrorText error={error} /> : <Loader2 className="size-5 animate-spin" />}
      </Panel>
    )
  }

  if (!status.installed) {
    return (
      <Panel
        title="Install the GitHub CLI"
        description="PRism talks to GitHub through gh."
        status={recheck}
      >
        <CommandHint command="brew install gh" />
        <p className="text-sm text-muted-foreground">Then sign in and check again.</p>
      </Panel>
    )
  }

  if (!status.loggedIn) {
    return (
      <Panel
        title="Sign in to GitHub"
        description="Run this in your terminal, then check again. PRism reads the token from gh at runtime and never stores it."
        status={recheck}
      >
        <CommandHint command="gh auth login --scopes repo,read:org" />
      </Panel>
    )
  }

  return (
    <Panel
      title={status.login ? `Signed in as @${status.login}` : 'Signed in'}
      description="PRism uses your gh login. The token is read at runtime, never stored."
      status={recheck}
    >
      <div className="flex flex-wrap gap-1.5">
        {status.scopes.map((scope) => (
          <Badge key={scope} variant={status.missingScopes.includes(scope) ? 'warning' : 'default'}>
            {scope}
          </Badge>
        ))}
      </div>
      {status.missingScopes.length > 0 && (
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm text-warning">
            <TriangleAlert className="size-4" />
            Missing scopes: {status.missingScopes.join(', ')}. Team review requests may not show up.
          </p>
          <CommandHint command={`gh auth refresh --scopes ${status.missingScopes.join(',')}`} />
        </div>
      )}
      <ErrorText error={status.error} />
    </Panel>
  )
}
