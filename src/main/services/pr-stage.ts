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
    const approvedHere = !review?.oid || review.oid === facts.headOid
    if (review?.state === 'APPROVED' && approvedHere && !facts.reviewRequested) return 'approved'
    if (facts.reviewRequested) return review ? 're-review' : 'to-review'
    if (!review) return 'to-review'
    if (review.oid && review.oid !== facts.headOid) return 're-review'
    return 'changes-requested'
  }
  if (facts.reviewDecision === 'APPROVED') return 'approved'
  if (facts.reviewDecision === 'CHANGES_REQUESTED' || facts.unresolvedThreads > 0) {
    return 'changes-requested'
  }
  return 'to-review'
}

type Verdict = 'approve' | 'comment' | 'request_changes'

export function reviewDirection(
  mode: 'submit' | 'draft' | null,
  event: Verdict | null,
  verdict: Verdict | null | undefined,
) {
  const submitted = mode === 'submit'
  const approve = submitted
    ? event === 'approve' || (verdict === 'approve' && event !== 'request_changes')
    : verdict === 'approve'
  return {
    goes: approve ? ('approve' as const) : ('changes' as const),
    approvedOnGithub: submitted && event === 'approve',
  }
}

export type LoopFacts = {
  kind: 'review' | 'address'
  goes: 'approve' | 'changes'
  approvedOnGithub: boolean
  reviewedHeadOid: string | null
}

export function loopStage(
  derived: BoardStage,
  headOid: string,
  loop: LoopFacts | null,
  approvedOid: string | null,
): BoardStage {
  if (derived === 'done' || derived === 'approved') return derived
  if (approvedOid && approvedOid === headOid) return 'approved'
  if (!loop) return derived
  if (loop.kind === 'address') return 're-review'
  if (loop.reviewedHeadOid && loop.reviewedHeadOid !== headOid) return 're-review'
  if (loop.goes === 'changes') return derived === 're-review' ? 're-review' : 'changes-requested'
  return loop.approvedOnGithub ? 'approved' : 'to-approve'
}

export function stageBasis(facts: PrFacts) {
  const parts = [
    facts.state,
    facts.isDraft,
    facts.reviewDecision,
    facts.headOid,
    facts.reviewRequested,
    facts.myReview?.state ?? null,
    facts.myReview?.oid ?? null,
    facts.unresolvedThreads > 0,
    facts.role,
  ]
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
}

export function stageAllowedIn(tab: BoardTab, stage: BoardStage) {
  return boardColumns[tab].some((column) => column.stage === stage)
}
