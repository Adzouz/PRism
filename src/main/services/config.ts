import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ne } from 'drizzle-orm'
import { z } from 'zod'
import { agentConfig, stageLabels, type ConfigStatus, type GithubStatus } from '@shared/domain'
import { repos, settings, skills, skillSources, stageBindings } from '../db/schema'
import { getSetting, setSetting } from '../db/settings'
import type { Ctx } from './context'
import { githubStatus } from './github'
import { effectiveBindings, stopWatching } from './library'
import { listRepos } from './repos'

let cachedGithub: { at: number; value: GithubStatus } | null = null

export async function cachedGithubStatus(refresh = false) {
  if (refresh || !cachedGithub || Date.now() - cachedGithub.at > 60_000) {
    cachedGithub = { at: Date.now(), value: await githubStatus() }
  }
  return cachedGithub.value
}

export function getAgentConfig(ctx: Ctx) {
  return getSetting(ctx.db, 'agent', agentConfig.nullable(), null)
}

export function setAgentConfig(ctx: Ctx, value: z.infer<typeof agentConfig>) {
  setSetting(ctx.db, 'agent', value)
  return value
}

export function isOnboarded(ctx: Ctx) {
  return getSetting(ctx.db, 'onboarding.completedAt', z.number().nullable(), null) !== null
}

export async function configStatus(ctx: Ctx): Promise<ConfigStatus> {
  const issues: ConfigStatus['issues'] = []
  const github = await cachedGithubStatus()
  if (!github.loggedIn)
    issues.push({ key: 'github', message: 'GitHub is not connected', repoId: null })
  if (!getAgentConfig(ctx))
    issues.push({ key: 'agent', message: 'Pick a default agent', repoId: null })
  const repoList = listRepos(ctx)
  if (repoList.length === 0)
    issues.push({ key: 'repos', message: 'Add a repository', repoId: null })
  for (const repo of repoList) {
    const label = `${repo.owner}/${repo.name}`
    if (!repo.localPath) {
      issues.push({ key: 'clone', message: `${label}: no local clone`, repoId: repo.id })
    }
    if (!repo.worktreeRoot) {
      issues.push({ key: 'worktree', message: `${label}: no worktree folder`, repoId: repo.id })
    }
    for (const binding of effectiveBindings(ctx, repo.id)) {
      if (!binding.skill || !binding.validated) {
        issues.push({
          key: `stage:${binding.stage}`,
          message: `${label}: ${stageLabels[binding.stage]} skill not validated`,
          repoId: repo.id,
        })
      }
    }
  }
  return { valid: issues.length === 0, onboarded: isOnboarded(ctx), issues }
}

export async function completeOnboarding(ctx: Ctx) {
  const status = await configStatus(ctx)
  if (!status.valid) throw new Error(status.issues[0]?.message ?? 'Configuration is incomplete')
  setSetting(ctx.db, 'onboarding.completedAt', Date.now())
  return configStatus(ctx)
}

export async function resetConfiguration(ctx: Ctx) {
  stopWatching()
  ctx.db.transaction((tx) => {
    tx.delete(stageBindings).run()
    tx.delete(skills).run()
    tx.delete(repos).run()
    tx.delete(skillSources).run()
    tx.delete(settings).where(ne(settings.key, 'theme')).run()
  })
  cachedGithub = null
  await Promise.all(
    ['skills', 'sources'].map((dir) =>
      rm(join(ctx.userData, dir), { recursive: true, force: true }),
    ),
  )
  return configStatus(ctx)
}
