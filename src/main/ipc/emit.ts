import { BrowserWindow } from 'electron'
import type { IpcEvent, IpcEventPayload } from '@shared/ipc'

export function emit<E extends IpcEvent>(event: E, payload: IpcEventPayload<E>) {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(event, payload)
}
