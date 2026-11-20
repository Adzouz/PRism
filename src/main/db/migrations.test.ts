import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from './client'
import { agentUsage, prFlags, prs } from './schema'

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
    const raw = new Database(file)
    const repo = raw
      .prepare(
        `INSERT INTO repos (owner, name, added_at) VALUES ('acme', 'widgets', 0) RETURNING id`,
      )
      .get() as { id: number }
    const roles = ['reviewer', 'author', 'takeover'] as const
    const rows = roles.flatMap((myRole, index) =>
      ['to-review', 'changes-requested'].map((derivedStage, offset) => ({
        repoId: repo.id,
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

describe('migration 0019_agent_usage', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('copies the usage of existing runs into the ledger', () => {
    dir = mkdtempSync(join(tmpdir(), 'prism-migrations-'))
    const file = join(dir, 'prism.db')
    openDb(file, migrationsUpTo(dir, '0018_pr_mergeable'))
    const raw = new Database(file)
    const repo = raw
      .prepare(
        `INSERT INTO repos (owner, name, added_at) VALUES ('acme', 'widgets', 0) RETURNING id`,
      )
      .get() as { id: number }
    const pr = raw
      .prepare(
        `INSERT INTO prs (${Object.keys(columns).join(', ')}) VALUES (${Object.keys(columns)
          .map((key) => `@${key}`)
          .join(', ')}) RETURNING id`,
      )
      .get({
        ...Object.fromEntries(Object.keys(columns).map((key) => [key, 0])),
        repo_id: repo.id,
        node_id: 'PR_1',
        number: 1,
        title: 'Add widgets',
        url: 'https://github.com/acme/widgets/pull/1',
        author: 'octocat',
        state: 'OPEN',
        head_ref: 'feature',
        head_oid: 'a'.repeat(40),
        base_ref: 'main',
        base_oid: 'b'.repeat(40),
        ci_state: 'none',
        my_role: 'reviewer',
        derived_stage: 'to-review',
      }) as { id: number }
    const insertRun = raw.prepare(
      `INSERT INTO runs (pr_id, stage, agent, model, status, created_at, ended_at, tokens_in, tokens_out, cost_usd)
       VALUES (@pr, @stage, 'claude', 'sonnet', 'done', @created, @ended, @tokensIn, @tokensOut, @cost)`,
    )
    insertRun.run({
      pr: pr.id,
      stage: 'review',
      created: 10,
      ended: 20,
      tokensIn: 1000,
      tokensOut: 100,
      cost: 0.5,
    })
    insertRun.run({
      pr: pr.id,
      stage: 'address',
      created: 30,
      ended: null,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
    })
    raw.close()

    const after = openDb(file, migrations)
    expect(after.select().from(agentUsage).all()).toEqual([
      {
        id: 1,
        repoId: repo.id,
        runId: 1,
        stage: 'review',
        model: 'sonnet',
        at: 20,
        tokensIn: 1000,
        tokensOut: 100,
        costUsd: 0.5,
      },
    ])
  })
})
