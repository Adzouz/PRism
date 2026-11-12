import type {
  CanUseTool,
  HookCallback,
  ModelUsage,
  Options,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  changesReport,
  dimensionScan,
  draftReply,
  findingStatus,
  reportedFinding,
  verdict,
} from '@shared/domain'
import { toolBlockReason } from './guard'
import { redactText } from './redact'
import type { AgentAdapter, AgentEvent, PrismTools, SegmentInput, SegmentResult } from './types'

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')

let sdkModule: Promise<Sdk> | undefined
const loadSdk = () => (sdkModule ??= import('@anthropic-ai/claude-agent-sdk'))

const text = (value: string, isError = false) => ({
  content: [{ type: 'text' as const, text: value }],
  isError,
})

async function guarded(fn: () => string | Promise<string>) {
  try {
    return text(await fn())
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true)
  }
}

export function prismServer(sdk: Sdk, tools: PrismTools) {
  return sdk.createSdkMcpServer({
    name: 'prism',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      sdk.tool(
        'prism_report_findings',
        'Report the review result to PRism: verdict, summary, dimensions checked and every finding. Call once at the end; a second call replaces the first.',
        {
          verdict,
          summary: z.string().describe('Two or three sentences for the user'),
          dimensions: z.array(dimensionScan).default([]),
          findings: z.array(reportedFinding),
        },
        async ({ verdict: value, summary, dimensions, findings }) =>
          guarded(() => tools.reportFindings({ verdict: value, summary, dimensions }, findings)),
      ),
      sdk.tool(
        'prism_report_prior_status',
        'Re-review only: report the current status of each earlier finding by id.',
        {
          items: z.array(z.object({ findingId: z.number().int(), status: findingStatus })),
        },
        async ({ items }) => guarded(() => tools.reportPriorStatus(items)),
      ),
      sdk.tool(
        'prism_report_changes',
        'Address runs: report what you did per review thread, the files you touched and the checks you ran.',
        changesReport.shape,
        async (input) => guarded(() => tools.reportChanges(changesReport.parse(input))),
      ),
      sdk.tool(
        'prism_draft_replies',
        'Draft a reply per review thread. PRism shows them to the user, who decides what to post.',
        { replies: z.array(draftReply) },
        async ({ replies }) => guarded(() => tools.draftReplies(replies)),
      ),
      sdk.tool(
        'prism_ask_user',
        'Ask the user a question and pause. End your turn right after calling this; the answer arrives as the next message.',
        {
          question: z.string().min(1),
          options: z.array(z.string()).optional().describe('Suggested answers, if any'),
          placeholder: z.string().optional(),
        },
        async (input) => guarded(() => tools.askUser(input)),
      ),
      sdk.tool(
        'prism_progress',
        'Show a short live step label (3 to 6 words) on the PRism card.',
        { label: z.string().min(1).max(80) },
        async ({ label }) => guarded(() => tools.progress(label)),
      ),
    ],
  })
}

function truncate(raw: string, max = 4000) {
  const value = redactText(raw)
  return value.length > max
    ? `${value.slice(0, max)}\n… (${value.length - max} more characters)`
    : value
}

const editTools = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

export function usageOf(modelUsage: Record<string, ModelUsage> | undefined) {
  let tokensIn = 0
  let tokensOut = 0
  for (const usage of Object.values(modelUsage ?? {})) {
    tokensIn += usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens
    tokensOut += usage.outputTokens
  }
  return { tokensIn, tokensOut }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block: { type?: string; text?: string }) =>
        block.type === 'text' ? (block.text ?? '') : `[${block.type ?? 'content'}]`,
      )
      .join('\n')
  }
  return ''
}

export function eventsOf(message: SDKMessage): AgentEvent[] {
  if (message.type === 'assistant') {
    return message.message.content.flatMap((block): AgentEvent[] => {
      if (block.type === 'text' && block.text.trim()) return [{ kind: 'text', text: block.text }]
      if (block.type === 'tool_use') {
        return [{ kind: 'tool', id: block.id, name: block.name, input: block.input }]
      }
      return []
    })
  }
  if (message.type === 'user' && Array.isArray(message.message.content)) {
    return message.message.content.flatMap((block): AgentEvent[] =>
      block.type === 'tool_result'
        ? [
            {
              kind: 'tool_result',
              id: block.tool_use_id,
              ok: !block.is_error,
              text: truncate(resultText(block.content)),
            },
          ]
        : [],
    )
  }
  return []
}

const isPrismTool = (name: string) => name.startsWith('mcp__prism__')

export const claudeAdapter: AgentAdapter = {
  async run(input: SegmentInput): Promise<SegmentResult> {
    const sdk = await loadSdk()
    const abort = new AbortController()
    if (input.signal.aborted) abort.abort()
    input.signal.addEventListener('abort', () => abort.abort(), { once: true })

    const checked = new Map<string, string | null>()
    const check = (name: string, toolInput: Record<string, unknown>, id: string | undefined) => {
      if (input.tools.isWaiting() && !isPrismTool(name)) {
        return 'Waiting on the user. End your turn now; the answer arrives as the next message.'
      }
      const key = id === undefined ? null : `${id}\0${name}\0${JSON.stringify(toolInput)}`
      if (key !== null && checked.has(key)) return checked.get(key)!
      const reason = toolBlockReason(name, toolInput, {
        readOnly: input.readOnly,
        worktree: input.cwd,
        shell: input.shell ?? undefined,
      })
      if (key !== null) {
        checked.set(key, reason)
        if (checked.size > 32) checked.delete(checked.keys().next().value!)
      }
      return reason
    }

    const canUseTool: CanUseTool = async (name, toolInput, { toolUseID }) => {
      const reason = check(name, toolInput, toolUseID)
      if (reason) {
        input.onEvent({ kind: 'denied', tool: name, reason })
        return { behavior: 'deny', message: `PRism: ${reason}` }
      }
      return { behavior: 'allow', updatedInput: toolInput }
    }

    const preToolUse: HookCallback = async (hookInput, toolUseID) => {
      if (hookInput.hook_event_name !== 'PreToolUse') return {}
      const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>
      const reason = check(hookInput.tool_name, toolInput, toolUseID)
      if (!reason) return {}
      input.onEvent({ kind: 'denied', tool: hookInput.tool_name, reason })
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `PRism: ${reason}`,
        },
      }
    }

    const options: Options = {
      cwd: input.cwd,
      model: input.model,
      resume: input.resume ?? undefined,
      abortController: abort,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemAppend },
      settingSources: input.projectRoot ? ['project'] : [],
      projectConfigRoot: input.projectRoot ?? undefined,
      mcpServers: { prism: prismServer(sdk, input.tools) },
      strictMcpConfig: true,
      disallowedTools: ['AskUserQuestion', ...(input.readOnly ? editTools : [])],
      permissionMode: 'default',
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      additionalDirectories: input.extraDirs,
      env: input.env,
      pathToClaudeCodeExecutable: input.executable ?? undefined,
      stderr: (data) => {
        if (data.trim()) input.onEvent({ kind: 'note', text: truncate(data.trim(), 1000) })
      },
    }

    let sessionId = input.resume
    const result: SegmentResult = {
      sessionId,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      error: null,
    }
    try {
      for await (const message of sdk.query({ prompt: input.prompt, options })) {
        if ('session_id' in message && message.session_id && message.session_id !== sessionId) {
          sessionId = message.session_id
          result.sessionId = sessionId
          input.onSession(sessionId)
        }
        for (const event of eventsOf(message)) input.onEvent(event)
        if (message.type === 'result') {
          const totals = usageOf(message.modelUsage)
          result.tokensIn = Math.max(result.tokensIn, totals.tokensIn)
          result.tokensOut = Math.max(result.tokensOut, totals.tokensOut)
          result.costUsd = Math.max(result.costUsd, message.total_cost_usd)
          if (message.subtype !== 'success') {
            result.error = message.errors.join('\n') || message.subtype
          } else if (message.is_error) {
            result.error = message.result || 'The agent reported an error'
          }
        }
      }
    } catch (error) {
      if (input.signal.aborted) return result
      result.error = error instanceof Error ? error.message : String(error)
    }
    return result
  },
}
