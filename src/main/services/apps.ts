import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  appPreferences,
  type AppChoice,
  type AppPreferences,
  type InstalledApps,
} from '@shared/domain'
import { getSetting, setSetting } from '../db/settings'
import { run } from '../system/exec'
import { appleScriptString } from './agents'
import type { Ctx } from './context'
import { exists } from './git'

type KnownApp = AppChoice & { bundle: string }

const editorApps: KnownApp[] = [
  { id: 'cursor', name: 'Cursor', bundle: 'Cursor.app' },
  { id: 'vscode', name: 'VS Code', bundle: 'Visual Studio Code.app' },
  { id: 'zed', name: 'Zed', bundle: 'Zed.app' },
  { id: 'windsurf', name: 'Windsurf', bundle: 'Windsurf.app' },
  { id: 'sublime', name: 'Sublime Text', bundle: 'Sublime Text.app' },
  { id: 'webstorm', name: 'WebStorm', bundle: 'WebStorm.app' },
  { id: 'idea', name: 'IntelliJ IDEA', bundle: 'IntelliJ IDEA.app' },
  { id: 'idea-ce', name: 'IntelliJ IDEA CE', bundle: 'IntelliJ IDEA CE.app' },
  { id: 'nova', name: 'Nova', bundle: 'Nova.app' },
]

const terminalApps: KnownApp[] = [
  { id: 'terminal', name: 'Terminal', bundle: 'Utilities/Terminal.app' },
  { id: 'iterm', name: 'iTerm', bundle: 'iTerm.app' },
  { id: 'ghostty', name: 'Ghostty', bundle: 'Ghostty.app' },
  { id: 'warp', name: 'Warp', bundle: 'Warp.app' },
]

const finder: AppChoice = { id: 'finder', name: 'Finder' }

export const defaultAppDirs = () => [
  '/Applications',
  join(homedir(), 'Applications'),
  '/System/Applications',
]

async function locate(app: KnownApp, dirs: string[]) {
  for (const dir of dirs) {
    const path = join(dir, app.bundle)
    if (await exists(path)) return path
  }
  return null
}

async function installed(apps: KnownApp[], dirs: string[]) {
  const found = await Promise.all(apps.map(async (app) => ({ app, path: await locate(app, dirs) })))
  return found.filter((item): item is Installed => item.path !== null)
}

export function getAppPreferences(ctx: Ctx): AppPreferences {
  return getSetting(ctx.db, 'apps', appPreferences, { editor: null, terminal: null })
}

export async function listApps(ctx: Ctx, dirs = defaultAppDirs()): Promise<InstalledApps> {
  const [editors, terminals] = await Promise.all([
    installed(editorApps, dirs),
    installed(terminalApps, dirs),
  ])
  const strip = ({ app }: { app: KnownApp }) => ({ id: app.id, name: app.name })
  return {
    editors: [...editors.map(strip), finder],
    terminals: terminals.map(strip),
    preferred: getAppPreferences(ctx),
  }
}

export function setAppPreferences(ctx: Ctx, patch: Partial<AppPreferences>) {
  const next = { ...getAppPreferences(ctx), ...patch }
  setSetting(ctx.db, 'apps', next)
  return next
}

type Installed = { app: KnownApp; path: string }

function pick(list: Installed[], id: string | null) {
  return list.find((item) => item.app.id === id) ?? list[0] ?? null
}

async function openWith(appPath: string | null, target: string) {
  const args = appPath ? ['-a', appPath, target] : [target]
  const result = await run('/usr/bin/open', args, { timeout: 15_000 })
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Could not open ${target}`)
}

export async function openInEditor(ctx: Ctx, path: string, dirs = defaultAppDirs()) {
  const preferred = getAppPreferences(ctx).editor
  const choice = preferred === finder.id ? null : pick(await installed(editorApps, dirs), preferred)
  await openWith(choice?.path ?? null, path)
}

export async function openInTerminal(ctx: Ctx, path: string, dirs = defaultAppDirs()) {
  const terminals = await installed(terminalApps, dirs)
  const choice = pick(terminals, getAppPreferences(ctx).terminal)
  await openWith(choice?.path ?? '/System/Applications/Utilities/Terminal.app', path)
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function resumeCommand(path: string, sessionId: string) {
  return `cd ${shellQuote(path)} && claude --resume ${shellQuote(sessionId)}`
}

export function terminalScript(terminal: string, command: string) {
  if (terminal === 'iterm') {
    return [
      'tell application "iTerm"',
      'activate',
      'set prismWindow to (create window with default profile)',
      `tell current session of prismWindow to write text ${appleScriptString(command)}`,
      'end tell',
    ]
  }
  return [
    `tell application "Terminal" to do script ${appleScriptString(command)}`,
    'tell application "Terminal" to activate',
  ]
}

export async function runInTerminal(ctx: Ctx, command: string, dirs = defaultAppDirs()) {
  const terminals = await installed(terminalApps, dirs)
  const choice = pick(terminals, getAppPreferences(ctx).terminal)
  const lines = terminalScript(choice?.app.id === 'iterm' ? 'iterm' : 'terminal', command)
  const result = await run(
    '/usr/bin/osascript',
    lines.flatMap((line) => ['-e', line]),
  )
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Could not open a terminal')
}
