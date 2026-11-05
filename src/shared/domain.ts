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
}

export const boardColumns: Record<BoardTab, BoardColumn[]> = {
  reviews: [
    { stage: 'to-review', label: 'To review', needsMe: true },
    { stage: 'reviewing', label: 'Reviewing', agent: true },
    { stage: 'verdict-ready', label: 'Verdict ready', needsMe: true, agent: true },
    { stage: 'waiting-on-author', label: 'Waiting on author' },
    { stage: 're-review', label: 'Re-review', needsMe: true },
    { stage: 'approved', label: 'Approved' },
    { stage: 'done', label: 'Done' },
  ],
  mine: [
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
})
export type BoardPr = z.infer<typeof boardPr>

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
