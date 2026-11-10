import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
import type {
  AppPreferences,
  BoardPr,
  Finding,
  FindingPatch,
  GatePatch,
  InstalledApps,
  PostGate,
  PostMode,
  Repo,
  Run,
  RunEvent,
  Stage,
} from '@shared/domain'
import type { IpcChannel, IpcInput, IpcOutput } from '@shared/ipc'

export function invoke<C extends IpcChannel>(
  channel: C,
  ...input: IpcInput<C> extends void ? [] : [IpcInput<C>]
): Promise<IpcOutput<C>> {
  return window.prism.invoke(channel, ...input)
}

export function errorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
  if (message.startsWith('[')) {
    try {
      const issues = JSON.parse(message) as { message?: string }[]
      return (
        issues
          .map((issue) => issue.message)
          .filter(Boolean)
          .join('. ') || message
      )
    } catch {
      return message
    }
  }
  return message
}

export const keys = {
  github: ['github'] as const,
  agents: ['agents'] as const,
  agentConfig: ['agents', 'config'] as const,
  repos: ['repos'] as const,
  sources: ['sources'] as const,
  skills: ['skills'] as const,
  scan: (sourceId: number) => ['sources', sourceId, 'scan'] as const,
  bindings: (repoId: number | null) => ['bindings', repoId] as const,
  proposals: (sourceId: number | null) => ['proposals', sourceId] as const,
  config: ['config'] as const,
  githubRepos: ['github', 'repos'] as const,
  prs: ['prs'] as const,
  prDetail: (id: number) => ['prs', id, 'detail'] as const,
  sync: ['sync'] as const,
  boardSettings: ['board', 'settings'] as const,
  runs: ['runs'] as const,
  prRuns: (prId: number) => ['runs', 'pr', prId] as const,
  runEvents: (runId: number) => ['runs', runId, 'events'] as const,
  runFindings: (runId: number) => ['runs', runId, 'findings'] as const,
  prThreads: (prId: number) => ['prs', prId, 'threads'] as const,
  apps: ['apps'] as const,
  gate: (runId: number) => ['gates', runId] as const,
  postMode: ['settings', 'postMode'] as const,
}

export const useGithubStatus = () =>
  useQuery({ queryKey: keys.github, queryFn: () => invoke('github:status', { refresh: true }) })

export const useAgents = () =>
  useQuery({ queryKey: keys.agents, queryFn: () => invoke('agents:detect') })

export const useAgentConfig = () =>
  useQuery({ queryKey: keys.agentConfig, queryFn: () => invoke('agents:getConfig') })

export const useRepos = () =>
  useQuery({ queryKey: keys.repos, queryFn: () => invoke('repos:list') })

export const useSources = () =>
  useQuery({ queryKey: keys.sources, queryFn: () => invoke('sources:list') })

export const useSkills = () =>
  useQuery({ queryKey: keys.skills, queryFn: () => invoke('skills:list') })

export const useScan = (sourceId: number | null) =>
  useQuery({
    queryKey: keys.scan(sourceId ?? 0),
    queryFn: () => invoke('sources:scan', sourceId!),
    enabled: sourceId !== null,
  })

export const useBindings = (repoId: number | null) =>
  useQuery({ queryKey: keys.bindings(repoId), queryFn: () => invoke('bindings:get', repoId) })

export const useProposals = (sourceId: number | null, enabled = true) =>
  useQuery({
    queryKey: keys.proposals(sourceId),
    queryFn: () => invoke('bindings:propose', sourceId),
    enabled,
  })

export const useConfigStatus = () =>
  useQuery({ queryKey: keys.config, queryFn: () => invoke('config:status'), staleTime: 0 })

export function useAction<I, O>(fn: (input: I) => Promise<O>, invalidate: QueryKey[] = []) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all(
        [...invalidate, keys.config].map((queryKey) => client.invalidateQueries({ queryKey })),
      )
    },
  })
}

export function useSkillsChanged() {
  const client = useQueryClient()
  useEffect(
    () =>
      window.prism.on('skills:changed', () => {
        void client.invalidateQueries({ queryKey: keys.skills })
        void client.invalidateQueries({ queryKey: ['bindings'] })
      }),
    [client],
  )
}

export const usePrs = () => useQuery({ queryKey: keys.prs, queryFn: () => invoke('prs:list') })

export const usePrDetail = (id: number | null) =>
  useQuery({
    queryKey: keys.prDetail(id ?? 0),
    queryFn: () => invoke('prs:detail', id!),
    enabled: id !== null,
    staleTime: 30_000,
  })

export const useSyncStatus = () =>
  useQuery({ queryKey: keys.sync, queryFn: () => invoke('sync:status') })

export const useBoardSettings = () =>
  useQuery({ queryKey: keys.boardSettings, queryFn: () => invoke('board:getSettings') })

export function useBoardEvents() {
  const client = useQueryClient()
  useEffect(() => {
    const offPrs = window.prism.on('prs:changed', () => {
      void client.invalidateQueries({ queryKey: keys.prs, exact: true })
    })
    const offSync = window.prism.on('sync:status', (status) => {
      client.setQueryData(keys.sync, status)
    })
    const offRun = window.prism.on('runs:changed', (run) => {
      const merge = (list: Run[] | undefined) =>
        list &&
        (list.some((item) => item.id === run.id)
          ? list.map((item) => (item.id === run.id ? run : item))
          : [run, ...list])
      client.setQueryData<Run[]>(keys.prRuns(run.prId), merge)
      client.setQueryData<Run[]>(keys.runs, merge)
      if (run.report) void client.invalidateQueries({ queryKey: keys.runFindings(run.id) })
      void client.invalidateQueries({ queryKey: keys.gate(run.id) })
    })
    const offEvent = window.prism.on('runs:event', (event) => {
      client.setQueryData<RunEvent[]>(keys.runEvents(event.runId), (list) =>
        list && !list.some((item) => item.id === event.id) ? [...list, event] : list,
      )
    })
    return () => {
      offPrs()
      offSync()
      offRun()
      offEvent()
    }
  }, [client])
}

export function usePrMutation<I extends { id: number }>(
  fn: (input: I) => Promise<BoardPr>,
  optimistic: (pr: BoardPr, input: I) => BoardPr,
) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onMutate: async (input) => {
      await client.cancelQueries({ queryKey: keys.prs, exact: true })
      const previous = client.getQueryData<BoardPr[]>(keys.prs)
      client.setQueryData<BoardPr[]>(keys.prs, (list) =>
        list?.map((pr) => (pr.id === input.id ? optimistic(pr, input) : pr)),
      )
      return { previous }
    },
    onError: (_error, _input, context) => {
      if (context?.previous) client.setQueryData(keys.prs, context.previous)
    },
    onSuccess: (pr) => {
      client.setQueryData<BoardPr[]>(keys.prs, (list) =>
        list?.map((item) => (item.id === pr.id ? pr : item)),
      )
    },
  })
}

type FlagInput = { id: number; starred?: boolean; hidden?: boolean; archived?: boolean }

export const useSetFlags = () =>
  usePrMutation(
    (input: FlagInput) => invoke('prs:setFlags', input),
    (pr, { starred, hidden, archived }) => ({
      ...pr,
      starred: starred ?? pr.starred,
      hidden: hidden ?? pr.hidden,
      archivedAt: archived === undefined ? pr.archivedAt : archived ? Date.now() : null,
    }),
  )

export const useSetStage = () =>
  usePrMutation(
    (input: { id: number; stage: BoardPr['stage'] | null }) => invoke('prs:setStage', input),
    (pr, { stage }) => {
      const next = stage ?? pr.derivedStage
      return { ...pr, stage: next, manual: next !== pr.derivedStage, stageSince: Date.now() }
    },
  )

export const useRuns = () => useQuery({ queryKey: keys.runs, queryFn: () => invoke('runs:list') })

export const usePrRuns = (prId: number) =>
  useQuery({ queryKey: keys.prRuns(prId), queryFn: () => invoke('runs:forPr', prId) })

export const useRunEvents = (runId: number | null) =>
  useQuery({
    queryKey: keys.runEvents(runId ?? 0),
    queryFn: () => invoke('runs:events', { runId: runId! }),
    enabled: runId !== null,
    staleTime: Infinity,
  })

export const useRunFindings = (runId: number | null) =>
  useQuery({
    queryKey: keys.runFindings(runId ?? 0),
    queryFn: () => invoke('runs:findings', runId!),
    enabled: runId !== null,
  })

function useRunMutation<I>(fn: (input: I) => Promise<Run>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (run) => {
      void client.invalidateQueries({ queryKey: keys.prRuns(run.prId) })
      void client.invalidateQueries({ queryKey: keys.prs, exact: true })
    },
  })
}

export const useStartRun = () =>
  useRunMutation((input: { prId: number; stage: Stage; threadIds?: string[] }) =>
    invoke('runs:start', input),
  )

export const useFollowUp = () =>
  useRunMutation((input: { runId: number; message: string }) => invoke('runs:followUp', input))

export const usePrThreads = (prId: number, enabled = true) =>
  useQuery({
    queryKey: keys.prThreads(prId),
    queryFn: () => invoke('prs:threads', prId),
    enabled,
    staleTime: 60_000,
  })

export const useApps = () =>
  useQuery({ queryKey: keys.apps, queryFn: () => invoke('apps:list'), staleTime: 5 * 60_000 })

export function useSetApps() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<AppPreferences>) => invoke('apps:setPreferred', patch),
    onSuccess: (preferred) =>
      client.setQueryData<InstalledApps>(keys.apps, (apps) => apps && { ...apps, preferred }),
  })
}

export const useOpenWorktree = () =>
  useMutation({
    mutationFn: (input: { runId: number; target: 'editor' | 'terminal' }) =>
      invoke('runs:openWorktree', input),
  })

export const useResumeInTerminal = () =>
  useMutation({ mutationFn: (runId: number) => invoke('runs:resumeInTerminal', runId) })

export const useCancelRun = () => useRunMutation((runId: number) => invoke('runs:cancel', runId))

export const useDismissRun = () => useRunMutation((runId: number) => invoke('runs:dismiss', runId))

export const useAnswer = () =>
  useRunMutation((input: { askId: number; answer: string }) => invoke('runs:answer', input))

export const useGate = (runId: number | null) =>
  useQuery({
    queryKey: keys.gate(runId ?? 0),
    queryFn: () => invoke('gates:get', runId!),
    enabled: runId !== null,
    refetchOnWindowFocus: true,
  })

function useGateMutation<I>(fn: (input: I) => Promise<PostGate>) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (gate) => {
      client.setQueryData(keys.gate(gate.runId), gate)
      void client.invalidateQueries({ queryKey: keys.runFindings(gate.runId) })
    },
  })
}

export const useUpdateGate = () =>
  useGateMutation((patch: GatePatch) => invoke('gates:update', patch))

export const useCommit = () =>
  useGateMutation((input: { runId: number; message?: string }) => invoke('gates:commit', input))

export const usePush = () => useGateMutation((runId: number) => invoke('gates:push', runId))

export const usePost = () => useGateMutation((runId: number) => invoke('gates:post', runId))

export const useSkipPost = () =>
  useGateMutation((input: { runId: number; skipped: boolean }) => invoke('gates:skip', input))

export function useUpdateFinding(runId: number) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: FindingPatch) => invoke('findings:update', patch),
    onSuccess: (finding) => {
      client.setQueryData<Finding[]>(keys.runFindings(runId), (list) =>
        list?.map((item) => (item.id === finding.id ? finding : item)),
      )
      void client.invalidateQueries({ queryKey: keys.gate(runId) })
    },
  })
}

export const usePostMode = () =>
  useQuery({ queryKey: keys.postMode, queryFn: () => invoke('settings:getPostMode') })

export function useSetPostMode() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (mode: PostMode) => invoke('settings:setPostMode', mode),
    onSuccess: (mode) => {
      client.setQueryData(keys.postMode, mode)
      void client.invalidateQueries({ queryKey: ['gates'] })
    },
  })
}

export function useSetRepoPostMode() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: { id: number; postMode: PostMode | null }) =>
      invoke('repos:setPostMode', input),
    onSuccess: (repo) => {
      client.setQueryData<Repo[]>(keys.repos, (list) =>
        list?.map((item) => (item.id === repo.id ? repo : item)),
      )
      void client.invalidateQueries({ queryKey: ['gates'] })
    },
  })
}

export { runStageFor } from '@shared/domain'
