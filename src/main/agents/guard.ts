const ghReadSubcommands: Record<string, string[]> = {
  pr: ['view', 'diff', 'checks', 'list', 'status'],
  issue: ['view', 'list', 'status'],
  repo: ['view', 'list'],
  run: ['view', 'list'],
  release: ['view', 'list'],
  search: ['prs', 'issues', 'repos', 'code', 'commits'],
  auth: ['status'],
}

const fieldFlags = /^(-f|-F|--field|--raw-field|--input)(=|$)|^-[fF].+/

function apiMethod(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '-X' || arg === '--method') return (args[index + 1] ?? '').toUpperCase()
    if (arg.startsWith('--method=')) return arg.slice(9).toUpperCase()
    if (arg.startsWith('-X')) return arg.slice(2).toUpperCase()
  }
  return null
}

export function ghBlockReason(args: string[]): string | null {
  const [command, sub] = args
  if (!command) return null
  if (command === 'api') {
    const endpoint = args.slice(1).find((arg) => !arg.startsWith('-'))
    const method = apiMethod(args)
    if (endpoint === 'graphql') {
      return args.some((arg) => /\bmutation\b/i.test(arg)) ? 'GraphQL mutations are blocked' : null
    }
    if (method && method !== 'GET') return `gh api ${method} is blocked`
    if (!method && args.some((arg) => fieldFlags.test(arg))) {
      return 'gh api with fields defaults to POST and is blocked'
    }
    return null
  }
  if (command.startsWith('-')) return null
  const allowed = ghReadSubcommands[command]
  if (!allowed) return `gh ${command} is blocked`
  if (!sub || !allowed.includes(sub)) return `gh ${command} ${sub ?? ''} is blocked`.trim()
  return null
}

export function tokenize(command: string) {
  const tokens: string[] = []
  let current = ''
  let quote: string | null = null
  let started = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && index + 1 < command.length) {
        current += command[++index]
      } else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && index + 1 < command.length) {
      current += command[++index]
      started = true
      continue
    }
    if (/\s/.test(char) || ';&|()`'.includes(char)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      if (!/\s/.test(char)) tokens.push(char)
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

function segments(tokens: string[]) {
  const result: string[][] = [[]]
  for (const token of tokens) {
    if (token.length === 1 && ';&|()`'.includes(token)) result.push([])
    else result.at(-1)!.push(token)
  }
  return result.filter((segment) => segment.length > 0)
}

const wrappers = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'xargs', 'npx'])

function stripPrefix(segment: string[]) {
  let index = 0
  while (index < segment.length) {
    const token = segment[index]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || wrappers.has(token)) index += 1
    else break
  }
  return segment.slice(index)
}

const gitValueOptions = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

function gitBlockReason(args: string[]) {
  let index = 0
  while (index < args.length && args[index]!.startsWith('-')) {
    index += gitValueOptions.has(args[index]!) ? 2 : 1
  }
  const sub = args[index]
  const rest = args.slice(index + 1)
  if (sub === 'commit' || sub === 'push') return `git ${sub} is blocked`
  if (sub === 'reset' && rest.includes('--hard')) return 'git reset --hard is blocked'
  return null
}

const binary = (token: string) => token.split('/').at(-1)

export function commandBlockReason(command: string): string | null {
  for (const raw of segments(tokenize(command))) {
    const segment = stripPrefix(raw)
    const [head, ...args] = segment
    if (!head) continue
    const name = binary(head)
    const reason =
      name === 'git'
        ? gitBlockReason(args)
        : name === 'gh'
          ? ghBlockReason(args)
          : (name === 'sh' || name === 'bash' || name === 'zsh') && args[0] === '-c' && args[1]
            ? commandBlockReason(args[1])
            : null
    if (reason) return reason
  }
  if (/(^|[^\w-])git\s+(?:-\S+\s+)*(commit|push)\b/.test(command))
    return 'git commit/push is blocked'
  return null
}

const readOnlyTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function toolBlockReason(
  toolName: string,
  input: Record<string, unknown>,
  options: { readOnly: boolean; worktree: string },
): string | null {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return commandBlockReason(input.command)
  }
  if (readOnlyTools.has(toolName)) {
    if (options.readOnly) return 'This stage is read-only: report findings instead of editing files'
    const file = input.file_path ?? input.notebook_path
    if (typeof file === 'string' && !isInside(file, options.worktree)) {
      return 'Edits are limited to the pull request worktree'
    }
  }
  return null
}

function isInside(file: string, dir: string) {
  const base = dir.endsWith('/') ? dir : `${dir}/`
  return file === dir || file.startsWith(base)
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function ghShimScript(realGh: string) {
  const reads = Object.entries(ghReadSubcommands)
    .map(([command, subs]) => `  ${command}) case "$2" in ${subs.join('|')}) ;; *) deny ;; esac ;;`)
    .join('\n')
  return `#!/bin/sh
deny() { echo "PRism: this gh command is blocked for agents. GitHub access is read-only; PRism posts after the user confirms." >&2; exit 1; }
case "$1" in
${reads}
  api)
    graphql=0; method=""; fields=0; prev=""
    for arg in "$@"; do
      case "$prev" in -X|--method) method="$arg" ;; esac
      case "$arg" in
        graphql) graphql=1 ;;
        --method=*) method="\${arg#--method=}" ;;
        -X?*) method="\${arg#-X}" ;;
        -f|-F|--field|--raw-field|--input|--field=*|--raw-field=*|--input=*|-f?*|-F?*) fields=1 ;;
      esac
      if [ "$graphql" = 1 ] && printf '%s' "$arg" | grep -qi 'mutation'; then deny; fi
      prev="$arg"
    done
    method=$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')
    if [ "$graphql" = 0 ]; then
      if [ -n "$method" ] && [ "$method" != GET ]; then deny; fi
      if [ -z "$method" ] && [ "$fields" = 1 ]; then deny; fi
    fi
    ;;
  -*|"") ;;
  *) deny ;;
esac
exec ${shellQuote(realGh)} "$@"
`
}

export function prePushHookScript(nonceFile: string) {
  return `#!/bin/sh
expected=$(cat ${shellQuote(nonceFile)} 2>/dev/null)
if [ -z "$PRISM_PUSH_NONCE" ] || [ "$PRISM_PUSH_NONCE" != "$expected" ]; then
  echo "PRism: push blocked in this worktree. Push from PRism after you confirm." >&2
  exit 1
fi
`
}
