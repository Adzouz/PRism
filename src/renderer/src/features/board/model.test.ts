import { describe, expect, it } from 'vitest'
import { boardView, columnOf, migrateBoard } from './model'

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

describe('boardView', () => {
  it('shows a card whose stage is not a column of its tab in the first state column', () => {
    const pr = { id: 1, tab: 'mine', stage: 'to-review', archivedAt: null, hidden: false } as const
    const view = boardView(
      [
        {
          ...pr,
          repoId: 1,
          starred: false,
          updatedAt: 0,
          number: 1,
          title: '',
          author: '',
        } as never,
      ],
      'mine',
      filters.mine,
    )
    expect([...view.byStage.keys()]).toEqual(['waiting-review'])
  })
})

describe('columnOf', () => {
  it('returns the column the card is shown in', () => {
    expect(columnOf({ tab: 'mine', stage: 'to-review' })).toBe('waiting-review')
    expect(columnOf({ tab: 'mine', stage: 'changes-requested' })).toBe('changes-requested')
    expect(columnOf({ tab: 'reviews', stage: 'to-review' })).toBe('to-review')
  })
})
