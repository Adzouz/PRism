import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { eventsOf, usageOf } from './claude'

const token = `ghp_${'Zx9k'.repeat(9)}`

describe('claude adapter helpers', () => {
  it('redacts tool output before truncating it', () => {
    const text = `${'x'.repeat(3966)} GITHUB_TOKEN=${token} ${'y'.repeat(100)}`
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: text }],
      },
    } as unknown as SDKMessage
    const [event] = eventsOf(message)
    expect(event).toMatchObject({ kind: 'tool_result', id: 't1', ok: true })
    const body = event && 'text' in event ? event.text : ''
    expect(body).not.toContain(token.slice(0, 12))
    expect(body).toContain('[redacted]')
  })

  it('sums tokens across models from modelUsage', () => {
    expect(
      usageOf({
        'claude-opus-5-5': {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 20,
          webSearchRequests: 0,
          costUSD: 0.1,
          contextWindow: 0,
          maxOutputTokens: 0,
        },
        'claude-haiku-5-5': {
          inputTokens: 1,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.01,
          contextWindow: 0,
          maxOutputTokens: 0,
        },
      }),
    ).toEqual({ tokensIn: 131, tokensOut: 7 })
    expect(usageOf(undefined)).toEqual({ tokensIn: 0, tokensOut: 0 })
  })
})
