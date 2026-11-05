import type { Ctx } from '../services/context'
import type { GithubApi } from '../services/gh-api'
import {
  getBoardSettings,
  listPrs,
  prDetail,
  setBoardSettings,
  setPrFlags,
  setPrStage,
} from '../services/prs'
import type { SyncService } from '../services/sync'
import type { registerIpc } from './register'

type Handlers = Parameters<typeof registerIpc>[0]

export type BoardChannel =
  | 'prs:list'
  | 'prs:detail'
  | 'prs:setFlags'
  | 'prs:setStage'
  | 'sync:now'
  | 'sync:status'
  | 'board:getSettings'
  | 'board:setSettings'

export function boardHandlers(
  ctx: Ctx,
  api: GithubApi,
  sync: SyncService,
  changed: () => void,
): Pick<Handlers, BoardChannel> {
  return {
    'prs:list': () => listPrs(ctx),
    'prs:detail': (id) => prDetail(ctx, api, id),
    'prs:setFlags': (input) => {
      const pr = setPrFlags(ctx, input)
      changed()
      return pr
    },
    'prs:setStage': (input) => {
      const pr = setPrStage(ctx, input)
      changed()
      return pr
    },
    'sync:now': () => sync.syncNow(true),
    'sync:status': () => sync.status(),
    'board:getSettings': () => getBoardSettings(ctx),
    'board:setSettings': (value) => setBoardSettings(ctx, value),
  }
}
