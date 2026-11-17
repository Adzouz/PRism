import { ArrowUpRight, BellRing, Loader2 } from 'lucide-react'
import { ErrorText, Panel } from '@/components/page'
import { Button } from '@/components/ui/button'
import { useOpenNotificationSettings, useTestNotification } from '@/lib/api'

export function OpenNotificationSettings() {
  const open = useOpenNotificationSettings()
  return (
    <>
      <Button size="sm" variant="ghost" disabled={open.isPending} onClick={() => open.mutate()}>
        <ArrowUpRight />
        Open System Settings
      </Button>
      <ErrorText error={open.error} />
    </>
  )
}

export function StepNotifications({ onAsked }: { onAsked: () => void }) {
  const test = useTestNotification()
  return (
    <Panel
      title="Know when PRism needs you"
      description="PRism tells you when an agent has a question, a run is ready to post, someone requests your review or a check fails on your pull request. Pick which ones in Settings."
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={test.isPending}
          onClick={() => test.mutate(undefined, { onSuccess: onAsked })}
        >
          {test.isPending ? <Loader2 className="animate-spin" /> : <BellRing />}
          Turn on notifications
        </Button>
        {test.isSuccess && <OpenNotificationSettings />}
      </div>
      {test.data === true && (
        <p className="text-sm text-muted-foreground">
          macOS asks once whether PRism can send notifications: click Allow. Missed it, or nothing
          showed up? Turn PRism on in System Settings → Notifications.
        </p>
      )}
      {test.data === false && (
        <p role="alert" className="text-sm text-destructive">
          This Mac does not support notifications from PRism.
        </p>
      )}
      <ErrorText error={test.error} />
    </Panel>
  )
}
