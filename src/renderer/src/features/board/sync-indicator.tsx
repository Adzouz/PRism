import { AlertCircle, RefreshCw } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { invoke, useSyncStatus } from '@/lib/api'
import { cn } from '@/lib/utils'
import { age, useNow } from './model'

export function SyncIndicator() {
  const { data: status } = useSyncStatus()
  const now = useNow(10_000)
  const running = status?.running ?? false
  const label = running
    ? 'Syncing…'
    : status?.lastSyncAt
      ? `Synced ${age(status.lastSyncAt, now) === 'now' ? 'just now' : `${age(status.lastSyncAt, now)} ago`}`
      : 'Not synced yet'
  const rate = status?.rate
  const details = [
    status?.lastError,
    rate &&
      `GitHub budget ${rate.remaining}/${rate.limit}, resets ${new Date(rate.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    'Syncs every minute and when PRism regains focus.',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="no-drag flex items-center gap-2 text-sm text-muted-foreground">
      {status?.lastError && !running && <AlertCircle className="size-4 text-destructive" />}
      <Tooltip content={details} side="bottom">
        <span>{label}</span>
      </Tooltip>
      <Tooltip content="Sync now" side="bottom">
        <button
          type="button"
          aria-label="Sync now"
          disabled={running}
          onClick={() => void invoke('sync:now')}
          className="flex size-8 items-center justify-center rounded-full border bg-surface transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          <RefreshCw className={cn('size-3.5', running && 'animate-spin')} />
        </button>
      </Tooltip>
    </div>
  )
}
