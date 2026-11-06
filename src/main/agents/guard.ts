import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const ghReadSubcommands = new Map<string, string[]>([
  ['pr', ['view', 'diff', 'checks', 'list', 'status']],
  ['issue', ['view', 'list', 'status']],
  ['repo', ['view', 'list']],
  ['run', ['view', 'list']],
  ['release', ['view', 'list']],
  ['search', ['prs', 'issues', 'repos', 'code', 'commits']],
  ['auth', ['status']],
])

const ghLeadingFlags = ['--version', '--help', '-h']

type ApiFlag = 'boolean' | 'method' | 'field' | 'value' | 'input'

const apiShortFlags = new Map<string, ApiFlag>([
  ['i', 'boolean'],
  ['X', 'method'],
  ['f', 'field'],
  ['F', 'field'],
  ['H', 'value'],
  ['q', 'value'],
  ['t', 'value'],
  ['p', 'value'],
])

const apiLongFlags = new Map<string, ApiFlag>([
  ['include', 'boolean'],
  ['paginate', 'boolean'],
  ['slurp', 'boolean'],
  ['silent', 'boolean'],
  ['verbose', 'boolean'],
  ['method', 'method'],
  ['raw-field', 'field'],
  ['field', 'field'],
  ['header', 'value'],
  ['jq', 'value'],
  ['template', 'value'],
  ['preview', 'value'],
  ['hostname', 'value'],
  ['cache', 'value'],
  ['input', 'input'],
])

const valueKinds: ApiFlag[] = ['method', 'field', 'value']

const isGet = (method: string) => /^[Gg][Ee][Tt]$/.test(method)
const readsFile = (field: string) => field.startsWith('@') || field.includes('=@')
const isMutation = (field: string) => field.toLowerCase().includes('mutation')

function ghApiBlockReason(args: string[]): string | null {
  let endpoint: string | undefined
  let methodSet = false
  let badMethod: string | undefined
  const fields: string[] = []
  const take = (kind: ApiFlag, value: string) => {
    if (kind === 'method') {
      methodSet = true
      if (!isGet(value)) badMethod ??= value.toUpperCase()
    }
    if (kind === 'field') fields.push(value)
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg.startsWith('--')) {
      const split = arg.indexOf('=')
      const name = split === -1 ? arg.slice(2) : arg.slice(2, split)
      const kind = apiLongFlags.get(name)
      if (kind === undefined) return `gh api --${name} is blocked`
      if (kind === 'input') return 'gh api --input is blocked'
      if (kind === 'boolean') continue
      if (split !== -1) take(kind, arg.slice(split + 1))
      else if (index + 1 < args.length) take(kind, args[++index]!)
      else return `gh api --${name} needs a value`
      continue
    }
    if (arg.startsWith('-') && arg !== '-') {
      let rest = arg.slice(1)
      while (rest) {
        const flag = rest[0]!
        rest = rest.slice(1)
        const kind = apiShortFlags.get(flag)
        if (kind === undefined) return `gh api -${flag} is blocked`
        if (kind === 'boolean') continue
        if (rest) {
          take(kind, rest.length > 1 && rest.startsWith('=') ? rest.slice(1) : rest)
          rest = ''
        } else if (index + 1 < args.length) take(kind, args[++index]!)
        else return `gh api -${flag} needs a value`
      }
      continue
    }
    endpoint ??= arg
  }
  if (endpoint === 'graphql') {
    if (fields.some(readsFile)) return 'gh api graphql cannot read fields from files or stdin'
    if (fields.some(isMutation)) return 'GraphQL mutations are blocked'
    return null
  }
  if (badMethod) return `gh api ${badMethod} is blocked`
  if (fields.length > 0 && !methodSet) return 'gh api with fields defaults to POST and is blocked'
  return null
}

const showsToken = (arg: string) =>
  arg.startsWith('--show-token') ||
  (!arg.startsWith('--') && arg.startsWith('-') && arg.includes('t'))

export function ghBlockReason(args: string[]): string | null {
  let index = 0
  while (index < args.length && args[index]!.startsWith('-')) {
    if (!ghLeadingFlags.includes(args[index]!)) return `gh ${args[index]} is blocked`
    index += 1
  }
  if (index === args.length) return null
  const command = args[index]!
  const rest = args.slice(index + 1)
  if (command === 'version') return null
  if (command === 'api') return ghApiBlockReason(rest)
  const allowed = ghReadSubcommands.get(command)
  if (!allowed) return `gh ${command} is blocked`
  const sub = rest[0]
  if (sub === undefined || !allowed.includes(sub))
    return `gh ${command} ${sub ?? ''} is blocked`.trim()
  if (command === 'auth' && rest.slice(1).some(showsToken)) {
    return 'gh auth status --show-token is blocked'
  }
  return null
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const flagsOf = <T>(flags: Map<string, T>, kind: T) =>
  [...flags].filter(([, value]) => value === kind).map(([name]) => name)

function ghShimApiCases() {
  const long = (kind: ApiFlag) => flagsOf(apiLongFlags, kind).map((name) => `--${name}`)
  const bareOrAttached = (kind: ApiFlag) =>
    long(kind)
      .flatMap((flag) => [flag, `${flag}=*`])
      .join('|')
  return [
    `      ${bareOrAttached('input')}) deny ;;`,
    `      ${bareOrAttached('boolean')}) ;;`,
    ...valueKinds.map(
      (kind) =>
        `      ${long(kind)
          .map((flag) => `${flag}=*`)
          .join('|')}) api_value ${kind} "\${arg#*=}" ;;`,
    ),
    ...valueKinds.map((kind) => `      ${long(kind).join('|')}) pending=${kind} ;;`),
  ].join('\n')
}

function ghShimShortCases() {
  return (['boolean', ...valueKinds] as ApiFlag[])
    .map((kind) => `            ${flagsOf(apiShortFlags, kind).join('|')}) kind=${kind} ;;`)
    .join('\n')
}

export function ghShimScript(realGh: string) {
  const reads = [...ghReadSubcommands]
    .map(
      ([command, subs]) => `    ${command}) case "$1" in ${subs.join('|')}) ;; *) deny ;; esac ;;`,
    )
    .join('\n')
  return `#!/bin/sh
deny() {
  echo "PRism: this gh command is blocked for agents. GitHub access is read-only; PRism posts after the user confirms." >&2
  exit 1
}
api_value() {
  case "$1" in
    method)
      method_set=1
      case "$2" in [Gg][Ee][Tt]) ;; *) bad_method=1 ;; esac ;;
    field)
      fields=1
      case "$2" in @*|*=@*) file_value=1 ;; esac
      case "$2" in *[Mm][Uu][Tt][Aa][Tt][Ii][Oo][Nn]*) mutation=1 ;; esac ;;
  esac
}
check_api() {
  endpoint=""; endpoint_set=0; pending=""; method_set=0; bad_method=0; fields=0; file_value=0; mutation=0
  for arg in "$@"; do
    if [ -n "$pending" ]; then
      api_value "$pending" "$arg"
      pending=""
      continue
    fi
    case "$arg" in
${ghShimApiCases()}
      --*) deny ;;
      -) if [ "$endpoint_set" = 0 ]; then endpoint=$arg; endpoint_set=1; fi ;;
      -*)
        rest=\${arg#-}
        while [ -n "$rest" ]; do
          flag=\${rest%"\${rest#?}"}
          rest=\${rest#?}
          case "$flag" in
${ghShimShortCases()}
            *) deny ;;
          esac
          if [ "$kind" = boolean ]; then continue; fi
          if [ -z "$rest" ]; then
            pending=$kind
          else
            case "$rest" in =?*) rest=\${rest#=} ;; esac
            api_value "$kind" "$rest"
            rest=""
          fi
        done ;;
      *) if [ "$endpoint_set" = 0 ]; then endpoint=$arg; endpoint_set=1; fi ;;
    esac
  done
  if [ -n "$pending" ]; then deny; fi
  if [ "$endpoint" = graphql ]; then
    if [ "$file_value" = 1 ] || [ "$mutation" = 1 ]; then deny; fi
  else
    if [ "$bad_method" = 1 ]; then deny; fi
    if [ "$fields" = 1 ] && [ "$method_set" = 0 ]; then deny; fi
  fi
}
check_auth() {
  for arg in "$@"; do
    case "$arg" in
      --show-token*) deny ;;
      --*) ;;
      -*t*) deny ;;
    esac
  done
}
check() {
  while [ $# -gt 0 ]; do
    case "$1" in
      ${ghLeadingFlags.join('|')}) shift ;;
      -*) deny ;;
      *) break ;;
    esac
  done
  if [ $# -eq 0 ]; then return 0; fi
  cmd=$1
  shift
  case "$cmd" in
    version) ;;
${reads}
    api) check_api "$@" ;;
    *) deny ;;
  esac
  if [ "$cmd" = auth ]; then
    shift
    check_auth "$@"
  fi
}
check "$@"
exec ${shellQuote(realGh)} "$@"
`
}

interface Word {
  kind: 'word'
  text: string
  dynamic: boolean
  quoted: boolean
  commands: Token[][]
}

interface Operator {
  kind: 'op' | 'redirect'
  text: string
}

type Token = Word | Operator

const separators = ['&&', '||', ';;', '|&', ';', '&', '|', '(', ')']
const redirections = ['&>>', '<<<', '<<-', '&>', '>>', '>|', '>&', '<&', '<>', '<<', '>', '<']
const maxNesting = 32
const variableName = /[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]/y
const fdPrefix = /^(\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/

const newWord = (): Word => ({
  kind: 'word',
  text: '',
  dynamic: false,
  quoted: false,
  commands: [],
})

function lex(src: string, start = 0, nested = false, level = 0): { tokens: Token[]; end: number } {
  if (level > maxNesting) throw new Error('Command is nested too deeply')
  const tokens: Token[] = []
  const heredocs: { delimiter: string; strip: boolean }[] = []
  let delimiterStrip = null as boolean | null
  let word = null as Word | null
  let glob = -1
  let brace = -1
  let depth = 0
  let index = start

  const current = () => (word ??= newWord())

  const flush = () => {
    const done = word
    word = null
    glob = -1
    brace = -1
    if (!done) return
    if (delimiterStrip !== null) {
      heredocs.push({ delimiter: done.text, strip: delimiterStrip })
      delimiterStrip = null
    }
    if (!done.quoted && (done.text === '{' || done.text === '}')) {
      tokens.push({ kind: 'op', text: done.text })
    } else tokens.push(done)
  }

  const push = (kind: Operator['kind'], text: string) => {
    flush()
    delimiterStrip = null
    tokens.push({ kind, text })
  }

  const dropFdPrefix = () => {
    if (word && !word.quoted && !word.dynamic && fdPrefix.test(word.text)) {
      word = null
      glob = -1
      brace = -1
    }
  }

  const appendPlain = (char: string) => {
    const target = current()
    if (char === '*' || char === '?') target.dynamic = true
    if (char === '[') glob = target.text.length
    if (char === ']' && glob !== -1) target.dynamic = true
    if (char === '{') brace = target.text.length
    if (char === '}' && brace !== -1 && /,|\.\./.test(target.text.slice(brace))) {
      target.dynamic = true
    }
    target.text += char
  }

  const readNested = (from: number, target: Word, prefix: number) => {
    const inner = lex(src, from, true, level + 1)
    target.dynamic = true
    target.commands.push(inner.tokens)
    target.text += src.slice(from - prefix, inner.end + 1)
    return inner.end + 1
  }

  const readBacktick = (from: number, target: Word) => {
    let at = from
    let body = ''
    while (at < src.length && src[at] !== '`') {
      const after = src[at + 1]
      if (src[at] === '\\' && after !== undefined && '`\\$'.includes(after)) {
        body += after
        at += 2
      } else {
        body += src[at]
        at += 1
      }
    }
    target.dynamic = true
    target.commands.push(lex(body, 0, false, level + 1).tokens)
    target.text += `\`${body}\``
    return at + 1
  }

  const readDouble = (from: number, target: Word) => {
    target.quoted = true
    let at = from
    while (at < src.length) {
      const char = src[at]!
      if (char === '"') return at + 1
      if (char === '\\') {
        const after = src[at + 1]
        if (after === '\n') at += 2
        else if (after !== undefined && '$`"\\'.includes(after)) {
          target.text += after
          at += 2
        } else {
          target.text += char
          at += 1
        }
      } else if (char === '$') at = readDollar(at, target)
      else if (char === '`') at = readBacktick(at + 1, target)
      else {
        target.text += char
        at += 1
      }
    }
    return at
  }

  const braceEnd = (from: number) => {
    let at = from
    let open = 1
    while (at < src.length) {
      const char = src[at]!
      if (char === '\\') at += 2
      else if (char === "'") {
        const end = src.indexOf("'", at + 1)
        at = end === -1 ? src.length : end + 1
      } else if (char === '"') at = readDouble(at + 1, newWord())
      else if (char === '`') at = readBacktick(at + 1, newWord())
      else if (char === '$' && src[at + 1] === '(') at = lex(src, at + 2, true, level + 1).end + 1
      else if (char === '$' && src[at + 1] === '{') {
        open += 1
        at += 2
      } else if (char === '}') {
        open -= 1
        if (open === 0) return at
        at += 1
      } else at += 1
    }
    return src.length
  }

  function readDollar(at: number, target: Word): number {
    target.dynamic = true
    const after = src[at + 1]
    if (after === '(') return readNested(at + 2, target, 2)
    if (after === '{') {
      const end = braceEnd(at + 2)
      target.commands.push(lex(src.slice(at + 2, end), 0, false, level + 1).tokens)
      target.text += src.slice(at, end + 1)
      return end + 1
    }
    variableName.lastIndex = at + 1
    const name = variableName.exec(src)?.[0] ?? ''
    target.text += `$${name}`
    return at + 1 + name.length
  }

  const readAnsiC = (from: number, target: Word) => {
    target.quoted = true
    target.dynamic = true
    let at = from
    let body = ''
    while (at < src.length && src[at] !== "'") {
      const step = src[at] === '\\' ? 2 : 1
      body += src.slice(at, at + step)
      at += step
    }
    target.text += `$'${body}'`
    return at + 1
  }

  const readHeredocs = (from: number) => {
    let at = from
    for (const { delimiter, strip } of heredocs.splice(0)) {
      while (at < src.length) {
        const end = src.indexOf('\n', at)
        const stop = end === -1 ? src.length : end
        const line = src.slice(at, stop)
        at = stop + 1
        if ((strip ? line.replace(/^\t+/, '') : line) === delimiter) break
        tokens.push(...lex(line, 0, false, level + 1).tokens, { kind: 'op', text: '\n' })
      }
    }
    return Math.min(at, src.length)
  }

  while (index < src.length) {
    const char = src[index]!
    const next = src[index + 1]
    if (char === '\\') {
      if (next === '\n') {
        index += 2
        continue
      }
      const target = current()
      target.quoted = true
      target.text += next ?? char
      index += next === undefined ? 1 : 2
    } else if (char === "'") {
      const end = src.indexOf("'", index + 1)
      const stop = end === -1 ? src.length : end
      const target = current()
      target.quoted = true
      target.text += src.slice(index + 1, stop)
      index = stop + 1
    } else if (char === '"') index = readDouble(index + 1, current())
    else if (char === '$' && next === "'") index = readAnsiC(index + 2, current())
    else if (char === '$' && next === '"') {
      const target = current()
      target.dynamic = true
      index = readDouble(index + 2, target)
    } else if (char === '$') index = readDollar(index, current())
    else if (char === '`') index = readBacktick(index + 1, current())
    else if (char === '#' && word === null) {
      while (index < src.length && src[index] !== '\n') index += 1
    } else if (char === '\n' || char === '\r') {
      push('op', '\n')
      index += 1
      if (char === '\n' && heredocs.length > 0) index = readHeredocs(index)
    } else if (char === ' ' || char === '\t') {
      flush()
      index += 1
    } else if ((char === '<' || char === '>') && next === '(') {
      index = readNested(index + 2, current(), 2)
    } else {
      const redirection = redirections.find((op) => src.startsWith(op, index))
      const separator = redirection ? undefined : separators.find((op) => src.startsWith(op, index))
      if (redirection) {
        dropFdPrefix()
        push('redirect', redirection)
        if (redirection === '<<' || redirection === '<<-') delimiterStrip = redirection === '<<-'
        index += redirection.length
      } else if (separator) {
        if (nested && separator === ')') {
          if (depth === 0) {
            flush()
            return { tokens, end: index }
          }
          depth -= 1
        }
        if (nested && separator === '(') depth += 1
        push('op', separator)
        index += separator.length
      } else {
        appendPlain(char)
        index += 1
      }
    }
  }
  flush()
  return { tokens, end: index }
}

export function tokenize(command: string) {
  return lex(command).tokens.map((token) => token.text)
}

const dynamicCommand =
  'PRism cannot check commands built at run time ($VAR, $(…), backticks, globs). Run the command by name with literal arguments.'
const dynamicGit = 'PRism cannot check git arguments built at run time. Use literal arguments.'
const dynamicGh = 'PRism cannot check gh arguments built at run time. Use literal arguments.'
const stdinShell = 'Running a script from stdin is blocked. Run the commands directly.'
const envSplit = 'env --split-string is blocked. Run the command directly.'

const assignment = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/
const prefixWords = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'coproc'])
const shells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh'])

const commandName = (text: string) => (text.split('/').at(-1) ?? '').replace(/^=/, '').toLowerCase()
const isPrefixOf = (name: string, options: string[]) =>
  name.length > 0 && options.some((option) => option.startsWith(name))
const longName = (arg: string) => arg.slice(2).split('=')[0]!
const isShortCluster = (arg: string) => /^-[^-]/.test(arg)
const readsStdin = (path: string) => path === '/dev/stdin' || path.startsWith('/dev/fd/')

function splitSegments(tokens: Token[]) {
  const segments: { words: Word[]; all: Word[] }[] = [{ words: [], all: [] }]
  let target = false
  for (const token of tokens) {
    const segment = segments.at(-1)!
    if (token.kind === 'word') {
      segment.all.push(token)
      if (target) target = false
      else segment.words.push(token)
    } else if (token.kind === 'redirect') target = true
    else {
      segments.push({ words: [], all: [] })
      target = false
    }
  }
  return segments
}

function skipOptions(args: Word[], short = '', long: string[] = []): Word[] | string {
  let index = 0
  while (index < args.length) {
    const word = args[index]!
    if (word.dynamic) return dynamicCommand
    const text = word.text
    if (text === '--') return args.slice(index + 1)
    if (!text.startsWith('-') || text === '-') break
    let width = 1
    if (text.startsWith('--')) {
      if (!text.includes('=') && isPrefixOf(longName(text), long)) width = 2
    } else {
      const valueAt = text.split('').findIndex((flag) => short.includes(flag))
      if (valueAt === text.length - 1) width = 2
    }
    if (width === 2 && args[index + 1]?.dynamic) return dynamicCommand
    index += width
  }
  return args.slice(index)
}

function envArgs(args: Word[]): Word[] | string {
  let index = 0
  while (index < args.length) {
    const word = args[index]!
    const text = word.text
    let width = 1
    if (!assignment.test(text) && text !== '--' && text !== '-') {
      if (word.dynamic) return dynamicCommand
      if (text.startsWith('--')) {
        if (isPrefixOf(longName(text), ['split-string'])) return envSplit
        if (!text.includes('=') && isPrefixOf(longName(text), ['unset', 'chdir', 'argv0']))
          width = 2
      } else if (text.startsWith('-')) {
        const valueAt = text.split('').findIndex((flag) => 'LUPSuaC'.includes(flag))
        if (text[valueAt] === 'S') return envSplit
        if (valueAt === text.length - 1) width = 2
      } else break
    }
    if (width === 2 && args[index + 1]?.dynamic) return dynamicCommand
    index += width
  }
  return args.slice(index)
}

function timeoutArgs(args: Word[]): Word[] | string {
  const rest = skipOptions(args, 'sk', ['signal', 'kill-after'])
  if (typeof rest === 'string') return rest
  if (rest[0]?.dynamic) return dynamicCommand
  return rest.slice(1)
}

function xargsArgs(args: Word[]): Word[] | string {
  let replace: string | undefined
  let index = 0
  while (index < args.length) {
    const word = args[index]!
    if (word.dynamic) return dynamicCommand
    const text = word.text
    if (text === '--') {
      index += 1
      break
    }
    if (!text.startsWith('-') || text === '-') break
    let width = 1
    if (text.startsWith('--')) {
      const split = text.indexOf('=')
      const name = longName(text)
      if (isPrefixOf(name, ['replace'])) replace = split === -1 ? '{}' : text.slice(split + 1)
      else if (
        split === -1 &&
        isPrefixOf(name, ['arg-file', 'delimiter', 'max-args', 'max-procs', 'max-chars'])
      ) {
        width = 2
      }
    } else {
      const valueAt = text.split('').findIndex((flag) => 'ILnPsEdaJRSile'.includes(flag))
      const flag = text[valueAt]
      if (flag !== undefined) {
        const attached = text.slice(valueAt + 1)
        const optional = 'ile'.includes(flag)
        if (!attached && !optional) width = 2
        if (flag === 'I' || flag === 'J') replace = attached || args[index + 1]?.text
        if (flag === 'i') replace = attached || '{}'
      }
    }
    if (width === 2 && args[index + 1]?.dynamic) return dynamicCommand
    index += width
  }
  const command = args.slice(index)
  if (command.length === 0) return command
  if (replace === undefined) return [...command, { ...newWord(), text: '{}', dynamic: true }]
  const marker = replace
  return command.map((word) =>
    marker && word.text.includes(marker) ? { ...word, dynamic: true } : word,
  )
}

function npxArgs(args: Word[]): Word[] | string {
  let index = 0
  while (index < args.length) {
    const word = args[index]!
    if (word.dynamic) return dynamicCommand
    const text = word.text
    if (text === '--') return args.slice(index + 1)
    if (!text.startsWith('-') || text === '-') break
    const split = text.indexOf('=')
    const name = text.startsWith('--') ? longName(text) : ''
    if (text === '-c' || name === 'call') {
      const script = split === -1 ? args[index + 1] : { ...word, text: text.slice(split + 1) }
      const shell = (value: string) => ({ ...newWord(), text: value })
      return script ? [shell('sh'), shell('-c'), script] : []
    }
    index += text === '-p' || (name === 'package' && split === -1) ? 2 : 1
  }
  return args.slice(index)
}

const wrappers = new Map<string, (args: Word[]) => Word[] | string>([
  ['env', envArgs],
  ['command', (args) => skipOptions(args)],
  ['builtin', (args) => skipOptions(args)],
  ['exec', (args) => skipOptions(args, 'a')],
  ['nice', (args) => skipOptions(args, 'n', ['adjustment'])],
  ['nohup', (args) => skipOptions(args)],
  ['time', (args) => skipOptions(args, 'of', ['format', 'output'])],
  ['timeout', timeoutArgs],
  [
    'sudo',
    (args) =>
      skipOptions(args, 'CDgprtTUuR', [
        'close-from',
        'chdir',
        'group',
        'prompt',
        'chroot',
        'role',
        'type',
        'command-timeout',
        'other-user',
        'user',
      ]),
  ],
  ['xargs', xargsArgs],
  ['npx', npxArgs],
])

function unwrap(segment: Word[]): Word[] | string {
  let words = segment
  for (;;) {
    const head = words[0]
    if (!head) return words
    if (assignment.test(head.text) || (!head.dynamic && prefixWords.has(head.text))) {
      words = words.slice(1)
      continue
    }
    if (head.dynamic) return words
    const wrapper = wrappers.get(commandName(head.text))
    if (!wrapper) return words
    const next = wrapper(words.slice(1))
    if (typeof next === 'string') return next
    words = next
  }
}

function shellBlockReason(args: Word[], readOnly: boolean, depth: number): string | null {
  const scripts: Word[] = []
  let command = false
  let stdin = false
  let index = 0
  while (index < args.length) {
    const word = args[index]!
    if (word.dynamic) return dynamicCommand
    const text = word.text
    if (text === '--' || text === '-') {
      index += 1
      break
    }
    if (!/^[-+]./.test(text)) break
    index += 1
    if (text.startsWith('--')) {
      const split = text.indexOf('=')
      const name = longName(text)
      if (name === 'command' && split !== -1) scripts.push({ ...word, text: text.slice(split + 1) })
      else if (name === 'command') command = true
      else if (split === -1 && (name === 'rcfile' || name === 'init-file')) index += 1
      continue
    }
    const flags = text.slice(1)
    if (flags.includes('c')) command = true
    if (flags.includes('s')) stdin = true
    const values = flags.split('').filter((flag) => flag === 'o' || flag === 'O').length
    if (args.slice(index, index + values).some((value) => value.dynamic)) return dynamicCommand
    index += values
  }
  const rest = args.slice(index)
  if (command && rest[0]) scripts.push(rest[0])
  if (!command && scripts.length === 0 && (stdin || !rest[0] || readsStdin(rest[0].text))) {
    return stdinShell
  }
  for (const script of scripts) {
    if (script.dynamic) return dynamicCommand
    const reason = scriptBlockReason(script.text, readOnly, depth + 1)
    if (reason) return reason
  }
  return null
}

const gitReadCommands = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'grep',
  'ls-files',
  'ls-tree',
  'ls-remote',
  'rev-parse',
  'rev-list',
  'merge-base',
  'describe',
  'shortlog',
  'cat-file',
  'show-ref',
  'for-each-ref',
  'name-rev',
  'range-diff',
  'cherry',
  'whatchanged',
  'diff-tree',
  'diff-index',
  'diff-files',
  'format-patch',
  'fetch',
  'check-ignore',
  'check-attr',
  'count-objects',
  'fsck',
  'verify-commit',
  'verify-tag',
  'var',
  'version',
  'help',
  'reflog',
  'branch',
  'tag',
  'remote',
  'config',
  'worktree',
  'stash',
  'submodule',
  'lfs',
  'notes',
])
const gitEditCommands = new Set(['add', 'rm', 'mv', 'apply', 'restore'])
const gitGlobalFlags = new Set(['--no-pager', '-P', '--literal-pathspecs', '--no-optional-locks'])
const gitGlobalValues = new Set(['-C', '-c', '--git-dir', '--work-tree'])
const gitSubcommandAliases = new Map([
  ['--version', 'version'],
  ['-v', 'version'],
  ['--help', 'help'],
  ['-h', 'help'],
])

interface ListRules {
  short: string
  long: string[]
  listShort: string
  values: string[]
}

const listFlags = ['list', 'contains', 'no-contains', 'merged', 'no-merged', 'points-at']

const branchRules: ListRules = {
  short: 'dDmMcCfut',
  long: [
    'delete',
    'move',
    'copy',
    'force',
    'set-upstream-to',
    'set-upstream',
    'unset-upstream',
    'edit-description',
    'track',
    'no-track',
    'create-reflog',
    'recurse-submodules',
  ],
  listShort: 'l',
  values: ['sort', 'format', 'points-at'],
}

const tagRules: ListRules = {
  short: 'dasufmFe',
  long: [
    'delete',
    'annotate',
    'sign',
    'no-sign',
    'local-user',
    'force',
    'message',
    'file',
    'edit',
    'cleanup',
    'create-reflog',
    'trailer',
  ],
  listShort: 'ln',
  values: ['sort', 'format', 'points-at'],
}

function listOnlyReason(command: string, args: string[], rules: ListRules): string | null {
  let list = false
  let named = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--') {
      named ||= index + 1 < args.length
      break
    }
    if (arg.startsWith('--')) {
      const name = longName(arg)
      if (isPrefixOf(name, rules.long)) return `git ${command} --${name} is blocked`
      if (listFlags.includes(name)) list = true
      if (rules.values.includes(name) && !arg.includes('=')) index += 1
    } else if (isShortCluster(arg)) {
      const flag = arg.split('').find((char) => rules.short.includes(char))
      if (flag) return `git ${command} -${flag} is blocked`
      if (arg.split('').some((char) => rules.listShort.includes(char))) list = true
    } else named = true
  }
  return named && !list ? `git ${command} with a name is blocked: only listing is allowed` : null
}

const firstArgIn = (command: string, allowed: string[]) => (args: string[]) =>
  allowed.includes(args[0] ?? '')
    ? null
    : `${['git', command, ...args.slice(0, 1)].join(' ')} is blocked`

const longOptionIn = (args: string[], options: string[], minimum = 1) =>
  args.some(
    (arg) =>
      arg.startsWith('--') && longName(arg).length >= minimum && isPrefixOf(longName(arg), options),
  )

const configModes = ['--get', '--get-all', '--get-regexp', '--list', '-l']
const configFlags = ['--show-origin', '--show-scope', '--global', '--local']

const gitArgChecks = new Map<string, (args: string[]) => string | null>([
  ['branch', (args) => listOnlyReason('branch', args, branchRules)],
  ['tag', (args) => listOnlyReason('tag', args, tagRules)],
  [
    'reflog',
    (args) => {
      const sub = args.find((arg) => ['expire', 'delete', 'drop', 'write'].includes(arg))
      return sub ? `git reflog ${sub} is blocked` : null
    },
  ],
  [
    'remote',
    (args) => {
      let index = 0
      while (args[index] === '-v' || args[index] === '--verbose') index += 1
      const sub = args[index]
      return sub === undefined || sub === 'show' || sub === 'get-url'
        ? null
        : `git remote ${sub} is blocked`
    },
  ],
  [
    'config',
    (args) => {
      const option = args.find(
        (arg) => arg.startsWith('-') && !configModes.includes(arg) && !configFlags.includes(arg),
      )
      if (option) return `git config ${option} is blocked`
      if (args.some((arg) => configModes.includes(arg))) return null
      return args.filter((arg) => !arg.startsWith('-')).length === 1
        ? null
        : 'git config is limited to reads (--get, --list, or a single key)'
    },
  ],
  ['worktree', firstArgIn('worktree', ['list'])],
  ['stash', firstArgIn('stash', ['list', 'show'])],
  ['submodule', firstArgIn('submodule', ['status'])],
  ['lfs', firstArgIn('lfs', ['ls-files', 'status', 'env'])],
  ['notes', firstArgIn('notes', ['list', 'show'])],
  [
    'restore',
    (args) => {
      const staged = args.some(
        (arg) => arg === '--staged' || (isShortCluster(arg) && arg.includes('S')),
      )
      const worktree =
        longOptionIn(args, ['worktree']) ||
        args.some((arg) => isShortCluster(arg) && arg.includes('W'))
      return staged && !worktree ? null : 'git restore is limited to --staged'
    },
  ],
  [
    'fetch',
    (args) => (longOptionIn(args, ['upload-pack']) ? 'git fetch --upload-pack is blocked' : null),
  ],
  [
    'ls-remote',
    (args) =>
      longOptionIn(args, ['upload-pack', 'exec']) ? 'git ls-remote --upload-pack is blocked' : null,
  ],
  [
    'grep',
    (args) =>
      longOptionIn(args, ['open-files-in-pager'], 2) ||
      args.some((arg) => isShortCluster(arg) && arg.includes('O'))
        ? 'git grep --open-files-in-pager is blocked'
        : null,
  ],
])

function gitConfigReason(entry: string) {
  const key = entry.split('=')[0]!
  const lower = key.toLowerCase()
  const blocked =
    lower.startsWith('alias.') ||
    lower === 'core.hookspath' ||
    lower === 'include.path' ||
    lower.startsWith('includeif.')
  return blocked ? `git -c ${key} is blocked` : null
}

function gitBlockReason(args: Word[], readOnly: boolean): string | null {
  if (args.some((word) => word.text === '--no-verify')) return 'git --no-verify is blocked'
  let index = 0
  while (index < args.length) {
    const word = args[index]!
    if (word.dynamic) return dynamicGit
    const text = word.text
    if (gitGlobalValues.has(text)) {
      const value = args[index + 1]
      if (value?.dynamic) return dynamicGit
      const reason = text === '-c' && value ? gitConfigReason(value.text) : null
      if (reason) return reason
      index += 2
    } else if (text === '--config-env' || text.startsWith('--config-env=')) {
      return 'git --config-env is blocked'
    } else if (text === '--exec-path' || text.startsWith('--exec-path=')) {
      return 'git --exec-path is blocked'
    } else if (gitGlobalFlags.has(text) || /^--(git-dir|work-tree)=/.test(text)) index += 1
    else break
  }
  const subcommand = args[index]
  if (!subcommand) return null
  const sub = gitSubcommandAliases.get(subcommand.text) ?? subcommand.text
  if (!gitReadCommands.has(sub) && !gitEditCommands.has(sub)) {
    return `git ${sub} is blocked: agents never commit, push or rewrite history`
  }
  if (readOnly && gitEditCommands.has(sub)) return `git ${sub} is not allowed in a read-only stage`
  const check = gitArgChecks.get(sub)
  if (!check) return null
  const rest = args.slice(index + 1)
  if (rest.some((word) => word.dynamic)) return dynamicGit
  return check(rest.map((word) => word.text))
}

function segmentBlockReason(segment: Word[], readOnly: boolean, depth: number): string | null {
  const words = unwrap(segment)
  if (typeof words === 'string') return words
  const [head, ...args] = words
  if (!head) return null
  if (head.dynamic) return dynamicCommand
  const name = commandName(head.text)
  if (name === 'git') return gitBlockReason(args, readOnly)
  if (name === 'gh') {
    if (args.some((word) => word.dynamic)) return dynamicGh
    return ghBlockReason(args.map((word) => word.text))
  }
  if (name === 'eval') return 'eval is blocked. Run the command directly.'
  if (shells.has(name)) return shellBlockReason(args, readOnly, depth)
  if ((name === 'source' || name === '.') && args[0] && readsStdin(args[0].text)) return stdinShell
  return null
}

function tokensBlockReason(tokens: Token[], readOnly: boolean, depth: number): string | null {
  if (depth > maxNesting) return 'This command is nested too deeply for PRism to check'
  for (const { words, all } of splitSegments(tokens)) {
    for (const word of all) {
      for (const inner of word.commands) {
        const nestedReason = tokensBlockReason(inner, readOnly, depth + 1)
        if (nestedReason) return nestedReason
      }
    }
    const reason = segmentBlockReason(words, readOnly, depth)
    if (reason) return reason
  }
  return null
}

function scriptBlockReason(script: string, readOnly: boolean, depth: number): string | null {
  return tokensBlockReason(lex(script).tokens, readOnly, depth)
}

const gitWriteBackstop = /(^|[^\w-])git\s+(?:-\S+\s+)*(commit|push)\b/i

export function commandBlockReason(
  command: string,
  options: { readOnly?: boolean } = {},
): string | null {
  let reason: string | null
  try {
    reason = scriptBlockReason(command, options.readOnly ?? false, 0)
  } catch {
    reason = 'This command is too complex for PRism to check. Split it into simpler commands.'
  }
  if (reason) return reason
  if (gitWriteBackstop.test(command)) return 'git commit/push is blocked'
  return null
}

const editTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function linkTarget(path: string) {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null
  } catch {
    return null
  }
}

function realPath(path: string, links = 0): string {
  try {
    return realpathSync.native(path)
  } catch {
    const parent = dirname(path)
    if (parent === path || links > 40) return path
    const candidate = join(realPath(parent, links), basename(path))
    const target = linkTarget(candidate)
    if (target === null) return candidate
    return realPath(isAbsolute(target) ? target : `${dirname(candidate)}/${target}`, links + 1)
  }
}

function isInside(file: string, worktree: string) {
  const root = realPath(resolve(worktree))
  const candidates = [resolve(worktree, file), isAbsolute(file) ? file : `${worktree}/${file}`]
  return candidates.every((candidate) => {
    const path = relative(root, realPath(candidate))
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  })
}

export function toolBlockReason(
  toolName: string,
  input: Record<string, unknown>,
  options: { readOnly: boolean; worktree: string },
): string | null {
  if (typeof input.command === 'string') {
    const reason = commandBlockReason(input.command, { readOnly: options.readOnly })
    if (reason) return reason
  }
  if (!editTools.has(toolName)) return null
  if (options.readOnly) return 'This stage is read-only: report findings instead of editing files'
  const files = [input.file_path, input.notebook_path].filter(
    (file): file is string => typeof file === 'string',
  )
  if (files.some((file) => !isInside(file, options.worktree))) {
    return 'Edits are limited to the pull request worktree'
  }
  return null
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

const pushBlockedUrls = ['https://', 'http://', 'ssh://', 'git@', 'git://', 'file://', '']

export function pushBlockEnv(base: Record<string, string> = {}): Record<string, string> {
  const existing = Number(base.GIT_CONFIG_COUNT ?? 0)
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(start + pushBlockedUrls.length),
  }
  pushBlockedUrls.forEach((url, offset) => {
    env[`GIT_CONFIG_KEY_${start + offset}`] = 'url.prism-push-blocked://.pushInsteadOf'
    env[`GIT_CONFIG_VALUE_${start + offset}`] = url
  })
  return env
}
