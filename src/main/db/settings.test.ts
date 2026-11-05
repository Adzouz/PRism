import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { themePreference } from '@shared/ipc'
import { openDb } from './client'
import { getSetting, setSetting } from './settings'

const migrations = resolve(__dirname, '../../../drizzle')

describe('settings store', () => {
  it('returns fallback, then the stored value', () => {
    const db = openDb(':memory:', migrations)
    expect(getSetting(db, 'theme', themePreference, 'system')).toBe('system')
    setSetting(db, 'theme', 'dark')
    setSetting(db, 'theme', 'light')
    expect(getSetting(db, 'theme', themePreference, 'system')).toBe('light')
  })

  it('falls back when the stored value no longer matches the schema', () => {
    const db = openDb(':memory:', migrations)
    setSetting(db, 'theme', 'sepia')
    expect(getSetting(db, 'theme', themePreference, 'system')).toBe('system')
  })
})
