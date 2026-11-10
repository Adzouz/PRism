import { describe, expect, it } from 'vitest'
import { runStageFor, type BoardRun } from './domain'

const run = (overrides: Partial<BoardRun>): BoardRun => ({
  id: 1,
  stage: 'review',
  status: 'done',
  progress: null,
  error: null,
  verdict: 'comment',
  findings: 0,
  ask: null,
  stale: false,
  ...overrides,
})

describe('runStageFor', () => {
  const reviews = {
    tab: 'reviews',
    derivedStage: 'to-review',
    myReviewState: null,
    run: null,
  } as const

  it('starts address runs on my pull requests', () => {
    expect(runStageFor({ ...reviews, tab: 'mine' })).toBe('address')
  })

  it('reviews a pull request nobody reviewed yet', () => {
    expect(runStageFor(reviews)).toBe('review')
    expect(runStageFor({ ...reviews, run: run({ status: 'failed' }) })).toBe('review')
    expect(runStageFor({ ...reviews, run: run({ stage: 'test-plan' }) })).toBe('review')
  })

  it('re-reviews after my GitHub review or a finished agent review', () => {
    expect(runStageFor({ ...reviews, myReviewState: 'COMMENTED' })).toBe('re-review')
    expect(runStageFor({ ...reviews, derivedStage: 're-review' })).toBe('re-review')
    expect(runStageFor({ ...reviews, run: run({ stale: true }) })).toBe('re-review')
    expect(runStageFor({ ...reviews, run: run({ stage: 're-review' }) })).toBe('re-review')
  })
})
