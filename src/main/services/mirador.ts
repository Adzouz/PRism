import { eq } from 'drizzle-orm'
import type { Finding, ReviewReport, Run } from '@shared/domain'
import { prs, repos } from '../db/schema'
import { run as runCommand, which, type RunResult } from '../system/exec'
import type { Ctx } from './context'
import { getRun, listFindings } from './runs'

type Exec = (args: string[]) => Promise<RunResult>

const verdictWords: Record<ReviewReport['verdict'], string> = {
  approve: 'GO',
  comment: 'GO WITH NITS',
  request_changes: 'NO GO',
}

export function miradorNote(
  verdict: ReviewReport['verdict'],
  findings: Pick<Finding, 'severity' | 'title' | 'included'>[],
) {
  const word = verdictWords[verdict]
  const included = findings.filter((finding) => finding.included)
  if (verdict === 'request_changes') {
    const reason = included.find((finding) => finding.severity === 'blocking') ?? included[0]
    return reason ? `${word} — ${reason.title}` : word
  }
  if (verdict === 'comment' && included.length > 0) {
    return `${word} — ${included.length} ${included.length === 1 ? 'finding' : 'findings'}`
  }
  return word
}

const usedCommands = ['mirador start', 'mirador status', 'mirador note']

export const isMiradorHelp = (help: string) =>
  usedCommands.every((command) => help.includes(command))

export function createMiradorBridge(
  ctx: Ctx,
  deps: { exec?: Exec; available?: () => Promise<boolean> } = {},
) {
  const exec: Exec =
    deps.exec ?? ((args) => runCommand('mirador', args, { cwd: ctx.userData, timeout: 30_000 }))
  const available =
    deps.available ??
    (async () => {
      if (!(await which('mirador'))) return false
      const help = await runCommand('mirador', ['help'], { cwd: ctx.userData, timeout: 10_000 })
      return help.code === 0 && isMiradorHelp(help.stdout)
    })
  const warned = new Set<string>()

  function target(prId: number) {
    const row = ctx.db
      .select({ number: prs.number, title: prs.title, myRole: prs.myRole, on: repos.mirador })
      .from(prs)
      .innerJoin(repos, eq(repos.id, prs.repoId))
      .where(eq(prs.id, prId))
      .get()
    return row?.on ? row : null
  }

  async function send(args: string[]) {
    try {
      if (!(await available())) return
      const result = await exec(args)
      if (result.code === 0 || warned.has(args[0]!)) return
      warned.add(args[0]!)
      console.warn(`mirador ${args[0]} failed:`, result.stderr.trim())
    } catch (error) {
      console.warn('Mirador is not reachable:', error)
    }
  }

  return {
    status: async () => ({ available: await available() }),

    runStarted(run: Run) {
      const pr = target(run.prId)
      if (!pr) return Promise.resolve()
      const number = String(pr.number)
      if (run.stage === 'review' || run.stage === 're-review') {
        return send(['start', '--kind', 'review', '--pr', number, '--title', pr.title])
      }
      if (run.stage === 'address' && pr.myRole !== 'reviewer') {
        return send(['status', 'addressing', number])
      }
      return Promise.resolve()
    },

    reviewPosted(runId: number) {
      const run = getRun(ctx, runId)
      const pr = target(run.prId)
      if (!pr || !run.report) return Promise.resolve()
      const note = miradorNote(run.report.verdict, listFindings(ctx, runId))
      return send(['note', note, '--ref', String(pr.number)])
    },
  }
}

export type MiradorBridge = ReturnType<typeof createMiradorBridge>
