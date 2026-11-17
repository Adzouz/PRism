import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../db/client'
import { repos } from '../db/schema'
import type { Ctx } from '../services/context'
import { onboardingHandlers } from './handlers'

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }))

const migrations = resolve(__dirname, '../../../drizzle')
const dirs: string[] = []

function makeCtx(): Ctx {
  const userData = mkdtempSync(join(tmpdir(), 'prism-handlers-'))
  dirs.push(userData)
  return {
    db: openDb(':memory:', migrations),
    userData,
    builtinSkillsDir: '',
    log: () => {},
    skillsChanged: () => {},
  }
}

function addRepo(ctx: Ctx) {
  return ctx.db.insert(repos).values({ owner: 'acme', name: 'app', addedAt: 0 }).returning().get()
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('onboardingHandlers lifecycle hooks', () => {
  it('calls afterRepoRemoved once the repository is gone', () => {
    const ctx = makeCtx()
    const repo = addRepo(ctx)
    const seen: number[] = []
    const handlers = onboardingHandlers(ctx, {
      afterRepoRemoved: (id) => seen.push(ctx.db.select().from(repos).all().length, id),
    })
    handlers['repos:remove'](repo.id)
    expect(seen).toEqual([0, repo.id])
  })

  it('calls afterReset once the configuration is cleared', async () => {
    const ctx = makeCtx()
    addRepo(ctx)
    const seen: number[] = []
    const handlers = onboardingHandlers(ctx, {
      afterReset: () => seen.push(ctx.db.select().from(repos).all().length),
    })
    await handlers['config:reset']()
    expect(seen).toEqual([0])
  })
})
