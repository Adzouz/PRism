import { integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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

export const prs = sqliteTable(
  'prs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull().unique(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    author: text('author').notNull(),
    authorAvatar: text('author_avatar'),
    isDraft: integer('is_draft', { mode: 'boolean' }).notNull(),
    state: text('state', { enum: ['OPEN', 'CLOSED', 'MERGED'] }).notNull(),
    headRef: text('head_ref').notNull(),
    headOid: text('head_oid').notNull(),
    baseRef: text('base_ref').notNull(),
    baseOid: text('base_oid').notNull(),
    reviewDecision: text('review_decision'),
    ciState: text('ci_state', { enum: ['success', 'failure', 'pending', 'none'] }).notNull(),
    labelsJson: text('labels_json').notNull().default('[]'),
    additions: integer('additions').notNull(),
    deletions: integer('deletions').notNull(),
    changedFiles: integer('changed_files').notNull(),
    unresolvedThreads: integer('unresolved_threads').notNull().default(0),
    reviewRequested: integer('review_requested', { mode: 'boolean' }).notNull(),
    requestedTeam: text('requested_team'),
    myReviewState: text('my_review_state'),
    myReviewOid: text('my_review_oid'),
    myReviewAt: integer('my_review_at'),
    myRole: text('my_role', { enum: ['reviewer', 'author', 'takeover'] }).notNull(),
    derivedStage: text('derived_stage').notNull(),
    stageSince: integer('stage_since').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    closedAt: integer('closed_at'),
    syncedAt: integer('synced_at').notNull(),
  },
  (t) => [uniqueIndex('prs_repo_number').on(t.repoId, t.number)],
)

export const prFlags = sqliteTable('pr_flags', {
  prId: integer('pr_id')
    .primaryKey()
    .references(() => prs.id, { onDelete: 'cascade' }),
  starred: integer('starred', { mode: 'boolean' }).notNull().default(false),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  archivedAt: integer('archived_at'),
  manualStage: text('manual_stage'),
  manualStageBasis: text('manual_stage_basis'),
})

export const snapshots = sqliteTable(
  'snapshots',
  {
    repoId: integer('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    openPrs: integer('open_prs').notNull(),
    openIssues: integer('open_issues').notNull(),
    awaitingMe: integer('awaiting_me').notNull(),
    myOpen: integer('my_open').notNull(),
    opened: integer('opened').notNull(),
    merged: integer('merged').notNull(),
    closed: integer('closed').notNull(),
    latencyMedianS: integer('latency_median_s'),
    takenAt: integer('taken_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.day] })],
)
