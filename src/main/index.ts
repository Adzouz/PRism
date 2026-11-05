import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { themePreference } from '@shared/ipc'
import { openDb } from './db/client'
import { getSetting, setSetting } from './db/settings'
import { emit } from './ipc/emit'
import { registerIpc } from './ipc/register'

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
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

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.github.adzouz.prism')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  const db = openDb(join(app.getPath('userData'), 'prism.db'), join(app.getAppPath(), 'drizzle'))
  nativeTheme.themeSource = getSetting(db, 'theme', themePreference, 'system')
  nativeTheme.on('updated', () => emit('theme:changed', { dark: nativeTheme.shouldUseDarkColors }))

  registerIpc({
    'app:info': () => ({ version: app.getVersion(), platform: process.platform }),
    'settings:getTheme': () => getSetting(db, 'theme', themePreference, 'system'),
    'settings:setTheme': (theme) => {
      setSetting(db, 'theme', theme)
      nativeTheme.themeSource = theme
      return theme
    },
    'theme:isDark': () => nativeTheme.shouldUseDarkColors,
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
