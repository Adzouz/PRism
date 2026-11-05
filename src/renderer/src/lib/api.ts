import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query'
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
