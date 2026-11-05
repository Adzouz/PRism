export const ipcChannels = [
  'app:info',
  'settings:getTheme',
  'settings:setTheme',
  'theme:isDark',
  'dialog:pickFolder',
  'dialog:pickFile',
  'github:status',
  'github:repos',
  'github:searchRepos',
  'agents:detect',
  'agents:getConfig',
  'agents:setConfig',
  'agents:openTerminal',
  'repos:list',
  'repos:add',
  'repos:remove',
  'repos:locate',
  'repos:setPath',
  'repos:clone',
  'repos:setWorktreeRoot',
  'repos:setSource',
  'repos:setOptions',
  'sources:list',
  'sources:locate',
  'sources:add',
  'sources:install',
  'sources:builtin',
  'sources:bootstrap',
  'sources:setIdentity',
  'sources:scan',
  'sources:sync',
  'skills:list',
  'skills:import',
  'skills:createCustom',
  'skills:addFile',
  'skills:read',
  'bindings:get',
  'bindings:propose',
  'bindings:set',
  'bindings:validate',
  'bindings:clear',
  'config:status',
  'onboarding:complete',
  'config:reset',
] as const

export type IpcChannel = (typeof ipcChannels)[number]

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && (ipcChannels as readonly string[]).includes(value)
}

export const ipcEvents = ['theme:changed', 'source:log', 'skills:changed'] as const

export type IpcEvent = (typeof ipcEvents)[number]

export function isIpcEvent(value: unknown): value is IpcEvent {
  return typeof value === 'string' && (ipcEvents as readonly string[]).includes(value)
}
