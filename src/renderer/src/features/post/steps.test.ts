import type { Run } from '@shared/domain'
import { describe, expect, it } from 'vitest'
import { gateRuns, outcomeOf } from './steps'

const run = (patch: Partial<Run>) =>
  ({
    id: 1,
    stage: 'review',
    status: 'done',
    createdAt: 100,
    startedAt: 110,
    endedAt: 200,
    dismissedAt: null,
    gate: null,
    ...patch,
  }) as Run

describe('outcomeOf', () => {
  it('keeps the posted outcome when a follow-up on a posted review stops', () => {
    const gate = { postedAt: 150, skippedAt: null, mode: 'draft' as const }
    for (const status of ['failed', 'cancelled'] as const) {
      expect(outcomeOf(run({ status, endedAt: 300, gate }))).toEqual({
        label: 'Staged as pending review',
        tone: 'done',
        at: 150,
      })
    }
    expect(outcomeOf(run({ status: 'failed', gate: { ...gate, mode: 'submit' } })).label).toBe(
      'Submitted',
    )
  })

  it('keeps the skipped outcome when a follow-up stops', () => {
    const gate = { postedAt: null, skippedAt: 150, mode: null }
    expect(outcomeOf(run({ status: 'cancelled', gate }))).toEqual({
      label: 'Skipped',
      tone: 'muted',
      at: 150,
    })
  })

  it('says the follow-up stopped on an open gate', () => {
    const gate = { postedAt: null, skippedAt: null, mode: null }
    expect(outcomeOf(run({ status: 'failed', endedAt: 300, gate }))).toEqual({
      label: 'Follow-up stopped',
      tone: 'muted',
      at: 300,
    })
  })

  it('shows a running follow-up as live even on a posted gate', () => {
    const gate = { postedAt: 150, skippedAt: null, mode: 'submit' as const }
    expect(outcomeOf(run({ status: 'running', startedAt: 250, gate })).label).toBe('Agent working')
  })
})

describe('gateRuns', () => {
  it('keeps finished runs and runs that have a gate', () => {
    const gate = { postedAt: 150, skippedAt: null, mode: 'submit' as const }
    const runs = [
      run({ id: 1 }),
      run({ id: 2, status: 'failed' }),
      run({ id: 3, status: 'failed', gate }),
      run({ id: 4, stage: 'test-plan' }),
    ]
    expect(gateRuns(runs).map((item) => item.id)).toEqual([1, 3])
  })
})
