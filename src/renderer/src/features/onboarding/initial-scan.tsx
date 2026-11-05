import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { AlertCircle, ArrowRight, Check, Loader2 } from 'lucide-react'
import { ErrorText } from '@/components/page'
import { Button } from '@/components/ui/button'
import { invoke, useSyncStatus } from '@/lib/api'

export function InitialScan() {
  const navigate = useNavigate()
  const { data: status } = useSyncStatus()
  const scan = useMutation({ mutationFn: () => invoke('sync:now') })
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    scan.mutate(undefined, {
      onSuccess: (result) => {
        if (!result.lastError) setTimeout(() => void navigate({ to: '/reviews' }), 900)
      },
    })
  }, [scan, navigate])

  const repos = status?.repos ?? []
  const done = scan.isSuccess
  return (
    <div className="space-y-6">
      <p className="text-base text-muted-foreground">
        Looking for pull requests that request your review (directly or through a team), that you
        authored, and that you took over.
      </p>
      <ul className="divide-y rounded-2xl bg-surface">
        {repos.map((repo) => (
          <li key={repo.repoId} className="flex items-center gap-3 px-5 py-4">
            {repo.state === 'error' ? (
              <AlertCircle className="size-4 text-destructive" />
            ) : repo.state === 'done' ? (
              <Check className="size-4 text-success" />
            ) : (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            )}
            <span className="font-mono text-sm">{repo.repo}</span>
            <span className="ml-auto text-sm text-muted-foreground">
              {repo.state === 'error'
                ? repo.error
                : repo.state === 'done'
                  ? `${repo.reviews} to review · ${repo.mine} mine`
                  : 'Scanning…'}
            </span>
          </li>
        ))}
        {repos.length === 0 && (
          <li className="flex items-center gap-3 px-5 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Starting…
          </li>
        )}
      </ul>
      <ErrorText error={scan.error ?? (done ? scan.data?.lastError : null)} />
      {done && (
        <Button onClick={() => void navigate({ to: '/reviews' })}>
          Open the board
          <ArrowRight />
        </Button>
      )}
    </div>
  )
}
