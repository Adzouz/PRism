import { BrowserWindow, dialog } from 'electron'
import { detectAgents, openAgentTerminal } from '../services/agents'
import {
  cachedGithubStatus,
  completeOnboarding,
  configStatus,
  getAgentConfig,
  resetConfiguration,
  setAgentConfig,
} from '../services/config'
import type { Ctx } from '../services/context'
import { listUserRepos, searchRepos } from '../services/github'
import {
  clearBinding,
  copyCustomFile,
  createCustomSkill,
  effectiveBindings,
  importSkill,
  linkCustomFile,
  listSkills,
  proposeBindings,
  readSkillContent,
  refreshLinkedSkills,
  setBinding,
  validateBinding,
} from '../services/library'
import {
  addRepo,
  cloneRepoTo,
  locateRepo,
  listRepos,
  removeRepo,
  setRepoOptions,
  setRepoPath,
  setRepoSource,
  setWorktreeRoot,
} from '../services/repos'
import {
  addSource,
  bootstrapSource,
  ensureBuiltinSource,
  installSource,
  listSources,
  locateSource,
  scanSourceSkills,
  setIdentity,
  syncSource,
} from '../services/sources'
import type { BoardChannel } from './board-handlers'
import type { RunChannel } from './run-handlers'
import type { registerIpc } from './register'

type Handlers = Parameters<typeof registerIpc>[0]

async function pick(options: Electron.OpenDialogOptions) {
  const window = BrowserWindow.getFocusedWindow()
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

export type LifecycleHooks = {
  beforeRepoRemoved?: (repoId: number) => void
  beforeReset?: () => void
}

export function onboardingHandlers(
  ctx: Ctx,
  hooks: LifecycleHooks = {},
): Omit<
  Handlers,
  | 'app:info'
  | 'settings:getTheme'
  | 'settings:setTheme'
  | 'theme:isDark'
  | BoardChannel
  | RunChannel
> {
  return {
    'dialog:pickFolder': ({ title, defaultPath }) =>
      pick({ title, defaultPath, properties: ['openDirectory', 'createDirectory'] }),
    'dialog:pickFile': ({ title, extensions }) =>
      pick({
        title,
        properties: ['openFile'],
        filters: extensions ? [{ name: 'Skill', extensions }] : undefined,
      }),
    'github:status': (input) => cachedGithubStatus(input?.refresh ?? true),
    'github:repos': () => listUserRepos(),
    'github:searchRepos': (query) => searchRepos(query),
    'agents:openTerminal': ({ agent, action }) => openAgentTerminal(agent, action),
    'agents:detect': () => detectAgents(),
    'agents:getConfig': () => getAgentConfig(ctx),
    'agents:setConfig': (value) => setAgentConfig(ctx, value),
    'repos:list': () => listRepos(ctx),
    'repos:add': (slug) => addRepo(ctx, slug),
    'repos:remove': (id) => {
      hooks.beforeRepoRemoved?.(id)
      return removeRepo(ctx, id)
    },
    'repos:locate': (id) => locateRepo(ctx, id),
    'repos:setPath': ({ id, path }) => setRepoPath(ctx, id, path),
    'repos:clone': ({ id, path }) => cloneRepoTo(ctx, id, path),
    'repos:setWorktreeRoot': ({ id, path }) => setWorktreeRoot(ctx, id, path),
    'repos:setSource': ({ id, sourceId }) => setRepoSource(ctx, id, sourceId),
    'repos:setOptions': ({ id, ...options }) => setRepoOptions(ctx, id, options),
    'sources:list': () => listSources(ctx),
    'sources:locate': (input) => locateSource(ctx, input),
    'sources:add': ({ input, path }) => addSource(ctx, input, path),
    'sources:install': ({ input, path }) => installSource(ctx, input, path),
    'sources:builtin': () => ensureBuiltinSource(ctx),
    'sources:bootstrap': (id) => bootstrapSource(ctx, id),
    'sources:setIdentity': ({ id, identity }) => setIdentity(ctx, id, identity),
    'sources:scan': (id) => scanSourceSkills(ctx, id),
    'sources:sync': async (id) => {
      const result = await syncSource(ctx, id)
      if (result.ok) await refreshLinkedSkills(ctx, id)
      return result
    },
    'skills:list': () => listSkills(ctx),
    'skills:import': (input) => importSkill(ctx, input),
    'skills:createCustom': (input) => createCustomSkill(ctx, input),
    'skills:addFile': ({ path, mode }) =>
      mode === 'copy' ? copyCustomFile(ctx, path) : linkCustomFile(ctx, path),
    'skills:read': (id) => readSkillContent(ctx, id),
    'bindings:get': (repoId) => effectiveBindings(ctx, repoId),
    'bindings:propose': (sourceId) => proposeBindings(ctx, sourceId),
    'bindings:set': (input) => {
      setBinding(ctx, input)
      return effectiveBindings(ctx, input.repoId)
    },
    'bindings:validate': (input) => {
      validateBinding(ctx, input)
      return effectiveBindings(ctx, input.repoId)
    },
    'bindings:clear': (input) => {
      clearBinding(ctx, input)
      return effectiveBindings(ctx, input.repoId)
    },
    'config:status': () => configStatus(ctx),
    'onboarding:complete': () => completeOnboarding(ctx),
    'config:reset': () => {
      hooks.beforeReset?.()
      return resetConfiguration(ctx)
    },
  }
}
