import { watch, type FSWatcher } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import {
  stages,
  type EffectiveBinding,
  type Proposal,
  type Skill,
  type SkillMode,
  type Stage,
} from '@shared/domain'
import { skills, skillSources, stageBindings } from '../db/schema'
import { importCommand, scanSource } from '../skills/manifest'
import { proposeFromSource } from '../skills/match'
import { hashPath, parseFrontmatter, readSkillFile, scanSkills } from '../skills/scan'
import { runStreaming } from '../system/exec'
import type { Ctx } from './context'
import { exists } from './git'
import { ensureBuiltinSource, getSource, scanSourceSkills } from './sources'

type SkillRow = typeof skills.$inferSelect

const toSkill = (row: SkillRow): Skill => ({ ...row })

export function listSkills(ctx: Ctx) {
  return ctx.db.select().from(skills).all().map(toSkill)
}

function getSkill(ctx: Ctx, id: number) {
  const row = ctx.db.select().from(skills).where(eq(skills.id, id)).get()
  if (!row) throw new Error(`Skill ${id} not found`)
  return row
}

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  )
}

async function freeDir(base: string, name: string) {
  let candidate = join(base, slug(name))
  for (let i = 2; await exists(candidate); i++) candidate = join(base, `${slug(name)}-${i}`)
  return candidate
}

function libraryDir(ctx: Ctx, ...parts: string[]) {
  return join(ctx.userData, 'skills', ...parts)
}

function insertSkill(
  ctx: Ctx,
  values: Omit<SkillRow, 'id'>,
  match?: { sourceId: number | null; path: string; mode: SkillMode },
) {
  if (match) {
    const existing = ctx.db
      .select()
      .from(skills)
      .where(and(eq(skills.path, match.path), eq(skills.mode, match.mode)))
      .get()
    if (existing) {
      const row = ctx.db
        .update(skills)
        .set(values)
        .where(eq(skills.id, existing.id))
        .returning()
        .get()
      return toSkill(row)
    }
  }
  const skill = toSkill(ctx.db.insert(skills).values(values).returning().get())
  watchSkill(ctx, skill)
  return skill
}

export async function importSkill(
  ctx: Ctx,
  input: { sourceId: number; relDir: string; mode: 'copy' | 'link' },
) {
  const source = await getSource(ctx, input.sourceId)
  if (!source.localPath) throw new Error('Source has no local folder')
  const scanned = await scanSource(source.localPath, source.manifest, source.identities)
  let found = scanned.find((skill) => skill.relDir === input.relDir)
  if (!found) throw new Error(`No skill at ${input.relDir}`)

  const template = source.manifest?.import
  if (template && found.identity && source.identity && found.identity !== source.identity) {
    const command = importCommand(template, found.identity, [found.name])
    const ok =
      (await runStreaming(command, {
        cwd: source.localPath,
        onData: (chunk) => ctx.log(source.id, chunk),
      })) === 0
    if (!ok) throw new Error(`Import command failed: ${command}`)
    const rescanned = await scanSource(source.localPath, source.manifest, source.identities)
    const own = rescanned.find(
      (skill) => skill.name === found!.name && skill.identity === source.identity,
    )
    if (!own) throw new Error(`Imported ${found.name}, but it is not in your identity folder`)
    found = own
  }

  const mode: SkillMode = source.kind === 'builtin' ? 'copy' : input.mode
  if (mode === 'link') {
    return insertSkill(
      ctx,
      {
        sourceId: source.id,
        name: found.name,
        description: found.description,
        mode,
        path: found.dir,
        contentHash: await hashPath(found.dir),
      },
      { sourceId: source.id, path: found.dir, mode },
    )
  }
  const existingCopy = ctx.db
    .select()
    .from(skills)
    .where(
      and(eq(skills.sourceId, source.id), eq(skills.mode, 'copy'), eq(skills.name, found.name)),
    )
    .get()
  if (existingCopy) return toSkill(existingCopy)
  const dest = await freeDir(libraryDir(ctx, slug(source.name)), found.name)
  await mkdir(dest, { recursive: true })
  await cp(found.dir, dest, {
    recursive: true,
    filter: (src) => !/(^|\/)(\.git|node_modules)(\/|$)/.test(src.slice(found!.dir.length)),
  })
  return insertSkill(ctx, {
    sourceId: source.id,
    name: found.name,
    description: found.description,
    mode,
    path: dest,
    contentHash: await hashPath(dest),
  })
}

export async function createCustomSkill(ctx: Ctx, input: { name: string; content: string }) {
  const frontmatter = parseFrontmatter(input.content)
  const name = frontmatter?.name ?? input.name.trim()
  if (!name) throw new Error('Give the skill a name')
  const content = frontmatter
    ? input.content
    : `---\nname: ${slug(name)}\ndescription: ${JSON.stringify(input.name.trim())}\n---\n\n${input.content}`
  const dir = await freeDir(libraryDir(ctx, 'custom'), name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), content)
  return insertSkill(ctx, {
    sourceId: null,
    name: frontmatter?.name ?? slug(name),
    description: frontmatter?.description ?? input.name.trim(),
    mode: 'custom',
    path: dir,
    contentHash: await hashPath(dir),
  })
}

export async function copyCustomFile(ctx: Ctx, file: string) {
  const content = await readFile(resolve(file), 'utf8')
  return createCustomSkill(ctx, { name: basename(file).replace(/\.md$/i, ''), content })
}

export async function linkCustomFile(ctx: Ctx, file: string) {
  const path = resolve(file)
  const { name, description } = await readSkillFile(path)
  return insertSkill(
    ctx,
    {
      sourceId: null,
      name,
      description,
      mode: 'linked_file',
      path,
      contentHash: await hashPath(path),
    },
    { sourceId: null, path, mode: 'linked_file' },
  )
}

export async function readSkillContent(ctx: Ctx, id: number) {
  const row = getSkill(ctx, id)
  const file = row.mode === 'linked_file' ? row.path : join(row.path, 'SKILL.md')
  return readFile(file, 'utf8')
}

const watchers = new Map<number, FSWatcher>()
const pending = new Map<number, NodeJS.Timeout>()

function watchSkill(ctx: Ctx, skill: Skill) {
  if (skill.mode !== 'link' && skill.mode !== 'linked_file') return
  if (watchers.has(skill.id)) return
  try {
    const file = skill.mode === 'linked_file'
    const target = file ? dirname(skill.path) : skill.path
    const watcher = watch(target, { recursive: !file }, (_event, filename) => {
      if (file && filename !== basename(skill.path)) return
      clearTimeout(pending.get(skill.id))
      pending.set(
        skill.id,
        setTimeout(() => void refreshSkill(ctx, skill.id), 300),
      )
    })
    watcher.on('error', () => {
      watcher.close()
      watchers.delete(skill.id)
    })
    watchers.set(skill.id, watcher)
  } catch {
    return
  }
}

async function refreshSkill(ctx: Ctx, id: number) {
  const row = ctx.db.select().from(skills).where(eq(skills.id, id)).get()
  if (!row) return
  const file = row.mode === 'linked_file' ? row.path : join(row.path, 'SKILL.md')
  const info = await readSkillFile(file).catch(() => null)
  const contentHash = await hashPath(row.path)
  if (contentHash === row.contentHash && info?.name === row.name) return
  ctx.db
    .update(skills)
    .set({
      contentHash,
      name: info?.name ?? row.name,
      description: info?.description ?? row.description,
    })
    .where(eq(skills.id, id))
    .run()
  ctx.skillsChanged()
}

export async function refreshLinkedSkills(ctx: Ctx, sourceId?: number) {
  for (const row of ctx.db.select().from(skills).all()) {
    if (row.mode !== 'link' && row.mode !== 'linked_file') continue
    if (sourceId !== undefined && row.sourceId !== sourceId) continue
    await refreshSkill(ctx, row.id)
  }
}

export function watchLinkedSkills(ctx: Ctx) {
  for (const skill of listSkills(ctx)) watchSkill(ctx, skill)
}

export function stopWatching() {
  for (const watcher of watchers.values()) watcher.close()
  watchers.clear()
}

export function setBinding(
  ctx: Ctx,
  input: { repoId: number | null; stage: Stage; skillId: number; validated?: boolean },
) {
  getSkill(ctx, input.skillId)
  const repoId = input.repoId ?? 0
  const validatedAt = input.validated ? Date.now() : null
  ctx.db
    .insert(stageBindings)
    .values({
      scope: repoId ? 'repo' : 'global',
      repoId,
      stage: input.stage,
      skillId: input.skillId,
      validatedAt,
    })
    .onConflictDoUpdate({
      target: [stageBindings.repoId, stageBindings.stage],
      set: { skillId: input.skillId, validatedAt },
    })
    .run()
}

export function validateBinding(
  ctx: Ctx,
  input: { repoId: number | null; stage: Stage; validated: boolean },
) {
  const repoId = input.repoId ?? 0
  const result = ctx.db
    .update(stageBindings)
    .set({ validatedAt: input.validated ? Date.now() : null })
    .where(and(eq(stageBindings.repoId, repoId), eq(stageBindings.stage, input.stage)))
    .run()
  if (result.changes === 0) throw new Error('Pick a skill for this stage first')
}

export function clearBinding(ctx: Ctx, input: { repoId: number | null; stage: Stage }) {
  ctx.db
    .delete(stageBindings)
    .where(and(eq(stageBindings.repoId, input.repoId ?? 0), eq(stageBindings.stage, input.stage)))
    .run()
}

export function effectiveBindings(ctx: Ctx, repoId: number | null): EffectiveBinding[] {
  const rows = ctx.db.select().from(stageBindings).all()
  const sourceNames = new Map(
    ctx.db
      .select({ id: skillSources.id, name: skillSources.name })
      .from(skillSources)
      .all()
      .map((row) => [row.id, row.name]),
  )
  return stages.map((stage) => {
    const own = repoId ? rows.find((row) => row.repoId === repoId && row.stage === stage) : null
    const global = rows.find((row) => row.repoId === 0 && row.stage === stage)
    const binding = own ?? global ?? null
    const skillRow = binding
      ? (ctx.db.select().from(skills).where(eq(skills.id, binding.skillId)).get() ?? null)
      : null
    return {
      stage,
      skill: skillRow ? toSkill(skillRow) : null,
      sourceName: skillRow?.sourceId ? (sourceNames.get(skillRow.sourceId) ?? null) : null,
      inherited: Boolean(repoId) && !own && Boolean(global),
      validated: Boolean(binding?.validatedAt),
    }
  })
}

export async function proposeBindings(ctx: Ctx, sourceId: number | null): Promise<Proposal[]> {
  const builtin = await ensureBuiltinSource(ctx)
  const builtinSkills = await scanSkills(builtin.localPath!)
  const builtinMatches = proposeFromSource(builtinSkills, null, null)
  const source = sourceId ? await getSource(ctx, sourceId) : null
  const matches = source
    ? proposeFromSource(await scanSourceSkills(ctx, source.id), source.manifest, source.identity)
    : null
  return stages.map((stage, index) => {
    const match = matches?.[index]
    if (source && match?.skill && match.reason !== 'none') {
      return {
        stage,
        skillName: match.skill.name,
        sourceId: source.id,
        relDir: match.skill.relDir,
        reason: source.kind === 'builtin' ? 'builtin' : match.reason,
      }
    }
    const fallback = builtinMatches[index]?.skill
    if (fallback) {
      return {
        stage,
        skillName: fallback.name,
        sourceId: builtin.id,
        relDir: fallback.relDir,
        reason: 'builtin',
      }
    }
    return { stage, skillName: null, sourceId: null, relDir: null, reason: 'none' }
  })
}
