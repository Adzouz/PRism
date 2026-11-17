import { describe, expect, it, vi } from 'vitest'
import type { OpenTarget } from '@shared/domain'
import type { TrayItem } from '../services/notices'
import { trayMenu, trayTitle, trayTooltip, type TrayModel } from './menu'

const target = (prId: number): OpenTarget => ({ prId, page: 'reviews', tab: 'runs', runId: prId })

const item = (prId: number): TrayItem => ({
  label: `app #${prId} · Change ${prId}`,
  detail: `Detail ${prId}`,
  target: target(prId),
})

function actions() {
  return {
    open: vi.fn<(target: OpenTarget) => void>(),
    show: vi.fn<() => void>(),
    sync: vi.fn<() => void>(),
    quit: vi.fn<() => void>(),
  }
}

const empty: TrayModel = { needsYou: [], yourTurn: [], running: [] }

const labels = (menu: ReturnType<typeof trayMenu>) => menu.map((entry) => entry.label ?? entry.type)

const appActions = ['separator', 'Open PRism', 'Sync now', 'separator', 'Quit PRism']

describe('trayMenu', () => {
  it('shows an empty state and the app actions', () => {
    const menu = trayMenu(empty, actions(), { headers: true })
    expect(labels(menu)).toEqual(['Nothing needs you', ...appActions])
    expect(menu[0]).toMatchObject({ enabled: false })
  })

  it('falls back to disabled items for section titles', () => {
    const menu = trayMenu({ ...empty, needsYou: [item(1)] }, actions(), { headers: false })
    expect(menu[0]).toEqual({ label: 'Needs you', enabled: false })
  })

  it('lists agent items, then your turn on the board, then running agents', () => {
    const handlers = actions()
    const model = { needsYou: [item(1)], yourTurn: [item(3)], running: [item(2)] }
    const menu = trayMenu(model, handlers, { headers: true })
    expect(labels(menu)).toEqual([
      'Needs you',
      'app #1 · Change 1',
      'separator',
      'Your turn',
      'app #3 · Change 3',
      'separator',
      'Running',
      'app #2 · Change 2',
      ...appActions,
    ])
    expect(menu[0]).toMatchObject({ type: 'header' })
    expect(menu[1]).toMatchObject({ sublabel: 'Detail 1', toolTip: 'Detail 1' })
    const click = (label: string) =>
      (menu.find((entry) => entry.label === label)?.click as (() => void) | undefined)?.()
    click('app #2 · Change 2')
    expect(handlers.open).toHaveBeenCalledWith(target(2))
    click('Open PRism')
    click('Sync now')
    click('Quit PRism')
    expect(handlers.show).toHaveBeenCalledOnce()
    expect(handlers.sync).toHaveBeenCalledOnce()
    expect(handlers.quit).toHaveBeenCalledOnce()
  })

  it('says nothing needs you only when no item waits on you', () => {
    expect(
      labels(trayMenu({ ...empty, yourTurn: [item(3)] }, actions(), { headers: true })),
    ).toEqual(['Your turn', 'app #3 · Change 3', ...appActions])
    expect(
      labels(trayMenu({ ...empty, running: [item(2)] }, actions(), { headers: true })),
    ).toEqual(['Nothing needs you', 'separator', 'Running', 'app #2 · Change 2', ...appActions])
  })

  it('caps long lists with a link to the app', () => {
    const many = Array.from({ length: 12 }, (_, index) => item(index + 1))
    const menu = trayMenu({ ...empty, needsYou: many }, actions(), { headers: true })
    expect(labels(menu)).toContain('app #10 · Change 10')
    expect(labels(menu)).not.toContain('app #11 · Change 11')
    expect(labels(menu)).toContain('2 more in PRism…')
  })
})

describe('tray title and tooltip', () => {
  it('counts agent items only', () => {
    expect(trayTitle(empty)).toBe('')
    expect(trayTooltip(empty)).toBe('PRism')
    expect(trayTitle({ ...empty, yourTurn: [item(3)] })).toBe('')
    const busy = { ...empty, needsYou: [item(1)], running: [item(2), item(3)] }
    expect(trayTitle(busy)).toBe('1')
    expect(trayTooltip(busy)).toBe('PRism: 1 needs you, 2 running')
    expect(trayTooltip({ ...empty, needsYou: [item(1), item(2)] })).toBe('PRism: 2 need you')
  })
})
