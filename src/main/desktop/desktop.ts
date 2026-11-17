import { join } from 'node:path'
import { app, BrowserWindow, Menu, nativeImage, Notification, shell, Tray } from 'electron'
import type { OpenTarget, Run, RunStatus } from '@shared/domain'
import type { Ctx } from '../services/context'
import {
  getNotificationSettings,
  needsYouItems,
  prNotice,
  runNotice,
  runningItems,
  yourTurnItems,
  type Notice,
} from '../services/notices'
import { getPr, listPrs } from '../services/prs'
import type { PrEvent } from '../services/sync'
import { trayMenu, trayTitle, trayTooltip, type TrayModel } from './menu'

export type DesktopDeps = {
  ctx: Ctx
  iconDir: string
  open: (target: OpenTarget) => void
  show: () => void
  sync: () => void
  answer: (askId: number, answer: string) => void
}

const dedupeWindow = 30 * 60_000
const keptNotifications = 50
const systemSettingsUrl = 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'

const menuHeaders = () =>
  process.platform === 'darwin' && Number(process.getSystemVersion().split('.')[0]) >= 14

export function createDesktop(deps: DesktopDeps) {
  const { ctx } = deps
  const statuses = new Map<number, RunStatus>()
  const asks = new Map<number, number>()
  const live = new Map<string, Notification>()
  const shown = new Map<string, number>()
  let tray: Tray | null = null
  let menuKey: string | null = null
  let timer: NodeJS.Timeout | null = null
  let disposed = false

  const actions = { open: deps.open, show: deps.show, sync: deps.sync, quit: () => app.quit() }

  function prOf(prId: number) {
    try {
      return getPr(ctx, prId)
    } catch {
      return null
    }
  }

  function seenRecently(key: string, now: number) {
    for (const [entry, at] of shown) if (now - at >= dedupeWindow) shown.delete(entry)
    if (shown.has(key)) return true
    shown.set(key, now)
    return false
  }

  function keep(id: string, notification: Notification) {
    live.delete(id)
    live.set(id, notification)
    for (const key of live.keys()) {
      if (live.size <= keptNotifications) break
      live.delete(key)
    }
  }

  function deliver(notice: Notice, force = false) {
    if (!Notification.isSupported()) return false
    if (!force) {
      if (!getNotificationSettings(ctx)[notice.kind]) return false
      if (notice.dedupe && seenRecently(notice.dedupe, Date.now())) return false
      if (BrowserWindow.getFocusedWindow()) return false
    }
    const options = notice.ask?.options.slice(0, 5) ?? []
    const notification = new Notification({
      id: notice.id,
      title: notice.title,
      subtitle: notice.subtitle,
      body: notice.body,
      hasReply: notice.ask !== null,
      replyPlaceholder: 'Answer the agent',
      actions: options.map((text) => ({ type: 'button' as const, text })),
    })
    const forget = () => {
      if (live.get(notice.id) === notification) live.delete(notice.id)
    }
    notification.on('click', () => {
      forget()
      if (notice.target) deps.open(notice.target)
      else deps.show()
    })
    notification.on('close', forget)
    notification.on('failed', (_event, error) => console.warn(`Notification failed: ${error}`))
    const askId = notice.ask?.id
    if (askId !== undefined) {
      notification.on('reply', (details) => {
        forget()
        deps.answer(askId, details.reply)
      })
      notification.on('action', (details) => {
        forget()
        const option = options[details.actionIndex]
        if (option) deps.answer(askId, option)
      })
    }
    keep(notice.id, notification)
    notification.show()
    return true
  }

  function clearAsk(runId: number) {
    const askId = asks.get(runId)
    if (askId === undefined) return
    asks.delete(runId)
    const id = `ask:${askId}`
    live.delete(id)
    if (process.platform === 'darwin') Notification.remove(id)
  }

  function ensureTray() {
    if (tray) return tray
    const image = nativeImage.createFromPath(join(deps.iconDir, 'trayTemplate.png'))
    image.setTemplateImage(true)
    tray = new Tray(image)
    tray.setIgnoreDoubleClickEvents(true)
    menuKey = null
    return tray
  }

  function apply() {
    const settings = getNotificationSettings(ctx)
    const prs = listPrs(ctx)
    const model: TrayModel = {
      needsYou: needsYouItems(prs),
      yourTurn: yourTurnItems(prs),
      running: runningItems(prs),
    }
    const count = model.needsYou.length
    app.dock?.setBadge(settings.dockBadge && count > 0 ? String(count) : '')
    if (!settings.menuBar) {
      tray?.destroy()
      tray = null
      return
    }
    const current = ensureTray()
    current.setTitle(trayTitle(model), { fontType: 'monospacedDigit' })
    current.setToolTip(trayTooltip(model))
    const key = JSON.stringify(model)
    if (key === menuKey) return
    menuKey = key
    current.setContextMenu(
      Menu.buildFromTemplate(trayMenu(model, actions, { headers: menuHeaders() })),
    )
  }

  function refresh() {
    if (timer || disposed) return
    timer = setTimeout(() => {
      timer = null
      if (disposed) return
      try {
        apply()
      } catch (error) {
        console.warn('Could not update the menu bar and Dock badge:', error)
      }
    }, 250)
  }

  return {
    refresh,

    runChanged(run: Run) {
      const prev = statuses.get(run.id)
      statuses.set(run.id, run.status)
      if (prev === 'needs_you' && run.status !== 'needs_you') clearAsk(run.id)
      if (prev !== undefined && prev !== run.status) {
        const pr = prOf(run.prId)
        const notice = pr ? runNotice(prev, run, pr) : null
        if (notice?.ask) asks.set(run.id, notice.ask.id)
        if (notice) deliver(notice)
      }
      refresh()
    },

    prEvents(events: PrEvent[]) {
      for (const event of events) {
        const pr = prOf(event.prId)
        const notice = pr ? prNotice(event, pr) : null
        if (notice) deliver(notice)
      }
    },

    test() {
      return deliver(
        {
          id: 'test',
          kind: 'needsYou',
          title: 'Notifications are on',
          subtitle: 'PRism',
          body: 'Agent questions, finished runs, review requests and failing checks show up here.',
          target: null,
          ask: null,
          dedupe: null,
        },
        true,
      )
    },

    openSystemSettings: () => shell.openExternal(systemSettingsUrl),

    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
      tray?.destroy()
      tray = null
      live.clear()
    },
  }
}

export type Desktop = ReturnType<typeof createDesktop>
