import { join } from 'node:path'
import type { ShellContext } from '../agents/guard'
import { run } from './exec'

const marker = '__PRISM_SHELL_SPLIT__'
const functionMarker = '__PRISM_SHELL_FUNCTION__'
const endMarker = '__PRISM_SHELL_END__'
const maxAliasLines = 1000

const kindOf = (shell: string) =>
  shell.includes('zsh') ? 'zsh' : shell.includes('bash') ? 'bash' : 'sh'

export function agentShell(env: Record<string, string | undefined>) {
  const usable = (shell: string | undefined) => shell && /(^|\/)(zsh|bash)$/.test(shell)
  return [env.CLAUDE_CODE_SHELL, env.SHELL].find(usable) ?? '/bin/zsh'
}

export function rcFile(shell: string, home: string) {
  const kind = kindOf(shell)
  return join(home, kind === 'zsh' ? '.zshrc' : kind === 'bash' ? '.bashrc' : '.profile')
}

function probeScript(shell: string, rc: string) {
  const file = `'${rc.replaceAll("'", "'\\''")}'`
  const kind = kindOf(shell)
  if (kind === 'zsh') {
    return `[ -f ${file} ] && source ${file} >/dev/null 2>&1; print -r -- ${marker}; alias; print -r -- ${marker}; for f in \${(k)functions}; do [[ $f == _[^_]* ]] && continue; autoload +X -- $f 2>/dev/null; print -r -- "${functionMarker} $f"; print -r -- "\${functions[$f]}"; done; print -r -- ${endMarker}`
  }
  if (kind === 'bash') {
    return `shopt -s expand_aliases; [ -f ${file} ] && source ${file} >/dev/null 2>&1; echo ${marker}; alias -p; echo ${marker}; while IFS= read -r f; do [[ $f == _[!_]* ]] && continue; echo "${functionMarker} $f"; declare -f -- "$f" | sed '1,2d;$d'; done < <(compgen -A function); echo ${endMarker}`
  }
  return `[ -f ${file} ] && . ${file} >/dev/null 2>&1; echo ${marker}; alias; echo ${marker}; echo ${endMarker}`
}

function unquote(value: string) {
  let out = ''
  let index = 0
  while (index < value.length) {
    const char = value[index]!
    if (char === "'") {
      const end = value.indexOf("'", index + 1)
      out += value.slice(index + 1, end === -1 ? undefined : end)
      index = end === -1 ? value.length : end + 1
    } else if (char === '$' && value[index + 1] === "'") {
      index += 2
      while (index < value.length && value[index] !== "'") {
        if (value[index] === '\\' && index + 1 < value.length) {
          const next = value[index + 1]!
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next
          index += 2
        } else {
          out += value[index]
          index += 1
        }
      }
      index += 1
    } else if (char === '"') {
      index += 1
      while (index < value.length && value[index] !== '"') {
        if (value[index] === '\\' && index + 1 < value.length) index += 1
        out += value[index]
        index += 1
      }
      index += 1
    } else if (char === '\\' && index + 1 < value.length) {
      out += value[index + 1]
      index += 2
    } else {
      out += char
      index += 1
    }
  }
  return out
}

export function parseAliases(output: string) {
  const aliases = new Map<string, string>()
  for (const line of output.split('\n').slice(0, maxAliasLines)) {
    const match = /^(?:alias\s+(?:--\s+)?)?([^=\s]+)=(.*)$/.exec(line.trim())
    if (match) aliases.set(unquote(match[1]!), unquote(match[2]!))
  }
  return aliases
}

export function parseFunctions(output: string) {
  const functions = new Map<string, string>()
  let name: string | null = null
  let body: string[] = []
  const flush = () => {
    if (name !== null) functions.set(name, body.join('\n'))
  }
  for (const line of output.split('\n')) {
    if (line.startsWith(`${functionMarker} `)) {
      flush()
      name = line.slice(functionMarker.length + 1)
      body = []
    } else if (name !== null) body.push(line)
  }
  flush()
  return functions
}

export async function probeShell(options: {
  shell: string
  home: string
  env?: Record<string, string>
  timeout?: number
}): Promise<ShellContext> {
  const result = await run(
    options.shell,
    ['-c', '-l', probeScript(options.shell, rcFile(options.shell, options.home))],
    { env: { ...options.env, HOME: options.home }, timeout: options.timeout ?? 15_000 },
  )
  const end = result.stdout.lastIndexOf(endMarker)
  if (end === -1) {
    throw new Error(`The shell probe did not finish (exit code ${result.code})`)
  }
  const [, aliasText = '', functionText = ''] = result.stdout.slice(0, end).split(marker)
  return {
    aliases: parseAliases(aliasText.replace(/^\n/, '')),
    functions: parseFunctions(functionText),
  }
}
