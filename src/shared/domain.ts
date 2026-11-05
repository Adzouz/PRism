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
