import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

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
    postMode: text('post_mode', { enum: ['submit', 'draft'] }),
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
  restoredAt: integer('restored_at'),
  manualStage: text('manual_stage'),
  manualStageBasis: text('manual_stage_basis'),
  approvedOid: text('approved_oid'),
  approvedAt: integer('approved_at'),
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

export const runs = sqliteTable(
  'runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    prId: integer('pr_id')
      .notNull()
      .references(() => prs.id, { onDelete: 'cascade' }),
    stage: text('stage').notNull(),
    skillId: integer('skill_id').references(() => skills.id, { onDelete: 'set null' }),
    skillName: text('skill_name'),
    agent: text('agent').notNull(),
    model: text('model').notNull(),
    sessionId: text('session_id'),
    worktreePath: text('worktree_path'),
    status: text('status', {
      enum: ['queued', 'preparing', 'running', 'needs_you', 'done', 'failed', 'cancelled'],
    }).notNull(),
    progress: text('progress'),
    reviewedHeadOid: text('reviewed_head_oid'),
    reviewedBaseOid: text('reviewed_base_oid'),
    reportJson: text('report_json'),
    changesJson: text('changes_json'),
    repliesJson: text('replies_json'),
    threadsJson: text('threads_json'),
    pushRemote: text('push_remote'),
    pushRef: text('push_ref'),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    dismissedAt: integer('dismissed_at'),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('runs_pr').on(t.prId), index('runs_status').on(t.status)],
)

export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    ts: integer('ts').notNull(),
    kind: text('kind').notNull(),
    payloadJson: text('payload_json').notNull(),
  },
  (t) => [index('run_events_run').on(t.runId)],
)

export const findings = sqliteTable(
  'findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    prId: integer('pr_id')
      .notNull()
      .references(() => prs.id, { onDelete: 'cascade' }),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    anchorPath: text('anchor_path').notNull(),
    anchorLine: integer('anchor_line'),
    side: text('side', { enum: ['LEFT', 'RIGHT'] }).notNull(),
    hunkHash: text('hunk_hash'),
    severity: text('severity', { enum: ['blocking', 'nit', 'refactor'] }).notNull(),
    nitDecision: text('nit_decision', { enum: ['address', 'followup', 'skip'] }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    suggestion: text('suggestion'),
    priorFindingId: integer('prior_finding_id'),
    included: integer('included', { mode: 'boolean' }).notNull().default(true),
    editedBody: text('edited_body'),
    status: text('status', {
      enum: ['open', 'resolved', 'still_open', 'disputed', 'obsolete'],
    })
      .notNull()
      .default('open'),
    ghCommentId: text('gh_comment_id'),
  },
  (t) => [index('findings_run').on(t.runId), index('findings_pr').on(t.prId)],
)

export const asks = sqliteTable(
  'asks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    prompt: text('prompt').notNull(),
    schemaJson: text('schema_json').notNull().default('{}'),
    answerJson: text('answer_json'),
    createdAt: integer('created_at').notNull(),
    answeredAt: integer('answered_at'),
  },
  (t) => [index('asks_run').on(t.runId)],
)

export const postGates = sqliteTable('post_gates', {
  runId: integer('run_id')
    .primaryKey()
    .references(() => runs.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['review', 'address', 'replies'] }).notNull(),
  mode: text('mode', { enum: ['submit', 'draft'] }),
  event: text('event', { enum: ['approve', 'comment', 'request_changes'] }),
  body: text('body'),
  commitMessage: text('commit_message'),
  committedOid: text('committed_oid'),
  pushedOid: text('pushed_oid'),
  repliesJson: text('replies_json'),
  ghReviewId: text('gh_review_id'),
  ghReviewUrl: text('gh_review_url'),
  confirmedAt: integer('confirmed_at'),
  postedAt: integer('posted_at'),
  skippedAt: integer('skipped_at'),
})
