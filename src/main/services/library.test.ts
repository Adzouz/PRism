import { chmod, mkdtemp, mkdir, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { openDb } from '../db/client'
import { getSetting, setSetting } from '../db/settings'
import { resetConfiguration } from './config'
import { exists } from './git'
import { repos } from '../db/schema'
import type { Ctx } from './context'
import {
  createCustomSkill,
  effectiveBindings,
  findSkill,
  importSkill,
  linkCustomFile,
  proposeBindings,
  readSkillContent,
  refreshBuiltinSkills,
  setBinding,
  stopWatching,
  validateBinding,
} from './library'
import { addSource, ensureBuiltinSource } from './sources'

const migrations = resolve(__dirname, '../../../drizzle')
const builtin = resolve(__dirname, '../../../resources/skills')

async function makeCtx(): Promise<Ctx> {
  return {
    db: openDb(':memory:', migrations),
    userData: await mkdtemp(join(tmpdir(), 'prism-data-')),
    builtinSkillsDir: builtin,
    log: () => {},
    skillsChanged: () => {},
  }
}

afterAll(stopWatching)

describe('library', () => {
  it('proposes built-in starters when there is no source', async () => {
    const ctx = await makeCtx()
    const proposals = await proposeBindings(ctx, null)
    expect(proposals.every((p) => p.reason === 'builtin' && p.skillName)).toBe(true)
  })

  it('imports by copy and link, binds and validates per repo with global fallback', async () => {
    const ctx = await makeCtx()
    const folder = await mkdtemp(join(tmpdir(), 'prism-local-'))
    await mkdir(join(folder, 'skills/code-review/agents'), { recursive: true })
    await writeFile(
      join(folder, 'skills/code-review/SKILL.md'),
      '---\nname: code-review\ndescription: Review a branch\n---\nBody',
    )
    await writeFile(join(folder, 'skills/code-review/agents/x.md'), 'agent')
    const source = await addSource(ctx, folder, folder)
    expect(source.kind).toBe('local')

    const proposals = await proposeBindings(ctx, source.id)
    expect(proposals.find((p) => p.stage === 'review')).toMatchObject({
      reason: 'match',
      relDir: 'skills/code-review',
    })
    expect(proposals.find((p) => p.stage === 'address')?.reason).toBe('builtin')

    const copied = await importSkill(ctx, {
      sourceId: source.id,
      relDir: 'skills/code-review',
      mode: 'copy',
    })
    expect(copied.path.startsWith(ctx.userData)).toBe(true)
    const linked = await importSkill(ctx, {
      sourceId: source.id,
      relDir: 'skills/code-review',
      mode: 'link',
    })
    expect(linked.path).toBe(join(folder, 'skills/code-review'))
    const again = await importSkill(ctx, {
      sourceId: source.id,
      relDir: 'skills/code-review',
      mode: 'link',
    })
    expect(again.id).toBe(linked.id)

    const repo = ctx.db
      .insert(repos)
      .values({ owner: 'acme', name: 'app', addedAt: 0 })
      .returning()
      .get()
    setBinding(ctx, { repoId: null, stage: 'review', skillId: copied.id })
    validateBinding(ctx, { repoId: null, stage: 'review', validated: true })
    let review = effectiveBindings(ctx, repo.id).find((b) => b.stage === 'review')!
    expect(review).toMatchObject({ inherited: true, validated: true, skill: { id: copied.id } })

    setBinding(ctx, { repoId: repo.id, stage: 'review', skillId: linked.id })
    review = effectiveBindings(ctx, repo.id).find((b) => b.stage === 'review')!
    expect(review).toMatchObject({ inherited: false, validated: false, skill: { id: linked.id } })
    expect(() =>
      validateBinding(ctx, { repoId: repo.id, stage: 'address', validated: true }),
    ).toThrow('Pick a skill')
  })

  it('creates custom skills with generated frontmatter', async () => {
    const ctx = await makeCtx()
    const skill = await createCustomSkill(ctx, { name: 'My Review', content: 'Do the thing' })
    expect(skill).toMatchObject({ name: 'my-review', mode: 'custom', description: 'My Review' })
  })
})

describe('linked files', () => {
  it('picks up every edit saved by atomic rename', async () => {
    const ctx = await makeCtx()
    let changes = 0
    ctx.skillsChanged = () => {
      changes += 1
    }
    const wait = (ms: number) => new Promise((done) => setTimeout(done, ms))
    const dir = await mkdtemp(join(tmpdir(), 'prism-linked-'))
    const file = join(dir, 'mine.md')
    await writeFile(file, '---\nname: mine\ndescription: v1\n---\n')
    await linkCustomFile(ctx, file)
    let version = 1
    const saveUntilReported = async () => {
      const before = changes
      const reported = () => changes > before
      for (let tries = 0; !reported() && tries < 8; tries += 1) {
        version += 1
        await writeFile(join(dir, 'tmp.md'), `---\nname: mine\ndescription: v${version}\n---\n`)
        await rename(join(dir, 'tmp.md'), file)
        for (let waited = 0; !reported() && waited < 1500; waited += 50) await wait(50)
      }
      return reported()
    }
    expect(await saveUntilReported()).toBe(true)
    await wait(600)
    expect(await saveUntilReported()).toBe(true)
  }, 40_000)
})

describe('reset', () => {
  it('clears configuration but keeps the theme', async () => {
    const ctx = await makeCtx()
    setSetting(ctx.db, 'theme', 'dark')
    setSetting(ctx.db, 'agent', { agent: 'claude', model: '' })
    const skill = await createCustomSkill(ctx, { name: 'x', content: 'y' })
    setBinding(ctx, { repoId: null, stage: 'review', skillId: skill.id, validated: true })
    expect(effectiveBindings(ctx, null)[0]).toMatchObject({ validated: true })
    await resetConfiguration(ctx)
    expect(effectiveBindings(ctx, null).every((b) => b.skill === null)).toBe(true)
    expect(getSetting(ctx.db, 'agent', z.unknown(), null)).toBeNull()
    expect(getSetting(ctx.db, 'theme', z.string(), 'system')).toBe('dark')
    expect(await exists(join(ctx.userData, 'skills'))).toBe(false)
  })
})

describe('built-in source', () => {
  it('labels proposals from the built-in source as built-in', async () => {
    const ctx = await makeCtx()
    const builtinSource = await ensureBuiltinSource(ctx)
    const proposals = await proposeBindings(ctx, builtinSource.id)
    expect(proposals.every((p) => p.reason === 'builtin')).toBe(true)
  })

  it('ships one starter per stage', async () => {
    const ctx = await makeCtx()
    const proposals = await proposeBindings(ctx, null)
    expect(Object.fromEntries(proposals.map((p) => [p.stage, p.skillName]))).toEqual({
      review: 'pr-review',
      're-review': 'pr-re-review',
      'test-plan': 'pr-test-plan',
      address: 'address-comments',
      'draft-replies': 'draft-replies',
    })
  })

  it('refreshes untouched copies when the bundled starter changes', async () => {
    const ctx = await makeCtx()
    ctx.builtinSkillsDir = await mkdtemp(join(tmpdir(), 'prism-builtin-'))
    let changes = 0
    ctx.skillsChanged = () => {
      changes += 1
    }
    const bundle = async (name: string, version: string) => {
      await mkdir(join(ctx.builtinSkillsDir, name), { recursive: true })
      await writeFile(
        join(ctx.builtinSkillsDir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${version}\n---\n${version}`,
      )
    }
    await bundle('pr-review', 'v1')
    await bundle('pr-test-plan', 'v1')
    const source = await ensureBuiltinSource(ctx)
    const review = await importSkill(ctx, {
      sourceId: source.id,
      relDir: 'pr-review',
      mode: 'copy',
    })
    const plan = await importSkill(ctx, {
      sourceId: source.id,
      relDir: 'pr-test-plan',
      mode: 'copy',
    })
    expect(await refreshBuiltinSkills(ctx)).toBe(0)

    const edited = '---\nname: pr-test-plan\ndescription: mine\n---\nmine'
    await writeFile(join(plan.path, 'SKILL.md'), edited)
    await bundle('pr-review', 'v2')
    await bundle('pr-test-plan', 'v2')

    expect(await refreshBuiltinSkills(ctx)).toBe(1)
    expect(changes).toBe(1)
    expect(await readSkillContent(ctx, review.id)).toContain('v2')
    expect(findSkill(ctx, review.id)).toMatchObject({ description: 'v2', path: review.path })
    expect(await readSkillContent(ctx, plan.id)).toBe(edited)
    expect(await exists(`${review.path}.next`)).toBe(false)
    expect(await exists(`${review.path}.old`)).toBe(false)
    expect(await refreshBuiltinSkills(ctx)).toBe(0)

    await rename(review.path, `${review.path}.old`)
    await bundle('pr-review', 'v3')
    expect(await refreshBuiltinSkills(ctx)).toBe(1)
    expect(await readSkillContent(ctx, review.id)).toContain('v3')
    expect(await exists(`${review.path}.old`)).toBe(false)
  })

  it('records the new hash even when the old copy cannot be removed', async () => {
    const ctx = await makeCtx()
    ctx.builtinSkillsDir = await mkdtemp(join(tmpdir(), 'prism-builtin-'))
    const bundle = async (name: string, version: string) => {
      await mkdir(join(ctx.builtinSkillsDir, name, 'locked'), { recursive: true })
      await writeFile(join(ctx.builtinSkillsDir, name, 'locked', 'notes.md'), 'notes')
      await writeFile(
        join(ctx.builtinSkillsDir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${version}\n---\n${version}`,
      )
    }
    await bundle('pr-review', 'v1')
    await bundle('pr-test-plan', 'v1')
    const source = await ensureBuiltinSource(ctx)
    const review = await importSkill(ctx, {
      sourceId: source.id,
      relDir: 'pr-review',
      mode: 'copy',
    })
    const plan = await importSkill(ctx, {
      sourceId: source.id,
      relDir: 'pr-test-plan',
      mode: 'copy',
    })
    const locked = join(review.path, 'locked')
    await chmod(locked, 0o500)
    try {
      await bundle('pr-review', 'v2')
      await bundle('pr-test-plan', 'v2')
      expect(await refreshBuiltinSkills(ctx)).toBe(2)
      expect(await exists(`${review.path}.old`)).toBe(true)
      expect(await readSkillContent(ctx, review.id)).toContain('v2')
      expect(await readSkillContent(ctx, plan.id)).toContain('v2')

      await bundle('pr-review', 'v3')
      await bundle('pr-test-plan', 'v3')
      expect(await refreshBuiltinSkills(ctx)).toBe(1)
      expect(await readSkillContent(ctx, review.id)).toContain('v2')
      expect(await readSkillContent(ctx, plan.id)).toContain('v3')

      await chmod(`${review.path}.old/locked`, 0o700)
      expect(await refreshBuiltinSkills(ctx)).toBe(1)
      expect(await readSkillContent(ctx, review.id)).toContain('v3')
      expect(await exists(`${review.path}.old`)).toBe(false)
    } finally {
      await chmod(`${review.path}.old/locked`, 0o700).catch(() => {})
    }
  })
})
