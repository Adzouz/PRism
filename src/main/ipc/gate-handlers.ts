import { getPostMode, setPostMode, type Actions } from '../services/actions'
import type { Ctx } from '../services/context'
import { setRepoPostMode } from '../services/repos'
import { updateFinding } from '../services/runs'
import type { registerIpc } from './register'

type Handlers = Parameters<typeof registerIpc>[0]

export type GateChannel =
  | 'gates:get'
  | 'gates:update'
  | 'gates:commit'
  | 'gates:push'
  | 'gates:post'
  | 'gates:skip'
  | 'findings:update'
  | 'settings:getPostMode'
  | 'settings:setPostMode'
  | 'repos:setPostMode'

export function gateHandlers(ctx: Ctx, actions: Actions): Pick<Handlers, GateChannel> {
  return {
    'gates:get': (runId) => actions.get(runId),
    'gates:update': (patch) => actions.update(patch),
    'gates:commit': ({ runId, message }) => actions.commit(runId, message),
    'gates:push': (runId) => actions.push(runId),
    'gates:post': (runId) => actions.post(runId),
    'gates:skip': ({ runId, skipped }) => actions.skip(runId, skipped),
    'findings:update': (patch) => updateFinding(ctx, patch),
    'settings:getPostMode': () => getPostMode(ctx),
    'settings:setPostMode': (mode) => setPostMode(ctx, mode),
    'repos:setPostMode': ({ id, postMode }) => setRepoPostMode(ctx, id, postMode),
  }
}
