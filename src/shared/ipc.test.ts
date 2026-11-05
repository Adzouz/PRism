import { describe, expect, it } from 'vitest'
import { ipcChannels, ipcContract, isIpcChannel } from './ipc'

describe('ipc contract', () => {
  it('has a schema for every channel', () => {
    expect(Object.keys(ipcContract).sort()).toEqual([...ipcChannels].sort())
  })

  it('recognises known channels only', () => {
    expect(isIpcChannel('settings:getTheme')).toBe(true)
    expect(isIpcChannel('settings:nope')).toBe(false)
    expect(isIpcChannel('toString')).toBe(false)
    expect(isIpcChannel(42)).toBe(false)
  })

  it('rejects invalid theme input', () => {
    expect(ipcContract['settings:setTheme'].input.safeParse('dark').success).toBe(true)
    expect(ipcContract['settings:setTheme'].input.safeParse('sepia').success).toBe(false)
  })
})
