import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentCommands, agentIds, type AgentId, type AgentStatus } from '@shared/domain'
import { run, which } from '../system/exec'

type Login = { loggedIn: boolean | null; detail: string | null }

const loginChecks: Record<AgentId, () => Promise<Login>> = {
  claude: async () => {
    const result = await run('claude', ['auth', 'status'], { timeout: 15_000 })
    try {
      const data = JSON.parse(result.stdout) as { loggedIn?: boolean; authMethod?: string }
      return { loggedIn: data.loggedIn === true, detail: data.authMethod ?? null }
    } catch {
      return { loggedIn: result.code === 0 ? null : false, detail: null }
    }
  },
  codex: async () => {
    const result = await run('codex', ['login', 'status'], { timeout: 15_000 })
    const text = `${result.stdout}${result.stderr}`.trim()
    return { loggedIn: result.code === 0 && !/not logged in/i.test(text), detail: text || null }
  },
  'cursor-agent': async () => {
    const result = await run('cursor-agent', ['status'], { timeout: 15_000 })
    const text = `${result.stdout}${result.stderr}`.trim()
    return { loggedIn: result.code === 0 && !/not logged in/i.test(text), detail: text || null }
  },
  gemini: async () => {
    if (process.env.GEMINI_API_KEY) return { loggedIn: true, detail: 'GEMINI_API_KEY' }
    const ok = await access(join(homedir(), '.gemini/oauth_creds.json')).then(
      () => true,
      () => false,
    )
    return ok ? { loggedIn: true, detail: 'Google login' } : { loggedIn: null, detail: null }
  },
}

async function detect(id: AgentId): Promise<AgentStatus> {
  const path = await which(id)
  if (!path) {
    return { id, installed: false, path: null, version: null, loggedIn: null, detail: null }
  }
  const [version, login] = await Promise.all([
    run(id, ['--version'], { timeout: 15_000 }),
    loginChecks[id](),
  ])
  return {
    id,
    installed: true,
    path,
    version: version.code === 0 ? version.stdout.trim().split('\n')[0] || null : null,
    ...login,
  }
}

export function detectAgents() {
  return Promise.all(agentIds.map(detect))
}

function appleScriptString(value: string) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export async function openAgentTerminal(id: AgentId, action: 'install' | 'login') {
  const command = agentCommands[id][action]
  const result = await run('/usr/bin/osascript', [
    '-e',
    `tell application "Terminal" to do script ${appleScriptString(command)}`,
    '-e',
    'tell application "Terminal" to activate',
  ])
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Could not open Terminal')
}
