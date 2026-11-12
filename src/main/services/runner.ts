import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  activeRunStatuses,
  needsAnswer,
  threadStages,
  type AgentId,
  type Run,
  type RunEvent,
  type Stage,
} from '@shared/domain'
import { ghShimScript, pushBlockEnv, type ShellContext } from '../agents/guard'
import {
  answerPrompt,
  buildPrompt,
  prismContract,
  readOnlyStages,
  resumeAfterRestart,
} from '../agents/prompt'
import type { AgentAdapter, AgentEvent, PrismTools } from '../agents/types'
import { prs } from '../db/schema'
import { userEnv, userPath, which } from '../system/exec'
import { agentShell, probeShell } from '../system/shell'
import { openInEditor, openInTerminal, resumeCommand, runInTerminal } from './apps'
import { anchorOf } from './anchors'
import { getAgentConfig } from './config'
import type { Ctx } from './context'
import { computeDelta, describeDelta, type Delta } from './delta'
import type { GithubApi } from './gh-api'
import { effectiveBindings, findSkill, readSkillContent, skillDirOf } from './library'
import { prThreads } from './prs'
import { getRepo } from './repos'
import {
  activeRunFor,
  addEvent,
  answerAsk,
  closePendingAsks,
  createAsk,
  createRun,
  dismissRun,
  getRun,
  getRunRow,
  lastReviewed,
  latestAsk,
  listRuns,
  listRunsForPr,
  openReviewFindings,
  pendingAsk,
  recordUsage,
  saveChanges,
  saveReplies,
  saveReview,
  splitRepeats,
  setPriorStatus,
  updateRun,
} from './runs'
import {
  prepareWorktree,
  remoteUrls,
  unblockedPushRemotes,
  type PrCheckout,
  type Worktree,
} from './worktrees'

export type RunnerEmit = {
  run: (run: Run) => void
  event: (event: RunEvent) => void
  prsChanged: () => void
}

export type RunnerDeps = {
  ctx: Ctx
  api: GithubApi
  adapters: Partial<Record<AgentId, AgentAdapter>>
  emit: RunnerEmit
  agentEnv?: () => Promise<{
    env: Record<string, string>
    executable: string | null
    shell?: ShellContext | null
    shellError?: string | null
  }>
  prepare?: typeof prepareWorktree
}

const checkoutQuery = `
  query Checkout($id: ID!) {
    node(id: $id) { ... on PullRequest {
      headRefName headRefOid baseRefName isCrossRepository
      headRepository { owner { login } url sshUrl }
    } }
  }
`

type CheckoutNode = {
  headRefName: string
  headRefOid: string
  baseRefName: string
  isCrossRepository: boolean
  headRepository: { owner: { login: string }; url: string; sshUrl: string } | null
}

const reportedBy: Record<Stage, (run: Run) => boolean> = {
  review: (run) => run.report !== null,
  're-review': (run) => run.report !== null,
  'test-plan': (run) => run.report !== null,
  address: (run) => run.changes !== null,
  'draft-replies': (run) => run.replies.length > 0,
}

const reportTool: Record<Stage, string> = {
  review: 'prism_report_findings',
  're-review': 'prism_report_findings',
  'test-plan': 'prism_report_findings',
  address: 'prism_report_changes',
  'draft-replies': 'prism_draft_replies',
}

const terminal = (status: Run['status']) =>
  status === 'done' || status === 'failed' || status === 'cancelled'

export async function defaultAgentEnv(userData: string) {
  const bin = join(userData, 'bin')
  const realGh = await which('gh')
  if (realGh && !realGh.startsWith(bin)) {
    await mkdir(bin, { recursive: true })
    await writeFile(join(bin, 'gh'), ghShimScript(realGh))
    await chmod(join(bin, 'gh'), 0o755)
  }
  const base = await userEnv()
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && key !== 'PRISM_PUSH_NONCE') env[key] = value
  }
  env.PATH = `${bin}:${await userPath()}`
  env.GH_PROMPT_DISABLED = '1'
  env.GIT_TERMINAL_PROMPT = '0'
  return { env, executable: await which('claude'), ...(await shellContextFor(env)) }
}

let shellProbe: Promise<ShellContext> | null = null

async function shellContextFor(env: Record<string, string>) {
  const probe = (shellProbe ??= probeShell({
    shell: agentShell(env),
    home: env.HOME || homedir(),
    env,
  }))
  try {
    return { shell: await probe, shellError: null }
  } catch (error) {
    if (shellProbe === probe) shellProbe = null
    return { shell: null, shellError: error instanceof Error ? error.message : String(error) }
  }
}

export function createRunner(deps: RunnerDeps) {
  const { ctx, api, emit } = deps
  const controllers = new Map<number, AbortController>()
  const queued = new Map<number, string[]>()
  const prepare = deps.prepare ?? prepareWorktree
  const agentEnv = deps.agentEnv ?? (() => defaultAgentEnv(ctx.userData))

  const event = (runId: number, kind: RunEvent['kind'], payload: Record<string, unknown>) =>
    emit.event(addEvent(ctx, runId, kind, payload))

  const update = (runId: number, set: Parameters<typeof updateRun>[2], boardChanged = true) => {
    const run = updateRun(ctx, runId, set)
    emit.run(run)
    if (boardChanged) emit.prsChanged()
    return run
  }

  const setStatus = (
    runId: number,
    status: Run['status'],
    extra: Parameters<typeof updateRun>[2] = {},
  ) => {
    event(runId, 'status', { status, ...(extra.error ? { error: extra.error } : {}) })
    return update(runId, { status, ...extra })
  }

  function prismTools(runId: number): PrismTools {
    const prId = getRunRow(ctx, runId).prId
    return {
      reportFindings: (report, items) => {
        const worktree = getRunRow(ctx, runId).worktreePath
        const anchored = items.map((item) => ({ ...item, hunkHash: anchorOf(worktree, item) }))
        const { kept, repeats } = splitRepeats(ctx, prId, runId, anchored)
        const run = saveReview(ctx, runId, report, kept)
        if (repeats.length > 0) {
          event(runId, 'note', {
            text: `Dropped ${repeats.length} finding(s) already reported and still open: ${repeats
              .map((item) => `#${item.findingId}`)
              .join(', ')}`,
          })
        }
        emit.run(run)
        emit.prsChanged()
        const dropped =
          repeats.length > 0
            ? ` Dropped ${repeats.length} that repeat open findings (${repeats
                .map((item) => `"${item.title}" = #${item.findingId}`)
                .join(', ')}); update those with prism_report_prior_status instead.`
            : ''
        return `Recorded the ${report.verdict} verdict with ${kept.length} finding(s).${dropped}`
      },
      reportPriorStatus: (items) => `Updated ${setPriorStatus(ctx, prId, items)} finding(s).`,
      reportChanges: (changes) => {
        emit.run(saveChanges(ctx, runId, changes))
        return `Recorded changes for ${changes.threads.length} thread(s).`
      },
      draftReplies: (replies) => {
        emit.run(saveReplies(ctx, runId, replies))
        return `Saved ${replies.length} draft repl${replies.length === 1 ? 'y' : 'ies'}. The user decides what to post.`
      },
      askUser: (input) => {
        if (pendingAsk(ctx, runId)) {
          return 'A question is already waiting for the user. End your turn now; the answer arrives as the next message.'
        }
        const ask = createAsk(ctx, runId, {
          prompt: input.question,
          options: input.options,
          placeholder: input.placeholder,
        })
        event(runId, 'ask', { askId: ask.id, question: ask.prompt, options: ask.options })
        update(runId, { status: 'needs_you' })
        return 'Question sent to the user. End your turn now; the answer arrives as the next message.'
      },
      progress: (label) => {
        event(runId, 'progress', { label })
        update(runId, { progress: label })
        return 'ok'
      },
      isWaiting: () => pendingAsk(ctx, runId) !== null,
    }
  }

  async function checkout(prId: number) {
    const row = ctx.db.select().from(prs).where(eq(prs.id, prId)).get()
    if (!row) throw new Error(`Pull request ${prId} not found`)
    const repo = getRepo(ctx, row.repoId)
    if (!repo.localPath) throw new Error(`${repo.owner}/${repo.name} has no local clone`)
    if (!repo.worktreeRoot) throw new Error(`${repo.owner}/${repo.name} has no worktree folder`)
    const { node } = await api.graphql<{ node: CheckoutNode | null }>(checkoutQuery, {
      id: row.nodeId,
    })
    const pr: PrCheckout = {
      number: row.number,
      owner: repo.owner,
      name: repo.name,
      headRef: node?.headRefName ?? row.headRef,
      headOid: node?.headRefOid ?? row.headOid,
      baseRef: node?.baseRefName ?? row.baseRef,
      crossRepository: node ? node.isCrossRepository : true,
      headRepo: node?.headRepository
        ? {
            owner: node.headRepository.owner.login,
            url: node.headRepository.url,
            sshUrl: node.headRepository.sshUrl,
          }
        : null,
    }
    return { row, repo, pr }
  }

  function priorFindings(prId: number) {
    return openReviewFindings(ctx, prId).map(
      (item) =>
        `#${item.id} [${item.severity}] ${item.path}${item.line ? `:${item.line}` : ''} ${item.title} (${item.status})`,
    )
  }

  function skillOf(run: { skillId: number | null; skillName: string | null }) {
    const skill = run.skillId ? findSkill(ctx, run.skillId) : null
    if (!skill && run.skillName) {
      throw new Error(`The skill ${run.skillName} is no longer in the library`)
    }
    return skill
  }

  function projectRootOf(prId: number) {
    const row = ctx.db.select({ repoId: prs.repoId }).from(prs).where(eq(prs.id, prId)).get()
    if (!row) return null
    try {
      return getRepo(ctx, row.repoId).localPath
    } catch {
      return null
    }
  }

  const stopping = (prId: number) => listRunsForPr(ctx, prId).some((run) => controllers.has(run.id))

  async function selectThreads(runId: number, prId: number, stored: string[] | null) {
    const all = await prThreads(ctx, api, prId)
    if (stored) return stored.flatMap((id) => all.find((thread) => thread.id === id) ?? [])
    const open = all.filter(needsAnswer)
    update(runId, { threadsJson: JSON.stringify(open.map((thread) => thread.id)) }, false)
    return open
  }

  async function firstPrompt(runId: number, signal: AbortSignal) {
    const run = getRunRow(ctx, runId)
    setStatus(runId, 'preparing', { startedAt: Date.now(), progress: 'Preparing worktree' })
    const { row, repo, pr } = await checkout(run.prId)
    const threads = threadStages.includes(run.stage as Stage)
      ? await selectThreads(runId, run.prId, run.threadsJson ? getRun(ctx, runId).threadIds : null)
      : []
    if (threadStages.includes(run.stage as Stage) && threads.length === 0) {
      throw new Error('There are no review threads waiting for an answer')
    }
    const skill = skillOf(run)
    const content = skill ? await readSkillContent(ctx, skill.id) : null
    const skillDir = skill ? skillDirOf(skill) : null
    const worktree: Worktree = await prepare(
      {
        clone: repo.localPath!,
        root: repo.worktreeRoot!,
        hooksDir: join(ctx.userData, 'hooks'),
        log: (text) => event(runId, 'note', { text }),
      },
      pr,
    )
    if (signal.aborted) return null
    const reviewing = run.stage === 'review' || run.stage === 're-review'
    let delta: Delta | null = null
    if (run.stage === 're-review') {
      const last = lastReviewed(ctx, run.prId, runId)
      delta = await computeDelta(worktree.path, {
        lastHead: last.head,
        lastBase: last.base,
        head: worktree.headOid,
        base: `${worktree.baseRemote}/${pr.baseRef}`,
      })
      event(runId, 'note', { text: describeDelta(delta) })
    }
    update(runId, {
      worktreePath: worktree.path,
      reviewedHeadOid: worktree.headOid,
      reviewedBaseOid: row.baseOid,
      pushRemote: worktree.remote,
      pushRef: pr.headRef,
    })
    return {
      cwd: worktree.path,
      skillDir,
      prompt: buildPrompt({
        stage: run.stage as Stage,
        repo: `${repo.owner}/${repo.name}`,
        number: row.number,
        title: row.title,
        url: row.url,
        author: row.author,
        headRef: pr.headRef,
        headOid: worktree.headOid,
        baseRef: pr.baseRef,
        baseRemote: worktree.baseRemote,
        worktree: worktree.path,
        skillName: run.skillName,
        skillDir,
        skill: content,
        worktreeWarning: worktree.warning,
        priorFindings: reviewing ? priorFindings(run.prId) : [],
        delta,
        threads,
      }),
    }
  }

  function onAgentEvent(runId: number, agentEvent: AgentEvent) {
    const { kind, ...payload } = agentEvent
    event(runId, kind, payload)
  }

  async function execute(runId: number, resumePrompt: string | null) {
    if (controllers.has(runId)) {
      if (resumePrompt) queued.set(runId, [...(queued.get(runId) ?? []), resumePrompt])
      return
    }
    const controller = new AbortController()
    controllers.set(runId, controller)
    let nudged = false
    try {
      const run = getRun(ctx, runId)
      const adapter = deps.adapters[run.agent]
      if (!adapter) throw new Error(`The ${run.agent} agent is not supported yet`)
      const projectRoot = projectRootOf(run.prId)
      const skillId = getRunRow(ctx, runId).skillId
      const known = skillId ? findSkill(ctx, skillId) : null
      let cwd = run.worktreePath
      let extraDirs = known ? [skillDirOf(known)] : []
      let prompt = resumePrompt
      if (!prompt || !run.sessionId || !cwd) {
        const first = await firstPrompt(runId, controller.signal)
        if (!first) return
        cwd = first.cwd
        extraDirs = first.skillDir ? [first.skillDir] : []
        prompt = first.prompt
      }
      const { env, executable, shell = null, shellError = null } = await agentEnv()
      Object.assign(env, pushBlockEnv(env, projectRoot ? await remoteUrls(projectRoot) : []))
      if (projectRoot && !run.sessionId) {
        for (const { remote, url } of await unblockedPushRemotes(projectRoot, env)) {
          event(runId, 'note', {
            text: `PRism's push block does not cover the remote ${remote}: pushes to it go to ${url}. The command guard and the pre-push hook still apply.`,
          })
        }
      }
      if (shellError) {
        event(runId, 'note', {
          text: 'PRism could not read your shell aliases and functions, so commands that use them are not checked in this run. It tries again on the next run.',
        })
      }
      const tools = prismTools(runId)
      let resume = getRunRow(ctx, runId).sessionId
      while (prompt && !controller.signal.aborted) {
        setStatus(runId, 'running', { startedAt: getRunRow(ctx, runId).startedAt ?? Date.now() })
        const resumed = resume
        const result = await adapter.run({
          prompt,
          resume,
          cwd,
          projectRoot,
          shell,
          model: run.model,
          stage: run.stage,
          readOnly: readOnlyStages.has(run.stage),
          systemAppend: prismContract,
          extraDirs,
          env,
          executable,
          tools,
          signal: controller.signal,
          onEvent: (agentEvent) => onAgentEvent(runId, agentEvent),
          onSession: (sessionId) => update(runId, { sessionId }, false),
        })
        if (result.sessionId && result.sessionId !== resume) {
          update(runId, { sessionId: result.sessionId }, false)
        }
        resume = result.sessionId ?? resume
        emit.run(recordUsage(ctx, runId, result, resumed !== null && result.sessionId === resumed))
        event(runId, 'result', {
          costUsd: result.costUsd,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          error: result.error,
        })
        if (controller.signal.aborted) return
        if (result.error) {
          setStatus(runId, 'failed', { error: result.error, endedAt: Date.now(), progress: null })
          return
        }
        const next = queued.get(runId)?.shift()
        if (next) {
          prompt = next
          continue
        }
        if (pendingAsk(ctx, runId)) {
          update(runId, { status: 'needs_you', progress: 'Waiting for you' })
          return
        }
        const current = getRun(ctx, runId)
        if (!reportedBy[current.stage](current) && !nudged) {
          nudged = true
          prompt = `You ended without calling ${reportTool[current.stage]}. Call it now with your results.`
          continue
        }
        if (!reportedBy[current.stage](current)) {
          setStatus(runId, 'failed', {
            error: `The agent finished without calling ${reportTool[current.stage]}`,
            endedAt: Date.now(),
            progress: null,
          })
          return
        }
        setStatus(runId, 'done', { endedAt: Date.now(), progress: null })
        return
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        try {
          event(runId, 'error', { message })
          setStatus(runId, 'failed', { error: message, endedAt: Date.now(), progress: null })
        } catch {
          controller.abort()
        }
      }
    } finally {
      controllers.delete(runId)
      queued.delete(runId)
    }
  }

  function cancel(runId: number) {
    const run = getRun(ctx, runId)
    if (terminal(run.status)) return run
    controllers.get(runId)?.abort()
    closePendingAsks(ctx, runId)
    return setStatus(runId, 'cancelled', { endedAt: Date.now(), progress: null })
  }

  function cancelWhere(match: (prId: number) => boolean) {
    for (const run of listRuns(ctx, activeRunStatuses)) {
      if (match(run.prId)) cancel(run.id)
    }
  }

  return {
    start(input: { prId: number; stage: Stage; threadIds?: string[] }) {
      const row = ctx.db.select().from(prs).where(eq(prs.id, input.prId)).get()
      if (!row) throw new Error(`Pull request ${input.prId} not found`)
      if (activeRunFor(ctx, input.prId))
        throw new Error('A run is already in progress for this pull request')
      if (stopping(input.prId)) {
        throw new Error('The previous run is still stopping. Try again in a moment.')
      }
      const config = getAgentConfig(ctx)
      if (!config) throw new Error('Pick a default agent in Settings first')
      if (!deps.adapters[config.agent])
        throw new Error(`The ${config.agent} agent is not supported yet`)
      const binding = effectiveBindings(ctx, row.repoId).find((item) => item.stage === input.stage)
      if (!binding?.skill) throw new Error(`No skill is bound to the ${input.stage} stage`)
      const run = createRun(ctx, {
        prId: input.prId,
        stage: input.stage,
        skillId: binding.skill.id,
        skillName: binding.skill.name,
        agent: config.agent,
        model: config.model,
        threadIds: threadStages.includes(input.stage) ? input.threadIds : undefined,
      })
      event(run.id, 'status', { status: 'queued' })
      emit.run(run)
      emit.prsChanged()
      void execute(run.id, null)
      return run
    },

    cancel,

    cancelForRepo(repoId: number) {
      cancelWhere(
        (prId) =>
          ctx.db.select({ repoId: prs.repoId }).from(prs).where(eq(prs.id, prId)).get()?.repoId ===
          repoId,
      )
    },

    cancelAll() {
      cancelWhere(() => true)
    },

    answer(input: { askId: number; answer: string }) {
      const ask = answerAsk(ctx, input.askId, input.answer.trim())
      event(ask.runId, 'answer', { askId: ask.id, answer: ask.answer })
      const run = getRun(ctx, ask.runId)
      if (run.status === 'needs_you' || controllers.has(run.id)) {
        if (!controllers.has(run.id)) update(run.id, { status: 'running', progress: 'Resuming' })
        void execute(run.id, answerPrompt(ask.prompt, ask.answer ?? ''))
      }
      return getRun(ctx, ask.runId)
    },

    dismiss(runId: number) {
      const run = getRun(ctx, runId)
      if (!terminal(run.status)) throw new Error('Stop the run before dismissing it')
      for (const id of dismissRun(ctx, runId)) emit.run(getRun(ctx, id))
      emit.prsChanged()
      return getRun(ctx, runId)
    },

    followUp(input: { runId: number; message: string }) {
      const run = getRun(ctx, input.runId)
      if (!terminal(run.status)) throw new Error('The run is still in progress')
      if (!run.sessionId || !run.worktreePath) {
        throw new Error('This run has no agent session to continue')
      }
      if (activeRunFor(ctx, run.prId)) {
        throw new Error('Another run is in progress for this pull request')
      }
      if (stopping(run.prId)) {
        throw new Error('The run is still stopping. Try again in a moment.')
      }
      closePendingAsks(ctx, run.id)
      const message = input.message.trim()
      event(run.id, 'message', { text: message })
      const next = update(run.id, {
        status: 'running',
        dismissedAt: null,
        endedAt: null,
        error: null,
        progress: 'Following up',
      })
      void execute(run.id, message)
      return next
    },

    async openWorktree(input: { runId: number; target: 'editor' | 'terminal' }) {
      const run = getRun(ctx, input.runId)
      if (!run.worktreePath) throw new Error('This run has no worktree yet')
      await (input.target === 'editor' ? openInEditor : openInTerminal)(ctx, run.worktreePath)
    },

    async resumeInTerminal(runId: number) {
      const run = getRun(ctx, runId)
      if (!run.sessionId || !run.worktreePath) {
        throw new Error('This run has no agent session to resume')
      }
      if (controllers.has(runId)) throw new Error('Stop the run before resuming it in a terminal')
      await runInTerminal(ctx, resumeCommand(run.worktreePath, run.sessionId))
    },

    resumeAll() {
      for (const run of listRuns(ctx, ['queued', 'preparing', 'running', 'needs_you'])) {
        if (run.status === 'needs_you') {
          const last = latestAsk(ctx, run.id)
          if (last?.answer != null && run.sessionId) {
            event(run.id, 'note', { text: 'PRism restarted; sending your answer' })
            void execute(run.id, answerPrompt(last.prompt, last.answer))
          }
          continue
        }
        event(run.id, 'note', { text: 'PRism restarted; resuming the run' })
        void execute(run.id, run.sessionId && run.worktreePath ? resumeAfterRestart : null)
      }
    },

    isActive: (runId: number) => controllers.has(runId),

    shutdown() {
      for (const controller of controllers.values()) controller.abort()
    },
  }
}

export type AgentRunner = ReturnType<typeof createRunner>
