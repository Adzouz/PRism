export const ipcChannels = [
  'app:info',
  'settings:getTheme',
  'settings:setTheme',
  'theme:isDark',
] as const

export type IpcChannel = (typeof ipcChannels)[number]

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && (ipcChannels as readonly string[]).includes(value)
}

export const ipcEvents = ['theme:changed'] as const

export type IpcEvent = (typeof ipcEvents)[number]

export function isIpcEvent(value: unknown): value is IpcEvent {
  return typeof value === 'string' && (ipcEvents as readonly string[]).includes(value)
}
