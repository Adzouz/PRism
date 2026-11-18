import { gateKindOf, type Run } from '@shared/domain'
import type { TimelineTone } from '@/components/timeline'

const postedLabel = { review: 'Submitted', address: 'Addressed', replies: 'Replies posted' }

export function outcomeOf(run: Run): { label: string; tone: TimelineTone; at: number } {
  if (run.status === 'needs_you')
    return { label: 'Waiting for you', tone: 'live', at: run.createdAt }
  if (run.status === 'queued' || run.status === 'preparing' || run.status === 'running')
    return { label: 'Agent working', tone: 'live', at: run.startedAt ?? run.createdAt }
  const kind = gateKindOf[run.stage]
  if (run.gate?.postedAt) {
    const label =
      kind === 'review' && run.gate.mode === 'draft'
        ? 'Staged as pending review'
        : kind
          ? postedLabel[kind]
          : 'Posted'
    return { label, tone: 'done', at: run.gate.postedAt }
  }
  if (run.gate?.skippedAt) return { label: 'Skipped', tone: 'muted', at: run.gate.skippedAt }
  if (run.status !== 'done')
    return { label: 'Follow-up stopped', tone: 'muted', at: run.endedAt ?? run.createdAt }
  if (run.dismissedAt) return { label: 'Dismissed', tone: 'muted', at: run.dismissedAt }
  return { label: 'Ready to post', tone: 'open', at: run.endedAt ?? run.createdAt }
}

export const gateRuns = (runs: Run[]) =>
  runs.filter(
    (run) => gateKindOf[run.stage] !== undefined && (run.status === 'done' || run.gate !== null),
  )
