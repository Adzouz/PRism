import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { themePreference } from '@shared/ipc'
import { openDb } from './db/client'
import { getSetting, setSetting } from './db/settings'
import { emit } from './ipc/emit'
import { boardHandlers } from './ipc/board-handlers'
import { onboardingHandlers } from './ipc/handlers'
import { registerIpc } from './ipc/register'
import { runHandlers } from './ipc/run-handlers'
import { claudeAdapter } from './agents/claude'
import { cachedGithubStatus, isOnboarded } from './services/config'
import type { Ctx } from './services/context'
import { createGithubApi } from './services/gh-api'
import { stopWatching, watchLinkedSkills } from './services/library'
import { createRunner, type AgentRunner } from './services/runner'
import { createSyncService } from './services/sync'

let runner: AgentRunner | null = null

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

  win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const page = (value: string) => value.split('#')[0]
    if (page(url) === page(win.webContents.getURL())) return
    event.preventDefault()
    if (url.startsWith('https://')) void shell.openExternal(url)
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
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
  const prsChanged = () => emit('prs:changed', null)
  const sync = createSyncService(ctx, api, {
    status: (status) => emit('sync:status', status),
    changed: prsChanged,
    login: async () => (await cachedGithubStatus()).login,
    enabled: () => isOnboarded(ctx),
  })

  runner = createRunner({
    ctx,
    api,
    adapters: { claude: claudeAdapter },
    emit: {
      run: (run) => emit('runs:changed', run),
      event: (event) => emit('runs:event', event),
      prsChanged,
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
    ...onboardingHandlers(ctx),
    ...boardHandlers(ctx, api, sync, prsChanged),
    ...runHandlers(ctx, api, runner),
  })

  createWindow()
  sync.start()
  runner.resumeAll()
  app.on('browser-window-focus', () => sync.focus())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  stopWatching()
  runner?.shutdown()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
