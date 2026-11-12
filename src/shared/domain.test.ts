import { describe, expect, it } from 'vitest'
import { columnStage, runStageFor } from './domain'

describe('runStageFor', () => {
  const reviews = {
    tab: 'reviews',
    stage: 'to-review',
    myReviewState: null,
    reviewed: false,
  } as const

  it('addresses my pull requests once changes are requested', () => {
    expect(runStageFor({ ...reviews, tab: 'mine', stage: 'changes-requested' })).toBe('address')
    expect(runStageFor({ ...reviews, tab: 'mine' })).toBe('review')
  })

  it('reviews a pull request nobody reviewed yet', () => {
    expect(runStageFor(reviews)).toBe('review')
  })

  it('re-reviews after my GitHub review or a finished agent review', () => {
    expect(runStageFor({ ...reviews, myReviewState: 'COMMENTED' })).toBe('re-review')
    expect(runStageFor({ ...reviews, reviewed: true })).toBe('re-review')
    expect(runStageFor({ ...reviews, tab: 'mine', stage: 're-review', reviewed: true })).toBe(
      're-review',
    )
  })
})

describe('columnStage', () => {
  const pr = { tab: 'mine', myReviewState: null, reviewed: true } as const

  it('maps action columns to the stage they run', () => {
    expect(columnStage('reviewing', pr)).toBe('re-review')
    expect(columnStage('reviewing', { ...pr, reviewed: false })).toBe('review')
    expect(columnStage('addressing', pr)).toBe('address')
    expect(columnStage('addressing', { ...pr, tab: 'reviews' })).toBeNull()
    expect(columnStage('to-approve', pr)).toBeNull()
  })
})
