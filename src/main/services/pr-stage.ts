import { createHash } from 'node:crypto'
import { boardColumns, type BoardStage, type BoardTab, type PrRole } from '@shared/domain'

export type PrFacts = {
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  reviewDecision: string | null
  headOid: string
  reviewRequested: boolean
  myReview: { state: string; oid: string | null; at: number } | null
  unresolvedThreads: number
  role: PrRole
}

export const tabOf = (role: PrRole): BoardTab => (role === 'reviewer' ? 'reviews' : 'mine')

export function deriveStage(facts: PrFacts): BoardStage {
  if (facts.state !== 'OPEN') return 'done'
  if (tabOf(facts.role) === 'reviews') {
    const review = facts.myReview
    if (facts.reviewRequested) return review ? 're-review' : 'to-review'
    if (!review) return 'to-review'
    if (review.state === 'APPROVED') return 'approved'
    if (review.oid && review.oid !== facts.headOid) return 're-review'
    return 'waiting-on-author'
  }
  if (facts.isDraft) return 'draft'
  if (facts.reviewDecision === 'CHANGES_REQUESTED' || facts.unresolvedThreads > 0) {
    return 'changes-requested'
  }
  if (facts.reviewDecision === 'APPROVED') return 'approved'
  return 'waiting-for-review'
}

export function stageBasis(facts: PrFacts) {
  const parts = [
    facts.state,
    facts.isDraft,
    facts.reviewDecision,
    facts.headOid,
    facts.reviewRequested,
    facts.myReview?.state ?? null,
    facts.myReview?.at ?? null,
    facts.unresolvedThreads > 0,
    facts.role,
  ]
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

export function stageAllowedIn(tab: BoardTab, stage: BoardStage) {
  return boardColumns[tab].some((column) => column.stage === stage)
}
