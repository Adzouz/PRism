import { ipcMain } from 'electron'
import { ipcContract, type IpcChannel, type IpcInput, type IpcOutput } from '@shared/ipc'

type Handlers = {
  [C in IpcChannel]: (input: IpcInput<C>) => IpcOutput<C> | Promise<IpcOutput<C>>
}

export function registerIpc(handlers: Handlers) {
  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    const { input, output } = ipcContract[channel]
    const handler = handlers[channel] as (value: unknown) => unknown
    ipcMain.handle(channel, async (_event, raw: unknown) => {
      const result = await handler(input.parse(raw))
      return output.parse(result)
    })
  }
}
