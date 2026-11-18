import { describe, expect, it } from 'vitest'
import { aiTag, boardColumns, columnStage, nextSteps, runStageFor, withAiTag } from './domain'

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

  it('starts My PRs in Waiting review and Reviews in To review', () => {
    expect(boardColumns.mine[1]).toMatchObject({ stage: 'waiting-review', label: 'Waiting review' })
    expect(boardColumns.mine.some((column) => column.stage === 'to-review')).toBe(false)
    expect(boardColumns.reviews[1]).toMatchObject({ stage: 'to-review', needsMe: true })
  })

  it('maps action columns to the stage they run', () => {
    expect(columnStage('reviewing', pr)).toBe('re-review')
    expect(columnStage('reviewing', { ...pr, reviewed: false })).toBe('review')
    expect(columnStage('addressing', pr)).toBe('address')
    expect(columnStage('addressing', { ...pr, tab: 'reviews' })).toBeNull()
    expect(columnStage('to-approve', pr)).toBeNull()
  })
})

describe('nextSteps', () => {
  const pr = {
    tab: 'mine',
    stage: 'waiting-review',
    state: 'OPEN',
    myReviewState: null,
    reviewed: true,
    unresolvedThreads: 0,
  } as const

  it('suggests the step that moves each state column forward', () => {
    expect(nextSteps(pr)?.primary).toEqual({ kind: 'run', stage: 're-review' })
    expect(nextSteps({ ...pr, stage: 'changes-requested' })?.primary).toEqual({
      kind: 'run',
      stage: 'address',
    })
    expect(nextSteps({ ...pr, stage: 'to-approve' })?.primary).toEqual({ kind: 'approve' })
    expect(nextSteps({ ...pr, stage: 'approved' })?.primary).toBeNull()
    const reviews = { ...pr, tab: 'reviews', reviewed: false } as const
    expect(nextSteps({ ...reviews, stage: 'to-review' })?.primary).toEqual({
      kind: 'run',
      stage: 'review',
    })
    expect(nextSteps({ ...reviews, stage: 'changes-requested' })?.primary).toEqual({
      kind: 'move',
      stage: 're-review',
    })
  })

  it('offers every other run and state column, without the primary step', () => {
    const steps = nextSteps({ ...pr, stage: 're-review' })!
    expect(steps.others).not.toContainEqual({ kind: 'run', stage: 're-review' })
    expect(steps.others).toContainEqual({ kind: 'run', stage: 'address' })
    expect(steps.others).toContainEqual({ kind: 'move', stage: 'waiting-review' })
    expect(steps.others).toContainEqual({ kind: 'approve' })
    expect(steps.others).not.toContainEqual({ kind: 'move', stage: 're-review' })
    expect(steps.others.some((step) => step.kind === 'move' && step.stage === 'reviewing')).toBe(
      false,
    )
    expect(nextSteps({ ...pr, stage: 'approved' })!.others).not.toContainEqual({ kind: 'approve' })
  })

  it('offers to address the comments next to Post GO on my pull request', () => {
    const nits = nextSteps({ ...pr, stage: 'to-approve', unresolvedThreads: 2 })!
    expect(nits.primary).toEqual({ kind: 'approve' })
    expect(nits.secondary).toEqual({ kind: 'run', stage: 'address' })
    expect(nits.others).not.toContainEqual({ kind: 'run', stage: 'address' })
    expect(nextSteps({ ...pr, stage: 'to-approve' })!.secondary).toBeNull()
    expect(
      nextSteps({ ...pr, tab: 'reviews', stage: 'to-approve', unresolvedThreads: 2 })!.secondary,
    ).toBeNull()
  })

  it('stays out of agent columns and closed pull requests', () => {
    expect(nextSteps({ ...pr, stage: 'reviewing' })).toBeNull()
    expect(nextSteps({ ...pr, stage: 'needs-you' })).toBeNull()
    expect(nextSteps({ ...pr, state: 'MERGED', stage: 'done' })).toBeNull()
  })
})

describe('withAiTag', () => {
  it('replaces an AI signature the agent added with the PRism tag', () => {
    expect(withAiTag('Fixed in abc1234.\n\n_Reply drafted by AI, reviewed by the author._')).toBe(
      `Fixed in abc1234.\n\n${aiTag}`,
    )
    expect(withAiTag(`Done.\n\n${aiTag}\n\n*Generated with Claude*\n`)).toBe(`Done.\n\n${aiTag}`)
  })

  it('keeps a last paragraph that only mentions AI in passing, and inline text', () => {
    const body =
      'The fixture was generated.\n\nSee the AI section, reviewed last week, for more on this.'
    expect(withAiTag(body)).toBe(`${body}\n\n${aiTag}`)
    expect(withAiTag('Drafted by AI, reviewed.')).toBe(`Drafted by AI, reviewed.\n\n${aiTag}`)
  })

  it('keeps a single tag on a body that is only the tag', () => {
    expect(withAiTag(`${aiTag}\n`)).toBe(aiTag)
  })
})
