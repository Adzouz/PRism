import type { MenuItemConstructorOptions } from 'electron'
import type { OpenTarget } from '@shared/domain'
import { clip, type TrayItem } from '../services/notices'

export type TrayActions = {
  open: (target: OpenTarget) => void
  show: () => void
  sync: () => void
  quit: () => void
}

export type TrayModel = { needsYou: TrayItem[]; yourTurn: TrayItem[]; running: TrayItem[] }

const maxItems = 10

const separator: MenuItemConstructorOptions = { type: 'separator' }

export function trayTitle(model: TrayModel) {
  return model.needsYou.length > 0 ? String(model.needsYou.length) : ''
}

export function trayTooltip(model: TrayModel) {
  const waiting = model.needsYou.length
  const running = model.running.length
  const parts = [
    waiting > 0 ? `${waiting} need${waiting === 1 ? 's' : ''} you` : null,
    running > 0 ? `${running} running` : null,
  ].filter(Boolean)
  return parts.length > 0 ? `PRism: ${parts.join(', ')}` : 'PRism'
}

export function trayMenu(
  model: TrayModel,
  actions: TrayActions,
  options: { headers: boolean },
): MenuItemConstructorOptions[] {
  const header = (label: string): MenuItemConstructorOptions =>
    options.headers ? { type: 'header', label } : { label, enabled: false }
  const entries = (items: TrayItem[]): MenuItemConstructorOptions[] => [
    ...items.slice(0, maxItems).map((item): MenuItemConstructorOptions => ({
      label: clip(item.label, 56),
      sublabel: clip(item.detail, 64),
      toolTip: item.detail,
      click: () => actions.open(item.target),
    })),
    ...(items.length > maxItems
      ? [{ label: `${items.length - maxItems} more in PRism…`, click: actions.show }]
      : []),
  ]
  const section = (title: string, items: TrayItem[]) =>
    items.length > 0 ? [header(title), ...entries(items)] : []
  const waiting = [section('Needs you', model.needsYou), section('Your turn', model.yourTurn)]
    .filter((items) => items.length > 0)
    .flatMap((items, index) => (index > 0 ? [separator, ...items] : items))
  return [
    ...(waiting.length > 0 ? waiting : [{ label: 'Nothing needs you', enabled: false }]),
    ...(model.running.length > 0 ? [separator, ...section('Running', model.running)] : []),
    separator,
    { label: 'Open PRism', click: actions.show },
    { label: 'Sync now', click: actions.sync },
    separator,
    { label: 'Quit PRism', click: actions.quit },
  ]
}
