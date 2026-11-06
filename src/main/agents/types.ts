import type { ChangesReport, DraftReply, Finding, ReviewReport, Stage } from '@shared/domain'
import type { NewFinding } from '../services/runs'

export type PrismTools = {
  reportFindings: (report: ReviewReport, findings: NewFinding[]) => string
  reportPriorStatus: (items: { findingId: number; status: Finding['status'] }[]) => string
  reportChanges: (changes: ChangesReport) => string
  draftReplies: (replies: DraftReply[]) => string
  askUser: (input: { question: string; options?: string[]; placeholder?: string }) => string
  progress: (label: string) => string
  isWaiting: () => boolean
}

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown }
  | { kind: 'tool_result'; id: string; ok: boolean; text: string }
  | { kind: 'denied'; tool: string; reason: string }
  | { kind: 'note'; text: string }

export type SegmentInput = {
  prompt: string
  resume: string | null
  cwd: string
  projectRoot: string | null
  model: string
  stage: Stage
  readOnly: boolean
  systemAppend: string
  extraDirs: string[]
  env: Record<string, string>
  executable: string | null
  tools: PrismTools
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
  onSession: (sessionId: string) => void
}

export type SegmentResult = {
  sessionId: string | null
  tokensIn: number
  tokensOut: number
  costUsd: number
  error: string | null
}

export type SessionTotals = Pick<SegmentResult, 'tokensIn' | 'tokensOut' | 'costUsd'>

export interface AgentAdapter {
  run(input: SegmentInput): Promise<SegmentResult>
}
