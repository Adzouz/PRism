import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { Stage } from '@shared/domain'
import { openDb } from '../db/client'
import { findings, prs, repos } from '../db/schema'
import type { RunResult } from '../system/exec'
import type { Ctx } from './context'
import { createMiradorBridge, isMiradorHelp, miradorNote } from './mirador'
import { createRun, saveReview, type NewFinding } from './runs'

const migrations = resolve(__dirname, '../../../drizzle')

type Exec = (args: string[]) => Promise<RunResult>

function setup(options: { mirador?: boolean; available?: boolean; code?: number } = {}) {
  const ctx: Ctx = {
    db: openDb(':memory:', migrations),
    userData: '',
    builtinSkillsDir: '',
    log: () => {},
    skillsChanged: () => {},
  }
  const repoId = ctx.db
    .insert(repos)
    .values({ owner: 'acme', name: 'app', mirador: options.mirador ?? true, addedAt: 0 })
    .returning()
    .get().id
  const addPr = (myRole: 'reviewer' | 'author', number = 42) =>
    ctx.db
      .insert(prs)
      .values({
        repoId,
        nodeId: `PR_${number}`,
        number,
        title: 'Add retries',
        url: `https://github.com/acme/app/pull/${number}`,
        author: myRole === 'author' ? 'me' : 'octocat',
        isDraft: false,
        state: 'OPEN',
        headRef: 'retries',
        headOid: 'head1',
        baseRef: 'main',
        baseOid: 'base1',
        ciState: 'none',
        additions: 1,
        deletions: 1,
        changedFiles: 1,
        reviewRequested: myRole === 'reviewer',
        myRole,
        derivedStage: 'to-review',
        stageSince: 0,
        createdAt: 0,
        updatedAt: 0,
        syncedAt: 0,
      })
      .returning()
      .get().id
  const addRun = (prId: number, stage: Stage) =>
    createRun(ctx, {
      prId,
      stage,
      skillId: null,
      skillName: null,
      agent: 'claude',
      model: 'claude-opus-5-5',
    })
  const exec = vi.fn<Exec>(async () => ({ code: options.code ?? 0, stdout: '', stderr: 'boom' }))
  const bridge = createMiradorBridge(ctx, {
    exec,
    available: async () => options.available ?? true,
  })
  return { ctx, addPr, addRun, exec, bridge }
}

const finding = (overrides: Partial<NewFinding> = {}): NewFinding => ({
  path: 'src/a.ts',
  line: 3,
  side: 'RIGHT',
  severity: 'blocking',
  title: 'Null check',
  body: 'This can be null.',
  ...overrides,
})

describe('miradorNote', () => {
  const nit = { severity: 'nit' as const, title: 'Rename', included: true }
  const blocking = { severity: 'blocking' as const, title: 'Null check', included: true }

  it('gives the verdict and its one reason', () => {
    expect(miradorNote('approve', [])).toBe('GO')
    expect(miradorNote('comment', [nit, { ...nit, included: false }])).toBe(
      'GO WITH NITS — 1 finding',
    )
    expect(miradorNote('comment', [nit, nit])).toBe('GO WITH NITS — 2 findings')
    expect(miradorNote('request_changes', [nit, { ...blocking, included: false }, blocking])).toBe(
      'NO GO — Null check',
    )
    expect(miradorNote('request_changes', [nit])).toBe('NO GO — Rename')
    expect(miradorNote('request_changes', [])).toBe('NO GO')
  })
})

describe('isMiradorHelp', () => {
  it('recognizes the Mirador CLI by the commands PRism uses', () => {
    const help = [
      'mirador — update Mirador from the terminal or from an AI agent.',
      '  mirador start [--kind fix|feature|chore|review|community] [--pr N]',
      '  mirador status <status> [ref]  Set a status',
      '  mirador note <text> [--ref R]  Add a one-line note.',
    ].join('\n')
    expect(isMiradorHelp(help)).toBe(true)
    expect(isMiradorHelp('Usage: mirador [options] <manifest>')).toBe(false)
  })
})

describe('Mirador bridge', () => {
  it('marks review and re-review runs Reviewing', async () => {
    const { addPr, addRun, exec, bridge } = setup()
    const prId = addPr('reviewer')
    await bridge.runStarted(addRun(prId, 'review'))
    await bridge.runStarted(addRun(prId, 're-review'))
    const start = ['start', '--kind', 'review', '--pr', '42', '--title', 'Add retries']
    expect(exec.mock.calls).toEqual([[start], [start]])
  })

  it('marks an address run on my pull request Addressing', async () => {
    const { addPr, addRun, exec, bridge } = setup()
    await bridge.runStarted(addRun(addPr('author'), 'address'))
    expect(exec.mock.calls).toEqual([[['status', 'addressing', '42']]])
  })

  it('stays quiet for other stages, other repositories, and without the CLI', async () => {
    const quiet = setup()
    const prId = quiet.addPr('reviewer')
    await quiet.bridge.runStarted(quiet.addRun(prId, 'test-plan'))
    await quiet.bridge.runStarted(quiet.addRun(prId, 'draft-replies'))
    expect(quiet.exec).not.toHaveBeenCalled()

    const off = setup({ mirador: false })
    await off.bridge.runStarted(off.addRun(off.addPr('reviewer'), 'review'))
    expect(off.exec).not.toHaveBeenCalled()

    const missing = setup({ available: false })
    await missing.bridge.runStarted(missing.addRun(missing.addPr('reviewer'), 'review'))
    expect(missing.exec).not.toHaveBeenCalled()
  })

  it('notes the verdict of a posted review, without excluded findings', async () => {
    const { ctx, addPr, addRun, exec, bridge } = setup()
    const run = addRun(addPr('reviewer'), 'review')
    saveReview(
      ctx,
      run.id,
      { verdict: 'request_changes', summary: 'Two issues.', dimensions: [] },
      [finding({ title: 'Wrong path' }), finding({ line: 5, title: 'Null check' })],
    )
    ctx.db.update(findings).set({ included: false }).where(eq(findings.title, 'Wrong path')).run()
    await bridge.reviewPosted(run.id)
    expect(exec.mock.calls).toEqual([[['note', 'NO GO — Null check', '--ref', '42']]])
  })

  it('logs a failing command once and never throws', async () => {
    const { addPr, addRun, exec, bridge } = setup({ code: 1 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prId = addPr('reviewer')
    await bridge.runStarted(addRun(prId, 'review'))
    await bridge.runStarted(addRun(prId, 'review'))
    exec.mockRejectedValueOnce(new Error('spawn mirador ENOENT'))
    await expect(bridge.runStarted(addRun(prId, 'review'))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
