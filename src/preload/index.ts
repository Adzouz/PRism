import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { isIpcChannel, isIpcEvent } from '@shared/channels'
import type { PrismBridge } from '@shared/ipc'

const bridge: PrismBridge = {
  invoke: (channel, ...input) => {
    if (!isIpcChannel(channel)) return Promise.reject(new Error(`Unknown channel: ${channel}`))
    return ipcRenderer.invoke(channel, input[0])
  },
  on: (event, listener) => {
    if (!isIpcEvent(event)) throw new Error(`Unknown event: ${event}`)
    const wrapped = (_: IpcRendererEvent, payload: Parameters<typeof listener>[0]) =>
      listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  },
}

contextBridge.exposeInMainWorld('prism', bridge)
