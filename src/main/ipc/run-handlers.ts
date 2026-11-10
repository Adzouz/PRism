import { listApps, setAppPreferences } from '../services/apps'
import type { Ctx } from '../services/context'
import type { GithubApi } from '../services/gh-api'
import { prThreads } from '../services/prs'
import type { AgentRunner } from '../services/runner'
import { listEvents, listFindings, listRuns, listRunsForPr } from '../services/runs'
import type { registerIpc } from './register'

type Handlers = Parameters<typeof registerIpc>[0]

export type RunChannel =
  | 'runs:start'
  | 'runs:cancel'
  | 'runs:answer'
  | 'runs:dismiss'
  | 'runs:list'
  | 'runs:forPr'
  | 'runs:events'
  | 'runs:findings'
  | 'runs:followUp'
  | 'runs:openWorktree'
  | 'runs:resumeInTerminal'
  | 'prs:threads'
  | 'apps:list'
  | 'apps:setPreferred'

export function runHandlers(
  ctx: Ctx,
  api: GithubApi,
  runner: AgentRunner,
): Pick<Handlers, RunChannel> {
  return {
    'runs:start': (input) => runner.start(input),
    'runs:cancel': (id) => runner.cancel(id),
    'runs:answer': (input) => runner.answer(input),
    'runs:dismiss': (id) => runner.dismiss(id),
    'runs:list': () => listRuns(ctx),
    'runs:forPr': (prId) => listRunsForPr(ctx, prId),
    'runs:events': ({ runId, afterId }) => listEvents(ctx, runId, afterId),
    'runs:findings': (runId) => listFindings(ctx, runId),
    'runs:followUp': (input) => runner.followUp(input),
    'runs:openWorktree': (input) => runner.openWorktree(input),
    'runs:resumeInTerminal': (runId) => runner.resumeInTerminal(runId),
    'prs:threads': (prId) => prThreads(ctx, api, prId),
    'apps:list': () => listApps(ctx),
    'apps:setPreferred': (patch) => setAppPreferences(ctx, patch),
  }
}
