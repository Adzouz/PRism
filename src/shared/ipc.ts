import { z } from 'zod'
import type { IpcChannel, IpcEvent } from './channels'
import {
  agentConfig,
  agentId,
  agentStatus,
  commandResult,
  configStatus,
  effectiveBinding,
  githubRepoSummary,
  githubStatus,
  proposal,
  repo,
  repoOptions,
  scannedSkill,
  skill,
  skillSource,
  sourceKind,
  stage,
} from './domain'

export {
  ipcChannels,
  ipcEvents,
  isIpcChannel,
  isIpcEvent,
  type IpcChannel,
  type IpcEvent,
} from './channels'

export const themePreference = z.enum(['system', 'light', 'dark'])
export type ThemePreference = z.infer<typeof themePreference>

const id = z.number().int().positive()

export const ipcContract = {
  'app:info': {
    input: z.void(),
    output: z.object({ version: z.string(), platform: z.string() }),
  },
  'settings:getTheme': {
    input: z.void(),
    output: themePreference,
  },
  'settings:setTheme': {
    input: themePreference,
    output: themePreference,
  },
  'theme:isDark': {
    input: z.void(),
    output: z.boolean(),
  },
  'dialog:pickFolder': {
    input: z.object({ title: z.string(), defaultPath: z.string().optional() }),
    output: z.string().nullable(),
  },
  'dialog:pickFile': {
    input: z.object({ title: z.string(), extensions: z.array(z.string()).optional() }),
    output: z.string().nullable(),
  },
  'github:status': {
    input: z.object({ refresh: z.boolean() }).optional(),
    output: githubStatus,
  },
  'github:repos': {
    input: z.void(),
    output: z.array(githubRepoSummary),
  },
  'github:searchRepos': {
    input: z.string(),
    output: z.array(githubRepoSummary),
  },
  'agents:openTerminal': {
    input: z.object({ agent: agentId, action: z.enum(['install', 'login']) }),
    output: z.void(),
  },
  'agents:detect': {
    input: z.void(),
    output: z.array(agentStatus),
  },
  'agents:getConfig': {
    input: z.void(),
    output: agentConfig.nullable(),
  },
  'agents:setConfig': {
    input: agentConfig,
    output: agentConfig,
  },
  'repos:list': {
    input: z.void(),
    output: z.array(repo),
  },
  'repos:add': {
    input: z.string().min(1),
    output: repo,
  },
  'repos:remove': {
    input: id,
    output: z.void(),
  },
  'repos:locate': {
    input: id,
    output: z.object({ candidates: z.array(z.string()), suggestedClonePath: z.string() }),
  },
  'repos:setPath': {
    input: z.object({ id, path: z.string() }),
    output: repo,
  },
  'repos:clone': {
    input: z.object({ id, path: z.string() }),
    output: repo,
  },
  'repos:setWorktreeRoot': {
    input: z.object({ id, path: z.string() }),
    output: repo,
  },
  'repos:setSource': {
    input: z.object({ id, sourceId: id.nullable() }),
    output: repo,
  },
  'repos:setOptions': {
    input: z.object({ id }).extend(repoOptions.shape),
    output: repo,
  },
  'sources:list': {
    input: z.void(),
    output: z.array(skillSource),
  },
  'sources:locate': {
    input: z.string(),
    output: z.object({
      kind: sourceKind,
      key: z.string(),
      name: z.string(),
      candidates: z.array(z.string()),
      defaultInstallPath: z.string(),
      existingId: id.nullable(),
    }),
  },
  'sources:add': {
    input: z.object({ input: z.string(), path: z.string() }),
    output: skillSource,
  },
  'sources:install': {
    input: z.object({ input: z.string(), path: z.string() }),
    output: skillSource,
  },
  'sources:builtin': {
    input: z.void(),
    output: skillSource,
  },
  'sources:bootstrap': {
    input: id,
    output: commandResult,
  },
  'sources:setIdentity': {
    input: z.object({ id, identity: z.string().nullable() }),
    output: skillSource,
  },
  'sources:scan': {
    input: id,
    output: z.array(scannedSkill),
  },
  'sources:sync': {
    input: id,
    output: commandResult,
  },
  'skills:list': {
    input: z.void(),
    output: z.array(skill),
  },
  'skills:import': {
    input: z.object({ sourceId: id, relDir: z.string(), mode: z.enum(['copy', 'link']) }),
    output: skill,
  },
  'skills:createCustom': {
    input: z.object({ name: z.string(), content: z.string() }),
    output: skill,
  },
  'skills:addFile': {
    input: z.object({ path: z.string(), mode: z.enum(['copy', 'link']) }),
    output: skill,
  },
  'skills:read': {
    input: id,
    output: z.string(),
  },
  'bindings:get': {
    input: id.nullable(),
    output: z.array(effectiveBinding),
  },
  'bindings:propose': {
    input: id.nullable(),
    output: z.array(proposal),
  },
  'bindings:set': {
    input: z.object({
      repoId: id.nullable(),
      stage,
      skillId: id,
      validated: z.boolean().optional(),
    }),
    output: z.array(effectiveBinding),
  },
  'bindings:validate': {
    input: z.object({ repoId: id.nullable(), stage, validated: z.boolean() }),
    output: z.array(effectiveBinding),
  },
  'bindings:clear': {
    input: z.object({ repoId: id.nullable(), stage }),
    output: z.array(effectiveBinding),
  },
  'config:status': {
    input: z.void(),
    output: configStatus,
  },
  'onboarding:complete': {
    input: z.void(),
    output: configStatus,
  },
  'config:reset': {
    input: z.void(),
    output: configStatus,
  },
} satisfies Record<IpcChannel, { input: z.ZodType; output: z.ZodType }>

export type IpcContract = typeof ipcContract
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>
export type IpcOutput<C extends IpcChannel> = z.output<IpcContract[C]['output']>

export interface IpcEventPayloads {
  'theme:changed': { dark: boolean }
  'source:log': { sourceId: number; chunk: string }
  'skills:changed': null
}

export type IpcEventPayload<E extends IpcEvent> = IpcEventPayloads[E]

export interface PrismBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    ...input: IpcInput<C> extends void ? [] : [IpcInput<C>]
  ): Promise<IpcOutput<C>>
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void
}
