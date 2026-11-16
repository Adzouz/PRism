import { BadgeCheck, Loader2 } from 'lucide-react'
import type { BoardPr } from '@shared/domain'
import { ErrorText } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useApprove } from '@/lib/api'

export function ApproveDialog({ pr, onClose }: { pr: BoardPr | null; onClose: () => void }) {
  const approve = useApprove()
  const own = pr?.role === 'author'
  const close = () => {
    approve.reset()
    onClose()
  }
  return (
    <Dialog open={pr !== null} onOpenChange={(open) => !open && close()}>
      {pr && (
        <DialogContent
          title={own ? 'Post GO on your pull request?' : 'Approve this pull request?'}
          description={`${pr.repo} #${pr.number}`}
          className="w-[min(480px,calc(100vw-48px))]"
        >
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {own
                ? 'GitHub does not let you approve your own pull request, so PRism posts a Comment review saying “GO”, with the AI tag line.'
                : 'PRism submits an Approve review on GitHub saying “GO”, with the AI tag line.'}{' '}
              A pending review of yours on this pull request is submitted with it.
            </p>
            <ErrorText error={approve.error} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                autoFocus
                disabled={approve.isPending}
                onClick={() => approve.mutate(pr.id, { onSuccess: close })}
              >
                {approve.isPending ? <Loader2 className="animate-spin" /> : <BadgeCheck />}
                {own ? 'Post GO' : 'Approve'}
              </Button>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
