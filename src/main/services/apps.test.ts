import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDb } from '../db/client'
import { listApps, resumeCommand, setAppPreferences, terminalScript } from './apps'
import type { Ctx } from './context'

describe('apps', () => {
  it('lists installed editors and terminals with saved preferences', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-apps-'))
    await mkdir(join(dir, 'Zed.app'))
    await mkdir(join(dir, 'Cursor.app'))
    await mkdir(join(dir, 'Utilities/Terminal.app'), { recursive: true })
    await mkdir(join(dir, 'iTerm.app'))
    const ctx = { db: openDb(':memory:', resolve(__dirname, '../../../drizzle')) } as Ctx
    const apps = await listApps(ctx, [dir])
    expect(apps.editors.map((app) => app.id)).toEqual(['cursor', 'zed', 'finder'])
    expect(apps.terminals.map((app) => app.id)).toEqual(['terminal', 'iterm'])
    expect(apps.preferred).toEqual({ editor: null, terminal: null })
    setAppPreferences(ctx, { editor: 'zed' })
    expect((await listApps(ctx, [dir])).preferred).toEqual({ editor: 'zed', terminal: null })
  })

  it('builds a quoted resume command and terminal scripts', () => {
    const command = resumeCommand("/w/it's here", 'abc-123')
    expect(command).toBe("cd '/w/it'\\''s here' && claude --resume 'abc-123'")
    expect(terminalScript('terminal', command)[0]).toContain('do script')
    expect(terminalScript('iterm', 'echo "hi"').join('\n')).toContain('write text "echo \\"hi\\""')
  })
})
