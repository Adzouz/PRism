import { z } from 'zod'
import type { IpcChannel, IpcEvent } from './channels'

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
} satisfies Record<IpcChannel, { input: z.ZodType; output: z.ZodType }>

export type IpcContract = typeof ipcContract
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]['input']>
export type IpcOutput<C extends IpcChannel> = z.output<IpcContract[C]['output']>

export interface IpcEventPayloads {
  'theme:changed': { dark: boolean }
}

export type IpcEventPayload<E extends IpcEvent> = IpcEventPayloads[E]

export interface PrismBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    ...input: IpcInput<C> extends void ? [] : [IpcInput<C>]
  ): Promise<IpcOutput<C>>
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void
}
