import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Loader2, RotateCcw } from 'lucide-react'
import { ErrorText } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { invoke } from '@/lib/api'

export function ResetConfiguration() {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const reset = async () => {
    setPending(true)
    setError(null)
    try {
      await invoke('config:reset')
      await client.resetQueries()
      setOpen(false)
      await navigate({ to: '/onboarding' })
    } catch (caught) {
      setError(caught)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex max-w-3xl items-center justify-between gap-4 rounded-2xl border border-destructive/40 p-5">
      <div>
        <p className="text-base font-medium">Reset PRism</p>
        <p className="text-sm text-muted-foreground">
          Forget every setting and start onboarding again.
        </p>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          <RotateCcw />
          Reset…
        </Button>
        <DialogContent title="Reset PRism?" description="This cannot be undone.">
          <div className="space-y-4 text-sm">
            <div className="space-y-1.5">
              <p className="font-medium">Removed</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>Repositories, skill sources, stage skills and the agent choice</li>
                <li>Skills copied or written in PRism (its skill library)</li>
                <li>Skill sources PRism cloned into its own app data folder</li>
              </ul>
            </div>
            <div className="space-y-1.5">
              <p className="font-medium">Kept</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>Your repository clones, worktrees and linked skill files</li>
                <li>Skill sources cloned into folders you chose</li>
                <li>Your gh and agent logins, and the theme</li>
              </ul>
            </div>
            <ErrorText error={error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={pending} onClick={() => void reset()}>
                {pending && <Loader2 className="animate-spin" />}
                Reset and restart onboarding
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
