import { describe, expect, it } from 'vitest'
import { migrateBoard } from './model'

const filters = {
  reviews: { repoIds: [], starred: false, needsMe: false, showHidden: false, search: '' },
  mine: { repoIds: [], starred: false, needsMe: false, showHidden: false, search: '' },
}

describe('migrateBoard', () => {
  it('carries a confirmed drop over to Reviewing only', () => {
    expect(migrateBoard({ filters, density: 'compact', agentDropConfirmed: true }, 0)).toEqual({
      filters,
      density: 'compact',
      dropConfirmed: { reviewing: true },
    })
  })

  it('starts without confirmations when none were stored', () => {
    expect(migrateBoard({ filters, density: 'comfortable', agentDropConfirmed: false }, 0)).toEqual(
      {
        filters,
        density: 'comfortable',
        dropConfirmed: {},
      },
    )
    expect(migrateBoard(undefined, 0)).toEqual({ dropConfirmed: {} })
  })

  it('keeps current state as it is', () => {
    const state = { filters, density: 'comfortable', dropConfirmed: { addressing: true } }
    expect(migrateBoard(state, 1)).toEqual(state)
  })
})
