import { z } from 'zod'

export const stages = ['review', 're-review', 'test-plan', 'address', 'draft-replies'] as const
export const stage = z.enum(stages)
export type Stage = z.infer<typeof stage>

export const stageLabels: Record<Stage, string> = {
  review: 'Review',
  're-review': 'Re-review',
  'test-plan': 'Test plan',
  address: 'Address comments',
  'draft-replies': 'Draft replies',
}

export const agentIds = ['claude', 'codex', 'gemini', 'cursor-agent'] as const
export const agentId = z.enum(agentIds)
export type AgentId = z.infer<typeof agentId>

export const githubStatus = z.object({
  installed: z.boolean(),
  loggedIn: z.boolean(),
  login: z.string().nullable(),
  scopes: z.array(z.string()),
  missingScopes: z.array(z.string()),
  error: z.string().nullable(),
})
export type GithubStatus = z.infer<typeof githubStatus>

export const agentStatus = z.object({
  id: agentId,
  installed: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  loggedIn: z.boolean().nullable(),
  detail: z.string().nullable(),
})
export type AgentStatus = z.infer<typeof agentStatus>

export const agentConfig = z.object({ agent: agentId, model: z.string() })
export type AgentConfig = z.infer<typeof agentConfig>

export function parseRepoInput(value: string): string | null {
  const text = value.trim()
  const match =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(
      text,
    ) ??
    /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(text) ??
    /^([\w.-]+)\/([\w.-]+)$/.exec(text)
  return match ? `${match[1]}/${match[2]}` : null
}

export const githubRepoSummary = z.object({
  fullName: z.string(),
  description: z.string().nullable(),
  private: z.boolean(),
  pushedAt: z.string().nullable(),
})
export type GithubRepoSummary = z.infer<typeof githubRepoSummary>

export const agentNames: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  'cursor-agent': 'Cursor Agent',
}

export const agentCommands: Record<AgentId, { install: string; login: string }> = {
  claude: { install: 'curl -fsSL https://claude.ai/install.sh | bash', login: 'claude auth login' },
  codex: { install: 'npm install -g @openai/codex', login: 'codex login' },
  gemini: { install: 'npm install -g @google/gemini-cli', login: 'gemini' },
  'cursor-agent': {
    install: 'curl https://cursor.com/install -fsS | bash',
    login: 'cursor-agent login',
  },
}

export const agentModels: Partial<Record<AgentId, { id: string; label: string }[]>> = {
  claude: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  ],
}

export const postMode = z.enum(['submit', 'draft'])
export type PostMode = z.infer<typeof postMode>

export const postModeLabels: Record<PostMode, string> = {
  submit: 'Submit now',
  draft: 'Stage as pending draft',
}

export const repo = z.object({
  id: z.number(),
  owner: z.string(),
  name: z.string(),
  localPath: z.string().nullable(),
  worktreeRoot: z.string().nullable(),
  skillSourceId: z.number().nullable(),
  autoRun: z.boolean(),
  ignoredChecks: z.array(z.string()),
  qaLabels: z.array(z.string()),
  postMode: postMode.nullable(),
})
export type Repo = z.infer<typeof repo>

export const repoOptions = z.object({
  autoRun: z.boolean(),
  ignoredChecks: z.array(z.string()),
  qaLabels: z.array(z.string()),
})

export const manifest = z.object({
  name: z.string().optional(),
  setup: z.array(z.string()).optional(),
  health: z.string().optional(),
  identities: z
    .object({
      list: z.string(),
      current: z.object({ file: z.string(), jsonPath: z.string() }).optional(),
    })
    .optional(),
  skillRoots: z.array(z.string()).optional(),
  import: z.string().optional(),
  stageHints: z.partialRecord(stage, z.array(z.string())).optional(),
})
export type Manifest = z.infer<typeof manifest>

export const sourceKind = z.enum(['git', 'local', 'builtin'])
export type SourceKind = z.infer<typeof sourceKind>

export const skillSource = z.object({
  id: z.number(),
  kind: sourceKind,
  name: z.string(),
  urlOrPath: z.string(),
  localPath: z.string().nullable(),
  manifest: manifest.nullable(),
  manifestError: z.string().nullable(),
  identity: z.string().nullable(),
  identities: z.array(z.string()),
  needsSetup: z.boolean(),
  lastSyncedAt: z.number().nullable(),
})
export type SkillSource = z.infer<typeof skillSource>

export const skillMode = z.enum(['copy', 'link', 'custom', 'linked_file'])
export type SkillMode = z.infer<typeof skillMode>

export const skill = z.object({
  id: z.number(),
  sourceId: z.number().nullable(),
  name: z.string(),
  description: z.string(),
  mode: skillMode,
  path: z.string(),
  contentHash: z.string(),
})
export type Skill = z.infer<typeof skill>

export const scannedSkill = z.object({
  name: z.string(),
  description: z.string(),
  dir: z.string(),
  relDir: z.string(),
  identity: z.string().nullable(),
})
export type ScannedSkill = z.infer<typeof scannedSkill>

export const stageBinding = z.object({
  stage,
  repoId: z.number().nullable(),
  skillId: z.number(),
  validatedAt: z.number().nullable(),
})
export type StageBinding = z.infer<typeof stageBinding>

export const effectiveBinding = z.object({
  stage,
  skill: skill.nullable(),
  sourceName: z.string().nullable(),
  inherited: z.boolean(),
  validated: z.boolean(),
})
export type EffectiveBinding = z.infer<typeof effectiveBinding>

export const configIssue = z.object({
  key: z.string(),
  message: z.string(),
  repoId: z.number().nullable(),
})

export const configStatus = z.object({
  valid: z.boolean(),
  onboarded: z.boolean(),
  issues: z.array(configIssue),
})
export type ConfigStatus = z.infer<typeof configStatus>

export const proposal = z.object({
  stage,
  skillName: z.string().nullable(),
  sourceId: z.number().nullable(),
  relDir: z.string().nullable(),
  reason: z.enum(['hint', 'match', 'builtin', 'none']),
})
export type Proposal = z.infer<typeof proposal>

export const commandResult = z.object({ ok: z.boolean(), output: z.string() })

export const boardTabs = ['reviews', 'mine'] as const
export const boardTab = z.enum(boardTabs)
export type BoardTab = z.infer<typeof boardTab>

export const boardStages = [
  'needs-you',
  'to-review',
  'reviewing',
  'verdict-ready',
  'waiting-on-author',
  're-review',
  'draft',
  'waiting-for-review',
  'changes-requested',
  'addressing',
  'ready-to-post',
  'approved',
  'done',
] as const
export const boardStage = z.enum(boardStages)
export type BoardStage = z.infer<typeof boardStage>

export type BoardColumn = {
  stage: BoardStage
  label: string
  needsMe?: boolean
  agent?: boolean
  hideEmpty?: boolean
}

const needsYouColumn: BoardColumn = {
  stage: 'needs-you',
  label: 'Needs you',
  needsMe: true,
  agent: true,
  hideEmpty: true,
}

export const boardColumns: Record<BoardTab, BoardColumn[]> = {
  reviews: [
    needsYouColumn,
    { stage: 'to-review', label: 'To review', needsMe: true },
    { stage: 'reviewing', label: 'Reviewing', agent: true },
    { stage: 'verdict-ready', label: 'Verdict ready', needsMe: true, agent: true },
    { stage: 'waiting-on-author', label: 'Waiting on author' },
    { stage: 're-review', label: 'Re-review', needsMe: true },
    { stage: 'approved', label: 'Approved' },
    { stage: 'done', label: 'Done' },
  ],
  mine: [
    needsYouColumn,
    { stage: 'draft', label: 'Draft' },
    { stage: 'waiting-for-review', label: 'Waiting for review' },
    { stage: 'changes-requested', label: 'Changes requested', needsMe: true },
    { stage: 'addressing', label: 'Addressing', agent: true },
    { stage: 'ready-to-post', label: 'Ready to post', needsMe: true, agent: true },
    { stage: 'approved', label: 'Approved' },
    { stage: 'done', label: 'Done' },
  ],
}

export const prRole = z.enum(['reviewer', 'author', 'takeover'])
export type PrRole = z.infer<typeof prRole>

export const ciState = z.enum(['success', 'failure', 'pending', 'none'])
export type CiState = z.infer<typeof ciState>

export const prLabel = z.object({ name: z.string(), color: z.string() })
export type PrLabel = z.infer<typeof prLabel>

export const runStatuses = [
  'queued',
  'preparing',
  'running',
  'needs_you',
  'done',
  'failed',
  'cancelled',
] as const
export const runStatus = z.enum(runStatuses)
export type RunStatus = z.infer<typeof runStatus>

export const activeRunStatuses: readonly RunStatus[] = [
  'queued',
  'preparing',
  'running',
  'needs_you',
]

export const askOptions = z.object({
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
})

export const ask = z.object({
  id: z.number(),
  runId: z.number(),
  prompt: z.string(),
  options: z.array(z.string()),
  placeholder: z.string().nullable(),
  answer: z.string().nullable(),
  createdAt: z.number(),
  answeredAt: z.number().nullable(),
})
export type Ask = z.infer<typeof ask>

export const severity = z.enum(['blocking', 'nit', 'refactor'])
export const nitDecision = z.enum(['address', 'followup', 'skip'])
export const findingSide = z.enum(['LEFT', 'RIGHT'])
export const findingStatus = z.enum(['open', 'resolved', 'still_open', 'disputed', 'obsolete'])
export const verdict = z.enum(['approve', 'comment', 'request_changes'])

export const reportedFinding = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().nullable(),
  side: findingSide.default('RIGHT'),
  severity,
  nitDecision: nitDecision.optional(),
  title: z.string().min(1),
  body: z.string(),
  suggestion: z.string().optional(),
  priorFindingId: z.number().int().optional(),
})

export const dimensionScan = z.object({
  dimension: z.string(),
  status: z.enum(['clean', 'issues', 'skipped']),
  note: z.string().optional(),
})

export const reviewReport = z.object({
  verdict,
  summary: z.string(),
  dimensions: z.array(dimensionScan).default([]),
})
export type ReviewReport = z.infer<typeof reviewReport>

export const threadChange = z.object({
  threadId: z.string(),
  action: z.enum(['fix', 'push_back', 'defer']),
  note: z.string().optional(),
})

export const changesReport = z.object({
  threads: z.array(threadChange),
  filesTouched: z.array(z.string()).default([]),
  checks: z
    .array(z.object({ command: z.string(), ok: z.boolean(), note: z.string().optional() }))
    .default([]),
  summary: z.string().optional(),
})
export type ChangesReport = z.infer<typeof changesReport>

export const draftReply = z.object({ threadId: z.string(), body: z.string() })
export type DraftReply = z.infer<typeof draftReply>

export const finding = z.object({
  id: z.number(),
  runId: z.number(),
  path: z.string(),
  line: z.number().nullable(),
  side: findingSide,
  severity,
  nitDecision: nitDecision.nullable(),
  title: z.string(),
  body: z.string(),
  suggestion: z.string().nullable(),
  status: findingStatus,
  included: z.boolean(),
  editedBody: z.string().nullable(),
  posted: z.boolean(),
})
export type Finding = z.infer<typeof finding>

export const findingPatch = z.object({
  id: z.number().int().positive(),
  included: z.boolean().optional(),
  editedBody: z.string().nullable().optional(),
})
export type FindingPatch = z.infer<typeof findingPatch>

export const run = z.object({
  id: z.number(),
  prId: z.number(),
  stage,
  skillName: z.string().nullable(),
  agent: agentId,
  model: z.string(),
  status: runStatus,
  progress: z.string().nullable(),
  sessionId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  reviewedHeadOid: z.string().nullable(),
  report: reviewReport.nullable(),
  changes: changesReport.nullable(),
  replies: z.array(draftReply),
  threadIds: z.array(z.string()),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  dismissedAt: z.number().nullable(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  costUsd: z.number(),
  error: z.string().nullable(),
  ask: ask.nullable(),
})
export type Run = z.infer<typeof run>

export const runEventKinds = [
  'status',
  'message',
  'text',
  'tool',
  'tool_result',
  'progress',
  'ask',
  'answer',
  'denied',
  'error',
  'result',
  'note',
] as const
export const runEventKind = z.enum(runEventKinds)
export type RunEventKind = z.infer<typeof runEventKind>

export const runEvent = z.object({
  id: z.number(),
  runId: z.number(),
  ts: z.number(),
  kind: runEventKind,
  payload: z.record(z.string(), z.unknown()),
})
export type RunEvent = z.infer<typeof runEvent>

export const threadComment = z.object({
  id: z.string(),
  author: z.string(),
  avatar: z.string().nullable(),
  body: z.string(),
  createdAt: z.number(),
  url: z.string(),
})

export const reviewThread = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number().nullable(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  comments: z.array(threadComment),
  totalComments: z.number(),
})
export type ReviewThread = z.infer<typeof reviewThread>

export const threadStages: readonly Stage[] = ['address', 'draft-replies']

export const runStagesByTab: Record<BoardTab, Stage[]> = {
  reviews: ['review', 're-review', 'draft-replies', 'test-plan'],
  mine: ['address', 'draft-replies', 'test-plan', 'review'],
}

export const appChoice = z.object({ id: z.string(), name: z.string() })
export type AppChoice = z.infer<typeof appChoice>

export const appPreferences = z.object({
  editor: z.string().nullable(),
  terminal: z.string().nullable(),
})
export type AppPreferences = z.infer<typeof appPreferences>

export const installedApps = z.object({
  editors: z.array(appChoice),
  terminals: z.array(appChoice),
  preferred: appPreferences,
})
export type InstalledApps = z.infer<typeof installedApps>

export const boardRun = z.object({
  id: z.number(),
  stage,
  status: runStatus,
  progress: z.string().nullable(),
  error: z.string().nullable(),
  verdict: verdict.nullable(),
  findings: z.number(),
  ask: ask.nullable(),
  stale: z.boolean(),
  gateClosed: z.boolean(),
})
export type BoardRun = z.infer<typeof boardRun>

export const boardPr = z.object({
  id: z.number(),
  repoId: z.number(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  authorAvatar: z.string().nullable(),
  isDraft: z.boolean(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  ciState,
  labels: z.array(prLabel),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  unresolvedThreads: z.number(),
  reviewRequested: z.boolean(),
  requestedTeam: z.string().nullable(),
  myReviewState: z.string().nullable(),
  role: prRole,
  tab: boardTab,
  derivedStage: boardStage,
  stage: boardStage,
  manual: z.boolean(),
  stageSince: z.number(),
  updatedAt: z.number(),
  closedAt: z.number().nullable(),
  starred: z.boolean(),
  hidden: z.boolean(),
  archivedAt: z.number().nullable(),
  run: boardRun.nullable(),
})
export type BoardPr = z.infer<typeof boardPr>

export function runStageFor(
  pr: Pick<BoardPr, 'tab' | 'derivedStage' | 'myReviewState' | 'run'>,
): Stage {
  if (pr.tab === 'mine') return 'address'
  const reviewed =
    pr.run?.status === 'done' && (pr.run.stage === 'review' || pr.run.stage === 're-review')
  return pr.derivedStage === 're-review' || pr.myReviewState || reviewed ? 're-review' : 'review'
}

export const checkState = z.enum(['success', 'failure', 'pending', 'neutral', 'skipped'])
export type CheckState = z.infer<typeof checkState>

export const prDetail = z.object({
  id: z.number(),
  bodyHtml: z.string(),
  headRef: z.string(),
  baseRef: z.string(),
  headOwner: z.string().nullable(),
  commits: z.number(),
  createdAt: z.number(),
  mergeable: z.string().nullable(),
  labels: z.array(prLabel),
  linkedIssues: z.array(
    z.object({ number: z.number(), title: z.string(), url: z.string(), state: z.string() }),
  ),
  reviewers: z.array(
    z.object({
      name: z.string(),
      avatar: z.string().nullable(),
      kind: z.enum(['user', 'team']),
      state: z.string(),
    }),
  ),
  checks: z.array(
    z.object({
      name: z.string(),
      state: checkState,
      url: z.string().nullable(),
      ignored: z.boolean(),
    }),
  ),
  ciState,
})
export type PrDetail = z.infer<typeof prDetail>

export const repoSyncState = z.object({
  repoId: z.number(),
  repo: z.string(),
  state: z.enum(['idle', 'syncing', 'done', 'skipped', 'error']),
  error: z.string().nullable(),
  reviews: z.number(),
  mine: z.number(),
})

export const syncStatus = z.object({
  running: z.boolean(),
  lastSyncAt: z.number().nullable(),
  lastError: z.string().nullable(),
  rate: z.object({ limit: z.number(), remaining: z.number(), resetAt: z.number() }).nullable(),
  repos: z.array(repoSyncState),
})
export type SyncStatus = z.infer<typeof syncStatus>

export const boardSettings = z.object({ autoArchiveDone: z.boolean() })
export type BoardSettings = z.infer<typeof boardSettings>

export const gateKind = z.enum(['review', 'address', 'replies'])
export type GateKind = z.infer<typeof gateKind>

export const gateKindOf: Partial<Record<Stage, GateKind>> = {
  review: 'review',
  're-review': 'review',
  address: 'address',
  'draft-replies': 'replies',
}

export const gateCheckKey = z.enum([
  'findings',
  'event',
  'mode',
  'threads',
  'commit',
  'push',
  'replies',
])
export type GateCheckKey = z.infer<typeof gateCheckKey>

export const gateCheck = z.object({
  key: gateCheckKey,
  label: z.string(),
  ok: z.boolean(),
  detail: z.string().nullable(),
})
export type GateCheck = z.infer<typeof gateCheck>

export const gateReply = z.object({
  threadId: z.string(),
  body: z.string(),
  selected: z.boolean(),
  postedUrl: z.string().nullable(),
})
export type GateReply = z.infer<typeof gateReply>

export const gateWorktree = z.object({
  path: z.string(),
  dirty: z.array(z.string()),
  localHead: z.string().nullable(),
  checkoutHead: z.string().nullable(),
  remoteHead: z.string().nullable(),
  branch: z.string().nullable(),
})
export type GateWorktree = z.infer<typeof gateWorktree>

export const postGate = z.object({
  runId: z.number(),
  prId: z.number(),
  kind: gateKind,
  mode: postMode,
  modeFromRepo: z.boolean(),
  event: verdict,
  allowedEvents: z.array(verdict),
  body: z.string(),
  findings: z.object({
    included: z.number(),
    total: z.number(),
    outsideDiff: z.number(),
  }),
  pendingReview: z.boolean(),
  commitMessage: z.string(),
  worktree: gateWorktree.nullable(),
  replies: z.array(gateReply),
  checks: z.array(gateCheck),
  ready: z.boolean(),
  live: z.boolean(),
  confirmedAt: z.number().nullable(),
  postedAt: z.number().nullable(),
  skippedAt: z.number().nullable(),
  reviewUrl: z.string().nullable(),
  warning: z.string().nullable(),
})
export type PostGate = z.infer<typeof postGate>

export const gatePatch = z.object({
  runId: z.number().int().positive(),
  mode: postMode.optional(),
  event: verdict.optional(),
  body: z.string().optional(),
  commitMessage: z.string().optional(),
  confirmed: z.boolean().optional(),
  replies: z.array(gateReply.pick({ threadId: true, body: true, selected: true })).optional(),
})
export type GatePatch = z.infer<typeof gatePatch>

export const aiTag = '_Drafted with AI in PRism, reviewed and posted by the author._'

export function findingComment(
  item: Pick<Finding, 'severity' | 'title' | 'body' | 'suggestion'>,
): string {
  const title = `${item.severity === 'nit' ? 'Nit: ' : ''}**${item.title.trim()}**`
  const parts = [title, item.body.trim()]
  const suggestion = item.suggestion?.trimEnd()
  if (suggestion?.trim()) {
    const fence = suggestion.includes('```') ? '````' : '```'
    parts.push(`${fence}\n${suggestion}\n${fence}`)
  }
  return parts.filter(Boolean).join('\n\n')
}
