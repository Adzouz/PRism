import { mkdir } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { manifest as manifestSchema, type SkillSource, type SourceKind } from '@shared/domain'
import { skillSources } from '../db/schema'
import { currentIdentity, listIdentities, readManifest, scanSource } from '../skills/manifest'
import { runStreaming } from '../system/exec'
import type { Ctx } from './context'
import {
  cloneRepo,
  exists,
  findClones,
  githubUrl,
  hasRemote,
  isGitRepo,
  isRemoteUrl,
  normalizeRemote,
  pull,
} from './git'

export const builtinKey = 'builtin:starter'

type Row = typeof skillSources.$inferSelect

function nameFromUrl(url: string) {
  return normalizeRemote(url).split('/').slice(-2).join('/')
}

export function parseSourceInput(input: string): { kind: SourceKind; key: string; name: string } {
  const value = input.trim()
  if (value.startsWith('/') || value.startsWith('~')) {
    const path = resolve(value.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'))
    return { kind: 'local', key: path, name: basename(path) }
  }
  if (isRemoteUrl(value) || /^[\w.-]+\/[\w.-]+$/.test(value)) {
    const url = githubUrl(value)
    return { kind: 'git', key: url, name: nameFromUrl(url) }
  }
  throw new Error('Enter a git URL, owner/name, or an absolute folder path')
}

async function describe(row: Row): Promise<SkillSource> {
  const parsedManifest = row.manifestJson
    ? manifestSchema.safeParse(JSON.parse(row.manifestJson))
    : null
  const manifest = parsedManifest?.success ? parsedManifest.data : null
  const identities = row.localPath ? await listIdentities(row.localPath, manifest) : []
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    urlOrPath: row.urlOrPath,
    localPath: row.localPath,
    manifest,
    manifestError:
      parsedManifest && !parsedManifest.success ? 'prism-source.json is invalid' : null,
    identity: row.identity,
    identities,
    needsSetup: Boolean(manifest?.setup?.length) && row.setupAt === null,
    lastSyncedAt: row.lastSyncedAt,
  }
}

function getRow(ctx: Ctx, id: number) {
  const row = ctx.db.select().from(skillSources).where(eq(skillSources.id, id)).get()
  if (!row) throw new Error(`Skill source ${id} not found`)
  return row
}

export async function getSource(ctx: Ctx, id: number) {
  return describe(getRow(ctx, id))
}

export async function listSources(ctx: Ctx) {
  return Promise.all(ctx.db.select().from(skillSources).all().map(describe))
}

export function defaultInstallPath(ctx: Ctx, name: string) {
  return join(ctx.userData, 'sources', name.replaceAll('/', '-'))
}

export async function locateSource(ctx: Ctx, input: string) {
  const parsed = parseSourceInput(input)
  const existing = ctx.db
    .select()
    .from(skillSources)
    .where(eq(skillSources.urlOrPath, parsed.key))
    .get()
  const candidates: string[] = []
  if (parsed.kind === 'local') {
    if (await exists(parsed.key)) candidates.push(parsed.key)
  } else {
    const configured = existing?.localPath
    if (configured && (await isGitRepo(configured)) && (await hasRemote(configured, parsed.key))) {
      candidates.push(configured)
    }
    const installed = defaultInstallPath(ctx, parsed.name)
    if (
      !candidates.includes(installed) &&
      (await isGitRepo(installed)) &&
      (await hasRemote(installed, parsed.key))
    ) {
      candidates.push(installed)
    }
    for (const dir of await findClones(parsed.key))
      if (!candidates.includes(dir)) candidates.push(dir)
  }
  return {
    kind: parsed.kind,
    key: parsed.key,
    name: parsed.name,
    candidates,
    defaultInstallPath: defaultInstallPath(ctx, parsed.name),
    existingId: existing?.id ?? null,
  }
}

async function upsert(
  ctx: Ctx,
  values: { kind: SourceKind; key: string; name: string; localPath: string },
) {
  const { manifest, error } = await readManifest(values.localPath)
  if (error) throw new Error(`prism-source.json: ${error}`)
  const identity = await currentIdentity(values.localPath, manifest)
  const fields = {
    kind: values.kind,
    name: manifest?.name ?? values.name,
    localPath: values.localPath,
    manifestJson: manifest ? JSON.stringify(manifest) : null,
    lastSyncedAt: Date.now(),
  }
  const existing = ctx.db
    .select()
    .from(skillSources)
    .where(eq(skillSources.urlOrPath, values.key))
    .get()
  if (existing) {
    ctx.db
      .update(skillSources)
      .set({ ...fields, identity: existing.identity ?? identity })
      .where(eq(skillSources.id, existing.id))
      .run()
    return getSource(ctx, existing.id)
  }
  const row = ctx.db
    .insert(skillSources)
    .values({ ...fields, urlOrPath: values.key, identity })
    .returning()
    .get()
  return describe(row)
}

export async function addSource(ctx: Ctx, input: string, localPath: string) {
  const parsed = parseSourceInput(input)
  const path = resolve(localPath)
  if (!(await exists(path))) throw new Error(`${path} does not exist`)
  if (parsed.kind === 'git' && !(await hasRemote(path, parsed.key))) {
    throw new Error(`${path} is not a clone of ${parsed.key}`)
  }
  return upsert(ctx, { kind: parsed.kind, key: parsed.key, name: parsed.name, localPath: path })
}

export async function installSource(ctx: Ctx, input: string, dest: string) {
  const parsed = parseSourceInput(input)
  if (parsed.kind !== 'git') throw new Error('Only git sources can be installed')
  const path = resolve(dest)
  if (await exists(path)) throw new Error(`${path} already exists`)
  await mkdir(dirname(path), { recursive: true })
  await cloneRepo(parsed.key, path)
  return upsert(ctx, { kind: 'git', key: parsed.key, name: parsed.name, localPath: path })
}

export async function ensureBuiltinSource(ctx: Ctx) {
  return upsert(ctx, {
    kind: 'builtin',
    key: builtinKey,
    name: 'Built-in starter',
    localPath: ctx.builtinSkillsDir,
  })
}

export async function bootstrapSource(ctx: Ctx, id: number) {
  const source = await getSource(ctx, id)
  if (!source.localPath) throw new Error('Source has no local folder')
  const commands = source.manifest?.setup ?? []
  let output = ''
  const log = (chunk: string) => {
    output += chunk
    ctx.log(id, chunk)
  }
  for (const command of commands) {
    log(`$ ${command}\n`)
    const code = await runStreaming(command, { cwd: source.localPath, onData: log })
    if (code !== 0) {
      log(`\nExited with code ${code}\n`)
      return { ok: false, output }
    }
  }
  if (source.manifest?.health) {
    log(`$ ${source.manifest.health}\n`)
    const code = await runStreaming(source.manifest.health, {
      cwd: source.localPath,
      onData: log,
    })
    if (code !== 0) {
      log(`\nHealth check failed with code ${code}\n`)
      return { ok: false, output }
    }
  }
  ctx.db.update(skillSources).set({ setupAt: Date.now() }).where(eq(skillSources.id, id)).run()
  log('\nReady.\n')
  return { ok: true, output }
}

export async function setIdentity(ctx: Ctx, id: number, identity: string | null) {
  ctx.db.update(skillSources).set({ identity }).where(eq(skillSources.id, id)).run()
  return getSource(ctx, id)
}

export async function scanSourceSkills(ctx: Ctx, id: number) {
  const source = await getSource(ctx, id)
  if (!source.localPath) return []
  return scanSource(source.localPath, source.manifest, source.identities)
}

export async function syncSource(ctx: Ctx, id: number) {
  const row = getRow(ctx, id)
  if (row.kind !== 'git' || !row.localPath) return { ok: true, output: 'Nothing to sync.' }
  const result = await pull(row.localPath)
  if (result.ok) {
    const { manifest } = await readManifest(row.localPath)
    ctx.db
      .update(skillSources)
      .set({ lastSyncedAt: Date.now(), manifestJson: manifest ? JSON.stringify(manifest) : null })
      .where(eq(skillSources.id, id))
      .run()
  }
  return result
}
