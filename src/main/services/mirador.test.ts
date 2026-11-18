import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { Stage } from '@shared/domain'
import { openDb } from '../db/client'
import { findings, prs, repos } from '../db/schema'
import type { RunResult } from '../system/exec'
import type { Ctx } from './context'
import { createMiradorBridge, isMiradorHelp, miradorNote, type PostedReview } from './mirador'
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
  const available = vi.fn<() => Promise<boolean>>(async () => options.available ?? true)
  const bridge = createMiradorBridge(ctx, { exec, available })
  return { ctx, addPr, addRun, exec, available, bridge }
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

  const submitted = (event: PostedReview['event']): PostedReview => ({
    event,
    mode: 'submit',
    eventForced: false,
  })

  function postedReview() {
    const env = setup()
    const run = env.addRun(env.addPr('reviewer'), 'review')
    saveReview(
      env.ctx,
      run.id,
      { verdict: 'request_changes', summary: 'Two issues.', dimensions: [] },
      [finding({ title: 'Wrong path' }), finding({ line: 5, title: 'Null check' })],
    )
    return { ...env, run }
  }

  it('notes the status of a posted review, without excluded findings', async () => {
    const { ctx, run, exec, bridge } = postedReview()
    ctx.db.update(findings).set({ included: false }).where(eq(findings.title, 'Wrong path')).run()
    await bridge.reviewPosted(run.id, submitted('request_changes'))
    expect(exec.mock.calls).toEqual([[['note', 'NO GO — Null check', '--ref', '42']]])
  })

  it('notes the status the user posted, not the agent verdict', async () => {
    const { ctx, run, exec, bridge } = postedReview()
    ctx.db.update(findings).set({ included: false }).run()
    await bridge.reviewPosted(run.id, submitted('approve'))
    await bridge.reviewPosted(run.id, submitted('comment'))
    expect(exec.mock.calls).toEqual([
      [['note', 'GO', '--ref', '42']],
      [['note', 'GO WITH NITS', '--ref', '42']],
    ])
  })

  it('keeps the agent verdict when the status was forced to Comment', async () => {
    const { run, exec, bridge } = postedReview()
    await bridge.reviewPosted(run.id, { event: 'comment', mode: 'submit', eventForced: true })
    expect(exec.mock.calls).toEqual([[['note', 'NO GO — Wrong path', '--ref', '42']]])
  })

  it('marks a note for a pending draft review', async () => {
    const { run, exec, bridge } = postedReview()
    await bridge.reviewPosted(run.id, {
      event: 'request_changes',
      mode: 'draft',
      eventForced: false,
    })
    expect(exec.mock.calls).toEqual([[['note', 'draft: NO GO — Wrong path', '--ref', '42']]])
  })

  it('probes the CLI once while it is found', async () => {
    const { addPr, addRun, available, bridge } = setup()
    const prId = addPr('reviewer')
    await bridge.runStarted(addRun(prId, 'review'))
    await bridge.runStarted(addRun(prId, 're-review'))
    await bridge.status()
    expect(available).toHaveBeenCalledTimes(1)
  })

  it('probes a missing CLI again only after a minute', async () => {
    vi.useFakeTimers()
    try {
      const { available, bridge } = setup({ available: false })
      expect(await bridge.status()).toEqual({ available: false })
      expect(await bridge.status()).toEqual({ available: false })
      expect(available).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(60_000)
      await bridge.status()
      expect(available).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never throws out of a hook, even on a missing run', async () => {
    const { bridge } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const posted = bridge.reviewPosted(999, submitted('approve'))
    await expect(posted).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
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
