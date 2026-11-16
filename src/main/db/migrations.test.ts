import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from './client'
import { prFlags, prs, repos } from './schema'

const migrations = resolve(__dirname, '../../../drizzle')

function migrationsUpTo(dir: string, tag: string) {
  const folder = join(dir, 'drizzle')
  cpSync(migrations, folder, { recursive: true })
  const journalPath = join(folder, 'meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  const last = journal.entries.findIndex((entry: { tag: string }) => entry.tag === tag)
  journal.entries = journal.entries.slice(0, last + 1)
  writeFileSync(journalPath, JSON.stringify(journal))
  return folder
}

const columns = {
  repo_id: 'repoId',
  node_id: 'nodeId',
  number: 'number',
  title: 'title',
  url: 'url',
  author: 'author',
  is_draft: 'isDraft',
  state: 'state',
  head_ref: 'headRef',
  head_oid: 'headOid',
  base_ref: 'baseRef',
  base_oid: 'baseOid',
  ci_state: 'ciState',
  additions: 'additions',
  deletions: 'deletions',
  changed_files: 'changedFiles',
  review_requested: 'reviewRequested',
  my_role: 'myRole',
  derived_stage: 'derivedStage',
  stage_since: 'stageSince',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  synced_at: 'syncedAt',
} as const

describe('migration 0011_waiting_review', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('moves to-review stages to waiting-review on my pull requests only', () => {
    dir = mkdtempSync(join(tmpdir(), 'prism-migrations-'))
    const file = join(dir, 'prism.db')
    const before = openDb(file, migrationsUpTo(dir, '0010_strong_rachel_grey'))
    const [repo] = before
      .insert(repos)
      .values({ owner: 'acme', name: 'widgets', addedAt: 0 })
      .returning()
      .all()
    const roles = ['reviewer', 'author', 'takeover'] as const
    const rows = roles.flatMap((myRole, index) =>
      ['to-review', 'changes-requested'].map((derivedStage, offset) => ({
        repoId: repo!.id,
        nodeId: `PR_${index}_${offset}`,
        number: index * 10 + offset + 1,
        title: 'Add widgets',
        url: 'https://github.com/acme/widgets/pull/1',
        author: 'octocat',
        isDraft: false,
        state: 'OPEN' as const,
        headRef: 'feature',
        headOid: 'a'.repeat(40),
        baseRef: 'main',
        baseOid: 'b'.repeat(40),
        ciState: 'none' as const,
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        reviewRequested: false,
        myRole,
        derivedStage,
        stageSince: 0,
        createdAt: 0,
        updatedAt: 0,
        syncedAt: 0,
      })),
    )
    const raw = new Database(file)
    const insertPr = raw.prepare(
      `INSERT INTO prs (${Object.keys(columns).join(', ')}) VALUES (${Object.keys(columns)
        .map((key) => `@${key}`)
        .join(', ')}) RETURNING id, derived_stage AS derivedStage`,
    )
    const inserted = rows.map(
      (row) =>
        insertPr.get(
          Object.fromEntries(
            Object.entries(columns).map(([key, field]) => {
              const value = row[field]
              return [key, typeof value === 'boolean' ? Number(value) : value]
            }),
          ),
        ) as { id: number; derivedStage: string },
    )
    raw.close()
    before
      .insert(prFlags)
      .values(inserted.map((pr) => ({ prId: pr.id, manualStage: pr.derivedStage })))
      .run()

    const after = openDb(file, migrations)
    const stages = after
      .select({ role: prs.myRole, derived: prs.derivedStage, manual: prFlags.manualStage })
      .from(prs)
      .innerJoin(prFlags, eq(prFlags.prId, prs.id))
      .all()

    expect(
      stages.toSorted((a, b) => a.role.localeCompare(b.role) || a.derived.localeCompare(b.derived)),
    ).toEqual([
      { role: 'author', derived: 'changes-requested', manual: 'changes-requested' },
      { role: 'author', derived: 'waiting-review', manual: 'waiting-review' },
      { role: 'reviewer', derived: 'changes-requested', manual: 'changes-requested' },
      { role: 'reviewer', derived: 'to-review', manual: 'to-review' },
      { role: 'takeover', derived: 'changes-requested', manual: 'changes-requested' },
      { role: 'takeover', derived: 'waiting-review', manual: 'waiting-review' },
    ])
  })
})
