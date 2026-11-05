import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
})

export const skillSources = sqliteTable('skill_sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['git', 'local', 'builtin'] }).notNull(),
  name: text('name').notNull(),
  urlOrPath: text('url_or_path').notNull().unique(),
  localPath: text('local_path'),
  manifestJson: text('manifest_json'),
  identity: text('identity'),
  setupAt: integer('setup_at'),
  lastSyncedAt: integer('last_synced_at'),
})

export const repos = sqliteTable(
  'repos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    localPath: text('local_path'),
    worktreeRoot: text('worktree_root'),
    skillSourceId: integer('skill_source_id').references(() => skillSources.id, {
      onDelete: 'set null',
    }),
    autoRun: integer('auto_run', { mode: 'boolean' }).notNull().default(false),
    ignoredChecksJson: text('ignored_checks_json').notNull().default('[]'),
    qaLabelsJson: text('qa_labels_json').notNull().default('[]'),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [uniqueIndex('repos_owner_name').on(t.owner, t.name)],
)

export const skills = sqliteTable('skills', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: integer('source_id').references(() => skillSources.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  description: text('description').notNull(),
  mode: text('mode', { enum: ['copy', 'link', 'custom', 'linked_file'] }).notNull(),
  path: text('path').notNull(),
  contentHash: text('content_hash').notNull(),
})

export const stageBindings = sqliteTable(
  'stage_bindings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scope: text('scope', { enum: ['global', 'repo'] }).notNull(),
    repoId: integer('repo_id').notNull().default(0),
    stage: text('stage').notNull(),
    skillId: integer('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    validatedAt: integer('validated_at'),
  },
  (t) => [uniqueIndex('stage_bindings_scope').on(t.repoId, t.stage)],
)
