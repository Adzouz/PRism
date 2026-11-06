import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ReviewReport } from '@shared/domain'
import { defaultAgentEnv } from '../services/runner'
import type { NewFinding } from '../services/runs'
import { claudeAdapter } from './claude'
import type { AgentEvent, PrismTools, SegmentInput } from './types'

const live = process.env.PRISM_LIVE === '1'

function tools() {
  const state = {
    report: null as { report: ReviewReport; findings: NewFinding[] } | null,
    asked: [] as string[],
    progress: [] as string[],
  }
  const value: PrismTools = {
    reportFindings: (report, findings) => {
      state.report = { report, findings }
      return 'Recorded.'
    },
    reportPriorStatus: () => 'ok',
    reportChanges: () => 'ok',
    draftReplies: () => 'ok',
    askUser: ({ question }) => {
      state.asked.push(question)
      return 'Question sent to the user. End your turn now.'
    },
    progress: (label) => {
      state.progress.push(label)
      return 'ok'
    },
    isWaiting: () => false,
  }
  return { state, value }
}

describe.skipIf(!live)('claude adapter (live)', () => {
  it('reviews through prism tools, blocks commits, and resumes the session', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'prism-live-')))
    execFileSync('git', ['init', '-q', '-b', 'main', dir])
    await writeFile(
      join(dir, 'math.js'),
      'export function average(list) {\n  return list.reduce((a, b) => a + b) / list.length\n}\n',
    )
    execFileSync('git', ['-C', dir, 'add', '.'])
    const { env, executable } = await defaultAgentEnv(await mkdtemp(join(tmpdir(), 'prism-ud-')))
    const { state, value } = tools()
    const events: AgentEvent[] = []
    const base: Omit<SegmentInput, 'prompt' | 'resume'> = {
      cwd: dir,
      model: 'claude-haiku-5-5',
      stage: 'review',
      readOnly: true,
      systemAppend: '',
      extraDirs: [],
      env,
      executable,
      tools: value,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      onSession: () => {},
    }
    const first = await claudeAdapter.run({
      ...base,
      resume: null,
      prompt:
        'Run the Bash command `git commit -am "wip"` once, then run `gh pr comment 1 --body hi` once (both may fail; do not retry). Then call prism_progress, then review math.js and report one finding about the empty-list case with prism_report_findings.',
    })
    if (process.env.PRISM_LIVE_DEBUG) console.log(JSON.stringify(events, null, 1).slice(0, 6000))
    expect(first.error).toBeNull()
    expect(first.sessionId).toBeTruthy()
    expect(first.costUsd).toBeGreaterThan(0)
    expect(state.report?.findings.length).toBeGreaterThan(0)
    expect(events.filter((event) => event.kind === 'denied').length).toBeGreaterThanOrEqual(2)
    expect(execFileSync('git', ['-C', dir, 'rev-list', '--all']).toString()).toBe('')

    const second = await claudeAdapter.run({
      ...base,
      resume: first.sessionId,
      prompt: 'Reply with only the title of the finding you reported, nothing else.',
    })
    expect(second.error).toBeNull()
    expect(second.sessionId).toBe(first.sessionId)
    const reply = events.filter((event) => event.kind === 'text').at(-1)
    expect(reply && 'text' in reply ? reply.text.length : 0).toBeGreaterThan(0)
  }, 240_000)
})
