import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import type { OpenTarget } from '@shared/domain'
import { themePreference } from '@shared/ipc'
import { createDesktop, type Desktop } from './desktop/desktop'
import { openDb } from './db/client'
import { getSetting, setSetting } from './db/settings'
import { emit } from './ipc/emit'
import { boardHandlers } from './ipc/board-handlers'
import { gateHandlers } from './ipc/gate-handlers'
import { onboardingHandlers } from './ipc/handlers'
import { registerIpc } from './ipc/register'
import { runHandlers } from './ipc/run-handlers'
import { claudeAdapter } from './agents/claude'
import { cachedGithubStatus, isOnboarded } from './services/config'
import type { Ctx } from './services/context'
import { createActions } from './services/actions'
import { createGithubApi } from './services/gh-api'
import { stopWatching, watchLinkedSkills } from './services/library'
import { getNotificationSettings, setNotificationSettings } from './services/notices'
import { createRunner, type AgentRunner } from './services/runner'
import { createSyncService } from './services/sync'

let runner: AgentRunner | null = null
let desktop: Desktop | null = null
let mainWindow: BrowserWindow | null = null
let pendingOpen: OpenTarget | null = null

const externalLink = (url: string) => /^(https?:|mailto:)/i.test(url)

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 28, y: 28 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B0D13' : '#F7F7FA',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
    },
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (externalLink(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const page = (value: string) => value.split('#')[0]
    if (page(url) === page(win.webContents.getURL())) return
    event.preventDefault()
    if (externalLink(url)) void shell.openExternal(url)
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function showWindow() {
  if (!mainWindow) return createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  if (process.platform === 'darwin') app.focus({ steal: true })
  mainWindow.focus()
  return mainWindow
}

function openTarget(target: OpenTarget) {
  const ready = mainWindow !== null && !mainWindow.webContents.isLoadingMainFrame()
  showWindow()
  if (ready) emit('app:openPr', target)
  else pendingOpen = target
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.github.adzouz.prism')
  if (is.dev) app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'))
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  const db = openDb(join(app.getPath('userData'), 'prism.db'), join(app.getAppPath(), 'drizzle'))
  nativeTheme.themeSource = getSetting(db, 'theme', themePreference, 'system')
  nativeTheme.on('updated', () => emit('theme:changed', { dark: nativeTheme.shouldUseDarkColors }))

  const ctx: Ctx = {
    db,
    userData: app.getPath('userData'),
    builtinSkillsDir: app.isPackaged
      ? join(process.resourcesPath, 'skills')
      : join(app.getAppPath(), 'resources/skills'),
    log: (sourceId, chunk) => emit('source:log', { sourceId, chunk }),
    skillsChanged: () => emit('skills:changed', null),
  }
  watchLinkedSkills(ctx)

  const api = createGithubApi()
  const desk = createDesktop({
    ctx,
    iconDir: app.isPackaged
      ? join(process.resourcesPath, 'tray')
      : join(app.getAppPath(), 'resources/tray'),
    open: openTarget,
    show: () => void showWindow(),
    sync: () => void sync.syncNow(true),
    answer: (askId, answer) => {
      if (!answer.trim()) return
      try {
        runner?.answer({ askId, answer })
      } catch (error) {
        console.warn('Could not send the answer from the notification:', error)
      }
    },
  })
  desktop = desk
  const prsChanged = () => {
    emit('prs:changed', null)
    desk.refresh()
  }
  const sync = createSyncService(ctx, api, {
    status: (status) => emit('sync:status', status),
    changed: prsChanged,
    login: async () => (await cachedGithubStatus()).login,
    enabled: () => isOnboarded(ctx),
    events: (events) => desk.prEvents(events),
  })

  runner = createRunner({
    ctx,
    api,
    adapters: { claude: claudeAdapter },
    emit: {
      run: (run) => {
        emit('runs:changed', run)
        desk.runChanged(run)
      },
      event: (event) => emit('runs:event', event),
      prsChanged,
    },
  })

  const actions = createActions({
    ctx,
    api,
    emit: {
      prsChanged: () => {
        prsChanged()
        sync.tick()
      },
    },
  })

  registerIpc({
    'app:info': () => ({ version: app.getVersion(), platform: process.platform }),
    'settings:getTheme': () => getSetting(db, 'theme', themePreference, 'system'),
    'settings:setTheme': (theme) => {
      setSetting(db, 'theme', theme)
      nativeTheme.themeSource = theme
      return theme
    },
    'theme:isDark': () => nativeTheme.shouldUseDarkColors,
    'settings:getNotifications': () => getNotificationSettings(ctx),
    'settings:setNotifications': (patch) => {
      const next = setNotificationSettings(ctx, patch)
      desk.refresh()
      return next
    },
    'notifications:test': () => desk.test(),
    'app:pendingOpen': () => {
      const target = pendingOpen
      pendingOpen = null
      return target
    },
    ...onboardingHandlers(ctx, {
      beforeRepoRemoved: (repoId) => runner?.cancelForRepo(repoId),
      afterRepoRemoved: () => prsChanged(),
      afterRepoAdded: () => {
        if (isOnboarded(ctx)) void sync.syncNow(true)
      },
      beforeReset: () => runner?.cancelAll(),
      afterReset: () => prsChanged(),
    }),
    ...boardHandlers(ctx, api, sync, prsChanged),
    ...runHandlers(ctx, api, runner),
    ...gateHandlers(ctx, actions),
  })

  createWindow()
  desk.refresh()
  sync.start()
  runner.resumeAll()
  app.on('browser-window-focus', () => sync.focus())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  stopWatching()
  desktop?.dispose()
  runner?.shutdown()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
