import { describe, expect, it } from 'vitest'
import { boardView, columnOf, isOpenDraft, migrateBoard, useBoardStore } from './model'

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

describe('isOpenDraft', () => {
  it('marks a draft only while it is open', () => {
    expect(isOpenDraft({ isDraft: true, state: 'OPEN' })).toBe(true)
    expect(isOpenDraft({ isDraft: true, state: 'CLOSED' })).toBe(false)
    expect(isOpenDraft({ isDraft: false, state: 'OPEN' })).toBe(false)
  })
})

describe('selectRun', () => {
  it('drops a pending Ask agent anything when another run is selected', () => {
    const store = useBoardStore.getState()
    store.askAgent(1, 10)
    store.selectRun(10)
    expect(useBoardStore.getState().askRunId).toBe(10)
    store.selectRun(11)
    store.selectRun(10)
    expect(useBoardStore.getState().askRunId).toBeNull()
  })
})
