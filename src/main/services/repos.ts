import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { parseRepoInput, type Repo } from '@shared/domain'
import { repos, stageBindings } from '../db/schema'
import type { Ctx } from './context'
import { cloneRepo, exists, findClones, hasRemote, isGitRepo } from './git'
import { viewRepo } from './github'

type Row = typeof repos.$inferSelect

function parseList(json: string) {
  try {
    const value = JSON.parse(json) as unknown
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

const toRepo = (row: Row): Repo => ({
  id: row.id,
  owner: row.owner,
  name: row.name,
  localPath: row.localPath,
  worktreeRoot: row.worktreeRoot,
  skillSourceId: row.skillSourceId,
  autoRun: row.autoRun,
  ignoredChecks: parseList(row.ignoredChecksJson),
  qaLabels: parseList(row.qaLabelsJson),
})

function getRow(ctx: Ctx, id: number) {
  const row = ctx.db.select().from(repos).where(eq(repos.id, id)).get()
  if (!row) throw new Error(`Repository ${id} not found`)
  return row
}

const remoteOf = (row: Row) => `github.com/${row.owner}/${row.name}`

export function listRepos(ctx: Ctx) {
  return ctx.db.select().from(repos).all().map(toRepo)
}

export function getRepo(ctx: Ctx, id: number) {
  return toRepo(getRow(ctx, id))
}

export async function addRepo(ctx: Ctx, slug: string) {
  const parsed = parseRepoInput(slug)
  if (!parsed) throw new Error('Enter owner/name or a GitHub URL')
  const info = await viewRepo(parsed)
  const existing = ctx.db
    .select()
    .from(repos)
    .all()
    .find(
      (row) =>
        row.owner.toLowerCase() === info.owner.toLowerCase() &&
        row.name.toLowerCase() === info.name.toLowerCase(),
    )
  if (existing) return toRepo(existing)
  const row = ctx.db
    .insert(repos)
    .values({ owner: info.owner, name: info.name, addedAt: Date.now() })
    .returning()
    .get()
  return toRepo(row)
}

export function removeRepo(ctx: Ctx, id: number) {
  ctx.db.transaction((tx) => {
    tx.delete(stageBindings).where(eq(stageBindings.repoId, id)).run()
    tx.delete(repos).where(eq(repos.id, id)).run()
  })
}

export function defaultWorktreeRoot(localPath: string) {
  return join(dirname(localPath), `${basename(localPath)}-worktrees`)
}

export async function locateRepo(ctx: Ctx, id: number) {
  const row = getRow(ctx, id)
  const candidates = await findClones(remoteOf(row))
  return {
    candidates,
    suggestedClonePath: join(homedir(), 'code', row.name),
  }
}

function update(ctx: Ctx, id: number, values: Partial<Omit<Row, 'id'>>) {
  return toRepo(ctx.db.update(repos).set(values).where(eq(repos.id, id)).returning().get()!)
}

export async function setRepoPath(ctx: Ctx, id: number, localPath: string) {
  const row = getRow(ctx, id)
  const path = resolve(localPath)
  if (!(await isGitRepo(path))) throw new Error(`${path} is not a git repository`)
  if (!(await hasRemote(path, remoteOf(row)))) {
    throw new Error(`${path} has no remote pointing to ${row.owner}/${row.name}`)
  }
  return update(ctx, id, {
    localPath: path,
    worktreeRoot: row.worktreeRoot ?? defaultWorktreeRoot(path),
  })
}

export async function cloneRepoTo(ctx: Ctx, id: number, dest: string) {
  const row = getRow(ctx, id)
  const path = resolve(dest)
  if (await exists(path)) throw new Error(`${path} already exists`)
  await mkdir(dirname(path), { recursive: true })
  const info = await viewRepo(`${row.owner}/${row.name}`)
  await cloneRepo(info.sshUrl, path).catch(() => cloneRepo(info.url, path))
  return setRepoPath(ctx, id, path)
}

export function setWorktreeRoot(ctx: Ctx, id: number, path: string) {
  getRow(ctx, id)
  return update(ctx, id, { worktreeRoot: resolve(path) })
}

export function setRepoSource(ctx: Ctx, id: number, sourceId: number | null) {
  getRow(ctx, id)
  return update(ctx, id, { skillSourceId: sourceId })
}

export function setRepoOptions(
  ctx: Ctx,
  id: number,
  options: { autoRun: boolean; ignoredChecks: string[]; qaLabels: string[] },
) {
  getRow(ctx, id)
  const clean = (list: string[]) => [...new Set(list.map((item) => item.trim()).filter(Boolean))]
  return update(ctx, id, {
    autoRun: options.autoRun,
    ignoredChecksJson: JSON.stringify(clean(options.ignoredChecks)),
    qaLabelsJson: JSON.stringify(clean(options.qaLabels)),
  })
}
