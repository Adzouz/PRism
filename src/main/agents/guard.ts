import { lstatSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

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
  let badMethod = false
  let methodName = ''
  const fields: string[] = []
  const take = (kind: ApiFlag, value: string) => {
    if (kind === 'method') {
      methodSet = true
      if (!isGet(value) && !badMethod) {
        badMethod = true
        methodName = value.toUpperCase()
      }
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
  if (badMethod) return `gh api ${methodName || 'with an empty method'} is blocked`
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
  blocked: string | null
  fromAlias?: ReadonlySet<string>
  start?: boolean
  inert?: boolean
  body?: string
}

interface Operator {
  kind: 'op' | 'redirect'
  text: string
}

type Token = Word | Operator

class Refusal extends Error {}

const refuse = (reason: string): never => {
  throw new Refusal(reason)
}

const byLength = (ops: string[]) => ops.sort((a, b) => b.length - a.length)
const separators = byLength(['&&', '||', ';;&', ';;', ';&', ';|', '|&', ';', '&', '|', '(', ')'])
const caseTerminators = new Set([';;', ';;&', ';&', ';|'])
const redirections = byLength([
  '&>>!',
  '&>>|',
  '>>&!',
  '>>&|',
  '&>>',
  '&>!',
  '&>|',
  '>>&',
  '>>!',
  '>>|',
  '>&!',
  '>&|',
  '<<<',
  '<<-',
  '&>',
  '>>',
  '>|',
  '>!',
  '>&',
  '<&',
  '<>',
  '<<',
  '>',
  '<',
])
const maxNesting = 32
const variableName = /[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]/y
const fdPrefix = /^(\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/
const arrayAssignment = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=$/
const prefixWords = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  'coproc',
  'noglob',
  'nocorrect',
  '-',
  'and',
  'or',
  'not',
])
const startKeywords = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  'time',
  'coproc',
])
const declarationBuiltins = new Set([
  'export',
  'declare',
  'typeset',
  'local',
  'readonly',
  'integer',
  'float',
])
const conditionOperators = new Set(['==', '=', '!=', '=~'])
const quoteChars = '\\\'"$`'
const caseEnd = /esac(?=[\s;&|)<>]|$)/y
const numericGlob = /<\d*-\d*>/y

const matchesAt = (pattern: RegExp, text: string, at: number) => {
  pattern.lastIndex = at
  return pattern.test(text)
}

const tooComplex = 'This command is too complex for PRism to check. Split it into simpler commands.'
const tooDeep = 'This command is nested too deeply for PRism to check'
const tooLong =
  'This command is longer than 64 KB. Split it into shorter commands; in stages that can edit, write long content to a file with the Write tool first.'
const carriageReturn =
  'Commands with carriage returns (\\r) are blocked: shells do not read them as line breaks. Use plain newlines.'
const globPattern =
  "PRism cannot check zsh glob qualifiers or patterns like *(…), (a|b), <1-9> or name=(…) here. Quote the pattern, or use [[ … ]], case or find. In a heredoc body, quote the delimiter (<<'EOF')."
const loneBrace =
  'PRism cannot check a lone { or } outside a brace group. End a brace group with "; }", or quote the brace, like "{".'
const substitutionHeredoc =
  "Heredocs inside $(…), backticks or arrays are blocked. Pass the text inline in single quotes, like -f query='…'. For a command that reads a file, write the file first with a top-level heredoc (cat > file <<'EOF')."
const braceSubstitution = 'PRism cannot check ${ …; } command substitutions. Use $(…).'
const casePattern =
  'PRism cannot check this case pattern. Use plain patterns like a|b*) without parentheses, ; or line breaks.'
const conditionPattern =
  'PRism cannot check this [[ … ]] condition. Balance its parentheses, and keep ;, &, <, > and line breaks out of parenthesized patterns.'
const evalExpansion =
  'PRism cannot check expansions that run text as code, like ${(e)…}, ${~…}, globsubst or braceccl. Use plain $VAR.'
const heredocDelimiter =
  "PRism cannot check this heredoc delimiter. Use a plain word like EOF or 'EOF'."

const newWord = (): Word => ({
  kind: 'word',
  text: '',
  dynamic: false,
  quoted: false,
  commands: [],
  blocked: null,
})

function enter(level: number) {
  if (level > maxNesting) throw new Error('Command is nested too deeply')
}

function skipSingle(src: string, from: number) {
  const end = src.indexOf("'", from)
  return end === -1 ? src.length : end + 1
}

function skipContinuations(src: string, from: number) {
  let at = from
  while (src[at] === '\\' && src[at + 1] === '\n') at += 2
  return at
}

const joinContinuations = (text: string) =>
  text.replace(/\\[^]/g, (pair) => (pair === '\\\n' ? '' : pair))

function continuesLine(line: string) {
  let count = 0
  while (line[line.length - 1 - count] === '\\') count += 1
  return count % 2 === 1
}

function skipAnsiC(src: string, from: number) {
  let at = from
  while (at < src.length && src[at] !== "'") at += src[at] === '\\' ? 2 : 1
  return Math.min(at + 1, src.length)
}

function readAnsiC(src: string, at: number, target: Word) {
  const end = skipAnsiC(src, at + 2)
  target.quoted = true
  target.dynamic = true
  target.text += src.slice(at, end)
  return end
}

function readDouble(src: string, from: number, target: Word, level: number): number {
  enter(level)
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
    } else if (char === '$') at = readDollar(src, at, target, level + 1, true)
    else if (char === '`') at = readBacktick(src, at + 1, target, level + 1)
    else {
      target.text += char
      at += 1
    }
  }
  return at
}

function readBacktick(src: string, from: number, target: Word, level: number): number {
  enter(level)
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

function readNested(src: string, at: number, from: number, target: Word, level: number): number {
  const inner = lex(src, from, true, level + 1)
  target.dynamic = true
  target.commands.push(inner.tokens)
  target.text += src.slice(at, inner.end + 1)
  return inner.end + 1
}

function readDollar(src: string, at: number, target: Word, level: number, quoted: boolean): number {
  enter(level)
  target.dynamic = true
  const first = skipContinuations(src, at + 1)
  const after = src[first]
  if (after === '(') {
    const second = skipContinuations(src, first + 1)
    if (src[second] === '(') return readArithmetic(src, at, second + 1, target, level)
    return readNested(src, at, first + 1, target, level)
  }
  if (after === '[') return readArithmetic(src, at, first + 1, target, level)
  if (after === '{') return readParam(src, at, first + 1, target, level, quoted)
  if (after === '~') target.blocked ??= evalExpansion
  variableName.lastIndex = first
  const name = variableName.exec(src)?.[0] ?? ''
  target.text += `$${name}`
  return first + name.length
}

function readParam(
  src: string,
  at: number,
  from: number,
  target: Word,
  level: number,
  quoted: boolean,
): number {
  const scratch = newWord()
  let ambiguous = false
  let index = from
  if (/[ \t\n|<>]/.test(src[skipContinuations(src, from)] ?? ''))
    target.blocked ??= braceSubstitution
  while (index < src.length && src[index] !== '}') {
    const char = src[index]!
    if (char === '\\') index += 2
    else if (char === '{') {
      if (!quoted) ambiguous = true
      index += 1
    } else if (char === "'") {
      if (quoted) ambiguous = true
      index = skipSingle(src, index + 1)
    } else if (char === '"') index = readDouble(src, index + 1, scratch, level + 1)
    else if (char === '`') index = readBacktick(src, index + 1, scratch, level + 1)
    else if (char === '$' && src[index + 1] === "'" && !quoted) index = skipAnsiC(src, index + 2)
    else if (char === '$') index = readDollar(src, index, scratch, level + 1, quoted)
    else index += 1
  }
  const end = Math.min(index, src.length)
  target.dynamic = true
  target.commands.push(...scratch.commands)
  target.blocked ??=
    scratch.blocked ??
    (ambiguous ? tooComplex : paramReason(joinContinuations(src.slice(from, end))))
  target.text += src.slice(at, end + 1)
  return end + 1
}

function paramReason(body: string): string | null {
  const flags = /^\(([^)]*)\)/.exec(body)
  if (flags && /[e%]/.test(flags[1]!)) return evalExpansion
  const rest = flags ? body.slice(flags[0].length) : body
  if (/^[\^=~+#!]*~/.test(rest) || /@P$/.test(rest)) return evalExpansion
  const assigned = /^([\^=~+#!]*)([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?:{0,2}=/.exec(rest)
  if (assigned && (flags?.[1]!.includes('P') || assigned[1]!.includes('!'))) return dynamicName
  return (assigned && variableReason(assigned[2]!, 'bind')) || arithmeticReason(body)
}

function readArithmetic(
  src: string,
  at: number,
  from: number,
  target: Word,
  level: number,
): number {
  enter(level)
  const open = src[from - 1]!
  const close = open === '[' ? ']' : ')'
  const scratch = newWord()
  let blocked: string | null = null
  let depth = 0
  let index = from
  let end = src.length
  while (index < src.length) {
    const char = src[index]!
    if (char === '\\') index += 2
    else if (char === open) {
      depth += 1
      index += 1
    } else if (char === close && depth > 0) {
      depth -= 1
      index += 1
    } else if (char === close) {
      const second = skipContinuations(src, index + 1)
      const double = close === ')' && src[second] === ')'
      if (close === ')' && !double) blocked = tooComplex
      end = double ? second + 1 : index + 1
      break
    } else if (char === "'") {
      blocked = tooComplex
      index = skipSingle(src, index + 1)
    } else if (char === '"') index = readDouble(src, index + 1, scratch, level + 1)
    else if (char === '`') index = readBacktick(src, index + 1, scratch, level + 1)
    else if (char === '$') index = readDollar(src, index, scratch, level + 1, true)
    else index += 1
  }
  const raw = src.slice(at, end)
  target.dynamic = true
  target.commands.push(...scratch.commands)
  target.blocked ??= scratch.blocked ?? blocked ?? arithmeticReason(joinContinuations(raw), true)
  target.text += raw
  return end
}

function heredocWord(text: string, level: number): Word {
  enter(level)
  const body = joinContinuations(text)
  const scratch = newWord()
  let at = 0
  while (at < body.length) {
    const char = body[at]!
    if (char === '\\') at += 2
    else if (char === '$') at = readDollar(body, at, scratch, level + 1, true)
    else if (char === '`') at = readBacktick(body, at + 1, scratch, level + 1)
    else at += 1
  }
  return scratch
}

type CasePhase = 'subject' | 'in' | 'pattern' | 'body'

function lex(
  src: string,
  start = 0,
  nested = false,
  level = 0,
  array = false,
): { tokens: Token[]; end: number } {
  enter(level)
  const tokens: Token[] = []
  const heredocs: { word: Word; strip: boolean }[] = []
  const cases: CasePhase[] = []
  let delimiterStrip = null as boolean | null
  let word = null as Word | null
  let glob = -1
  let brace = -1
  let braceList = false
  let depth = 0
  let index = start
  let commandStart = !array
  let assignments = !array
  let declaring = false
  let condition = false
  let groups = 0
  let operand = false

  const current = () => (word ??= newWord())

  const reset = () => {
    word = null
    glob = -1
    brace = -1
    braceList = false
  }

  const flush = () => {
    const done = word
    reset()
    if (!done) return
    const redirected = tokens.at(-1)?.kind === 'redirect'
    done.start = commandStart && !redirected
    if (delimiterStrip !== null) {
      heredocs.push({ word: done, strip: delimiterStrip })
      delimiterStrip = null
    }
    const text = done.quoted ? null : done.text
    if (text === '{' || text === '}') {
      const keyword = tokens.at(-2)
      const named =
        text === '{' &&
        keyword?.kind === 'word' &&
        keyword.start === true &&
        keyword.text === 'function'
      if (!done.start && !named) refuse(loneBrace)
      push('op', text)
      return
    }
    tokens.push(done)
    if (redirected) {
      commandStart = false
      assignments = false
      return
    }
    if (condition) {
      if (text === ']]') push('op', ';')
      else operand = text !== null && conditionOperators.has(text)
      return
    }
    const phase = cases.at(-1)
    if (text === 'esac' && (phase === 'pattern' || (phase === 'body' && done.start))) cases.pop()
    else if (phase === 'subject') cases[cases.length - 1] = 'in'
    else if (phase === 'in') {
      if (text === 'in') cases[cases.length - 1] = 'pattern'
      else cases.pop()
    }
    if (done.start && text === 'case') cases.push('subject')
    if (done.start && text === '[[') {
      condition = true
      groups = 0
    }
    const assigns = assignments && assignment.test(done.text)
    if (assignments && !assigns && text !== null && declarationBuiltins.has(text)) declaring = true
    const always = text === 'always' && tokens.at(-2)?.text === '}'
    commandStart = done.start && text !== null && (startKeywords.has(text) || always)
    assignments = commandStart || assigns || declaring
  }

  const push = (kind: Operator['kind'], text: string) => {
    flush()
    delimiterStrip = null
    tokens.push({ kind, text })
    if (kind === 'redirect') return
    commandStart = !array
    assignments = !array
    declaring = false
    condition = false
    operand = false
    if (caseTerminators.has(text) && cases.at(-1) === 'body') cases[cases.length - 1] = 'pattern'
  }

  const dropFdPrefix = () => {
    if (word && !word.quoted && !word.dynamic && fdPrefix.test(word.text)) reset()
  }

  const appendPlain = (char: string) => {
    const target = current()
    if (char === '*' || char === '?') target.dynamic = true
    if (char === '[') glob = target.text.length
    if (char === ']' && glob !== -1) target.dynamic = true
    if (char === '{') {
      brace = target.text.length
      braceList = false
    }
    if (brace !== -1 && (char === ',' || (char === '.' && target.text.endsWith('.')))) {
      braceList = true
    }
    if (char === '}' && braceList) target.dynamic = true
    target.text += char
  }

  const readPart = (at: number, target: Word): number => {
    const char = src[at]!
    const next = src[at + 1]
    if (char === '\\') {
      if (next === '\n') return at + 2
      target.quoted = true
      target.text += next ?? char
      return at + (next === undefined ? 1 : 2)
    }
    if (char === "'") {
      const end = src.indexOf("'", at + 1)
      const stop = end === -1 ? src.length : end
      target.quoted = true
      target.text += src.slice(at + 1, stop)
      return stop + 1
    }
    if (char === '"') return readDouble(src, at + 1, target, level + 1)
    if (char === '`') return readBacktick(src, at + 1, target, level + 1)
    if (next === "'") return readAnsiC(src, at, target)
    if (next === '"') {
      target.dynamic = true
      return readDouble(src, at + 2, target, level + 1)
    }
    return readDollar(src, at, target, level + 1, false)
  }

  const readPattern = (from: number) => {
    const target: Word = { ...newWord(), inert: true }
    let at = src[from] === '(' ? from + 1 : from
    if (src.startsWith('esac', at)) refuse(casePattern)
    while (at < src.length && src[at] !== ')') {
      const char = src[at]!
      if (
        '(;&\n'.includes(char) ||
        ('<>'.includes(char) && src[at + 1] === '(') ||
        (char === '\\' && src[at + 1] === '\n')
      ) {
        refuse(casePattern)
      }
      if (quoteChars.includes(char)) at = readPart(at, target)
      else {
        target.text += char
        at += 1
      }
    }
    if (at >= src.length) refuse(casePattern)
    tokens.push(target)
    push('op', ')')
    cases[cases.length - 1] = 'body'
    return at + 1
  }

  const readOperand = (from: number) => {
    const target = current()
    let parens = 0
    let at = from
    while (at < src.length) {
      const char = src[at]!
      if (' \t\n;&|<>)'.includes(char)) {
        if (parens === 0) break
        if (!' \t|)'.includes(char)) refuse(conditionPattern)
      }
      if (char === '(') parens += 1
      if (char === ')') parens -= 1
      if (quoteChars.includes(char)) at = readPart(at, target)
      else {
        target.text += char
        at += 1
      }
    }
    operand = false
    return at
  }

  const afterFor = () => {
    const last = tokens.at(-1)
    return last?.kind === 'word' && last.start === true && !last.quoted && last.text === 'for'
  }

  const readArray = (from: number, target: Word) => {
    const inner = lex(src, from + 1, true, level + 1, true)
    for (const token of inner.tokens) {
      if (token.kind !== 'word') continue
      target.commands.push(...token.commands)
      target.blocked ??= token.blocked
    }
    target.text += src.slice(from, inner.end + 1)
    return inner.end + 1
  }

  const readArithmeticCommand = (from: number, inner: number) => {
    const target = newWord()
    const end = readArithmetic(src, from, inner + 1, target, level + 1)
    target.dynamic = false
    target.quoted = true
    tokens.push(target)
    push('op', '))')
    return end
  }

  const readHeredocs = (from: number) => {
    let at = from
    for (const { word: delimiter, strip } of heredocs.splice(0)) {
      const bodyStart = at
      let bodyEnd = src.length
      let joined: string | null = null
      let lineStart = at
      while (at < src.length) {
        const newline = src.indexOf('\n', at)
        const lineEnd = newline === -1 ? src.length : newline
        const line = src.slice(at, lineEnd)
        if (joined === null) lineStart = at
        at = lineEnd + 1
        const logical: string = (joined ?? '') + line
        if (!delimiter.quoted && newline !== -1 && continuesLine(line)) {
          joined = logical.slice(0, -1)
          continue
        }
        joined = null
        if ((strip ? logical.replace(/^\t+/, '') : logical) === delimiter.text) {
          bodyEnd = lineStart
          break
        }
      }
      delimiter.body = src.slice(bodyStart, bodyEnd)
      if (delimiter.dynamic) delimiter.blocked ??= heredocDelimiter
      else if (!delimiter.quoted) {
        const body = heredocWord(delimiter.body, level + 1)
        delimiter.commands.push(...body.commands)
        delimiter.blocked ??= body.blocked
      }
    }
    return Math.min(at, src.length)
  }

  while (index < src.length) {
    const char = src[index]!
    const next = src[index + 1]
    if (word === null && !' \t\n#'.includes(char)) {
      if (cases.at(-1) === 'pattern' && !matchesAt(caseEnd, src, index)) {
        index = readPattern(index)
        continue
      }
      if (operand && !src.startsWith(']]', index)) {
        index = readOperand(index)
        continue
      }
    }
    if (char === '\\' && next === '\n') index += 2
    else if (quoteChars.includes(char)) index = readPart(index, current())
    else if (char === '#' && word === null) {
      while (index < src.length && src[index] !== '\n') index += 1
    } else if (char === '\n') {
      if (condition) flush()
      else push('op', '\n')
      index += 1
      if (heredocs.length > 0) index = readHeredocs(index)
    } else if (char === ' ' || char === '\t') {
      flush()
      index += 1
    } else if ((char === '<' || char === '>') && src[skipContinuations(src, index + 1)] === '(') {
      index = readNested(src, index, skipContinuations(src, index + 1) + 1, current(), level)
    } else if (condition && (')<>&|'.includes(char) || (char === '(' && word === null))) {
      flush()
      if (condition) {
        if (char === ')' && groups === 0) refuse(conditionPattern)
        if (char === '(') groups += 1
        if (char === ')') groups -= 1
        appendPlain(char)
        flush()
        index += 1
      }
    } else if (char === '(' && word !== null && !word.quoted && arrayAssignment.test(word.text)) {
      if (!assignments) refuse(globPattern)
      index = readArray(index, word)
    } else if (
      char === '(' &&
      word === null &&
      src[skipContinuations(src, index + 1)] === '(' &&
      (commandStart || afterFor())
    ) {
      index = readArithmeticCommand(index, skipContinuations(src, index + 1))
    } else {
      if (char === '(' && next !== ')' && (word !== null || !commandStart)) refuse(globPattern)
      if (char === '<' && matchesAt(numericGlob, src, index)) refuse(globPattern)
      const redirection = redirections.find((op) => src.startsWith(op, index))
      const separator = redirection ? undefined : separators.find((op) => src.startsWith(op, index))
      if (redirection) {
        const heredoc = redirection === '<<' || redirection === '<<-'
        if (heredoc && level > 0) refuse(substitutionHeredoc)
        dropFdPrefix()
        push('redirect', redirection)
        if (heredoc) delimiterStrip = redirection === '<<-'
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
const dynamicName = 'PRism cannot check variable names built at run time. Use a literal name.'
const stdinShell = 'Running a script from stdin is blocked. Run the commands directly.'
const envSplit = 'env --split-string is blocked. Run the command directly.'
const envClear =
  'Clearing the environment is blocked: PRism relies on it. Run the command directly.'
const attachedOption = 'Pass shell options as separate words, like -o errexit.'
const backgroundRedirect =
  'sh, dash and ksh read &> as & and >, which runs the rest as another command. Use >file 2>&1.'
const unmodelledShell =
  'PRism checks bash and zsh syntax only, so csh, tcsh and fish are blocked. Use bash -c or zsh -c.'
const posixSyntax =
  'sh and dash may not have [[ … ]] or (( … )), so PRism cannot check them there. Use [ … ] and $(( … )), or bash -c.'
type Dialect = 'posix' | 'ksh'
const dialects = new Map<string, Dialect>([
  ['sh', 'posix'],
  ['dash', 'posix'],
  ['ksh', 'ksh'],
])
const unmodelledShells = new Set(['csh', 'tcsh', 'fish'])

const assignment = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/
const shells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh'])
const interpreters = /^(?:python[\d.]*|node|ruby|perl|php|osascript|g?awk|deno|bun)$/

const commandName = (text: string) => (text.split('/').at(-1) ?? '').replace(/^=/, '').toLowerCase()
const isPrefixOf = (name: string, options: string[]) =>
  name.length > 0 && options.some((option) => option.startsWith(name))
const longName = (arg: string) => arg.slice(2).split('=')[0]!
const isShortCluster = (arg: string) => /^-[^-]/.test(arg)
const readsStdin = (path: string) => path === '/dev/stdin' || path.startsWith('/dev/fd/')
const leadingName = (text: string) => /^[A-Za-z_][A-Za-z0-9_]*/.exec(text)?.[0]
const joined = (words: Word[]) => words.map((word) => word.text).join(' ')

export type ShellContext = {
  aliases: Map<string, string>
  functions: Map<string, string>
}

interface Check {
  readOnly: boolean
  shell: ShellContext | undefined
  depth: number
  checkedFunctions: Set<string>
  budget: { left: number }
  dialect?: Dialect
}

const deeper = (check: Check): Check => ({ ...check, depth: check.depth + 1 })

const allowedGitVariables = new Set(['GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS'])
const pagerVariables = new Set(['GIT_PAGER', 'PAGER', 'GH_PAGER', 'MANPAGER'])
const programVariables = new Set([
  'EDITOR',
  'VISUAL',
  'SSH_ASKPASS',
  'BROWSER',
  'GH_BROWSER',
  'PS4',
  'PROMPT4',
  'LESS',
  'LESSOPEN',
  'LESSCLOSE',
  'LESSKEY',
  'functions',
  'commands',
  'aliases',
  'galiases',
  'saliases',
  'builtins',
  'options',
  'BASH_CMDS',
  'BASH_ALIASES',
])
const runsPrograms = (name: string) =>
  programVariables.has(name) || name.startsWith('dis_') || /^npm_config_/i.test(name)

type VariableUse = 'set' | 'bind' | 'unset' | 'export'

const safePager = (value: string) =>
  /^(?:cat|more|false|true|less(?:\s+-[aABcCdeEfFgGiIJKLmMnNqQrRsSuUVwWX]+)*)?$/.test(value)

function variableReason(name: string, use: VariableUse, value = ''): string | null {
  const keeps = use === 'unset' || use === 'export'
  if (pagerVariables.has(name)) {
    if (keeps || (use === 'set' && safePager(value))) return null
  } else if (name.startsWith('GIT_')) {
    if (allowedGitVariables.has(name)) return null
  } else if (!runsPrograms(name) || keeps) return null
  return `Changing ${name} is blocked: it can make git, gh or the shell run other programs`
}

const arithmeticOperator = String.raw`\s*(?:\[[^\][]*\]\s*)?(?:(?:[-+*/%&|^]|<<|>>|\*\*|&&|\|\||\^\^)?=(?!=)|\+\+|--)`
const arithmeticAssignment = new RegExp(
  String.raw`(?<![\w$])([A-Za-z_][A-Za-z0-9_]*)${arithmeticOperator}|(?:\+\+|--)\s*([A-Za-z_][A-Za-z0-9_]*)`,
  'g',
)
const dynamicArithmeticAssignment = new RegExp(
  String.raw`(?:\$[\w@*]+|[)}\x60"])${arithmeticOperator}|(?:\+\+|--)\s*[$\x60"]`,
)

function arithmeticReason(text: string, strict = false): string | null {
  for (const match of text.matchAll(arithmeticAssignment)) {
    const name = (match[1] ?? match[2])!
    const reason = name.startsWith('GIT_') ? variableReason(name, 'bind') : null
    if (reason) return reason
  }
  if (!strict) return null
  let operands = text
  for (let round = 0; ; round += 1) {
    const next = operands.replace(/\$\{[^{}]*\}/g, '$_')
    if (next === operands) break
    if (round === maxNesting) return tooComplex
    operands = next
  }
  return dynamicArithmeticAssignment.test(operands) ? dynamicName : null
}

function assignmentReason(word: Word): string | null {
  const name = leadingName(word.text)!
  const rest = word.text.slice(name.length)
  const operator = /^(?:\[[^\]]*\])?\+?=/.exec(rest)?.[0] ?? '='
  const use = word.dynamic || operator !== '=' ? 'bind' : 'set'
  return variableReason(name, use, rest.slice(operator.length)) ?? arithmeticReason(rest)
}

const dynamicSuffix = (word: Word, name: string) =>
  word.dynamic && /^[$`]/.test(word.text.slice(name.length))

function bindReason(words: Word[]): string | null {
  for (const word of words) {
    const name = leadingName(word.text)
    if (!name || dynamicSuffix(word, name)) {
      if (word.dynamic) return dynamicName
      continue
    }
    const reason = variableReason(name, 'bind')
    if (reason) return reason
  }
  return null
}

function declarationReason(args: Word[], unset: boolean): string | null {
  for (const word of args) {
    if (/^[-+]/.test(word.text) && !word.dynamic) continue
    const name = leadingName(word.text)
    if (!name || dynamicSuffix(word, name)) {
      if (word.dynamic) return dynamicName
      continue
    }
    const rest = word.text.slice(name.length)
    const operator = /^(?:\[[^\]]*\])?\+?=/.exec(rest)?.[0]
    const use: VariableUse = unset
      ? 'unset'
      : operator === undefined
        ? 'export'
        : word.dynamic || operator !== '='
          ? 'bind'
          : 'set'
    const value = operator === undefined ? '' : rest.slice(operator.length)
    const reason = variableReason(name, use, value) ?? arithmeticReason(rest)
    if (reason) return reason
  }
  return null
}

interface Segment {
  words: Word[]
  all: Word[]
  bash: Word[] | null
  input: string[]
  pipe: boolean
}

const newSegment = (): Segment => ({ words: [], all: [], bash: null, input: [], pipe: false })

function splitSegments(tokens: Token[]) {
  const segments = [newSegment()]
  let target: string | null = null
  for (const token of tokens) {
    const segment = segments.at(-1)!
    if (token.kind === 'word') {
      segment.all.push(token)
      if (target === '<<' || target === '<<-') segment.input.push(token.body ?? '')
      if (target === '<<<') segment.input.push(token.text)
      if (target === null && !token.inert) {
        segment.words.push(token)
        segment.bash?.push(token)
      } else if (target?.endsWith('!')) (segment.bash ??= [...segment.words]).push(token)
      target = null
    } else if (token.kind === 'redirect') target = token.text
    else {
      segment.pipe = token.text === '|' || token.text === '|&'
      segments.push(newSegment())
      target = null
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
    if (assignment.test(text)) {
      const reason = assignmentReason(word)
      if (reason) return reason
      index += 1
      continue
    }
    if (text === '--') {
      index += 1
      continue
    }
    if (text === '-') return envClear
    if (word.dynamic) return dynamicCommand
    let unset: string | undefined
    let width = 1
    if (text.startsWith('--')) {
      const name = longName(text)
      const split = text.indexOf('=')
      if (isPrefixOf(name, ['split-string'])) return envSplit
      if (isPrefixOf(name, ['ignore-environment'])) return envClear
      const takesValue = isPrefixOf(name, ['unset', 'chdir', 'argv0'])
      if (takesValue && split === -1) width = 2
      if (isPrefixOf(name, ['unset']))
        unset = split === -1 ? args[index + 1]?.text : text.slice(split + 1)
    } else if (text.startsWith('-')) {
      const valueAt = text.split('').findIndex((flag) => 'iLUPSuaC'.includes(flag))
      const flag = text[valueAt]
      if (flag === 'i') return envClear
      if (flag === 'S') return envSplit
      const attached = text.slice(valueAt + 1)
      if (flag !== undefined && !attached) width = 2
      if (flag === 'u') unset = attached || args[index + 1]?.text
    } else break
    if (width === 2 && args[index + 1]?.dynamic) return dynamicCommand
    const reason = unset === undefined ? null : variableReason(unset, 'unset')
    if (reason) return reason
    index += width
  }
  return args.slice(index)
}

function archArgs(args: Word[]): Word[] | string {
  let index = 0
  while (index < args.length) {
    const word = args[index]!
    if (word.dynamic) return dynamicCommand
    const text = word.text
    if (!text.startsWith('-')) break
    if (text === '-c') return envClear
    if (text === '-e' || text === '-d') {
      const value = args[index + 1]
      if (value?.dynamic) return dynamicCommand
      const entry = value?.text ?? ''
      const split = entry.indexOf('=')
      const name = split === -1 ? entry : entry.slice(0, split)
      const reason =
        text === '-d'
          ? variableReason(name, 'unset')
          : variableReason(name, split === -1 ? 'bind' : 'set', entry.slice(split + 1))
      if (reason) return reason
      index += 2
      continue
    }
    index += text === '-arch' ? 2 : 1
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

function scriptArgs(args: Word[], check: Check): Word[] | string {
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
    if (text === '-c' || text === '--command' || text.startsWith('--command=')) {
      const script = text.startsWith('--command=')
        ? { ...word, text: text.slice('--command='.length) }
        : args[index + 1]
      if (script?.dynamic) return dynamicCommand
      return (script && scriptReason(script.text, check)) ?? []
    }
    const valueAt = text.split('').findIndex((flag) => 'tFTIOBE'.includes(flag))
    index += !text.startsWith('--') && valueAt === text.length - 1 ? 2 : 1
  }
  return args.slice(index + 1)
}

function execArgs(args: Word[]): Word[] | string {
  const rest = skipOptions(args, 'a')
  if (typeof rest === 'string') return rest
  const options = args.slice(0, args.length - rest.length)
  return options.some((word) => /^-[^-]*c/.test(word.text)) ? envClear : rest
}

const xcrunOption = (word: Word) =>
  /^-(?:sdk|toolchain)$/.test(word.text) ? { ...word, text: `-${word.text}` } : word

type Wrapper = (args: Word[], check: Check) => Word[] | string

const wrappers = new Map<string, Wrapper>([
  ['env', envArgs],
  ['command', (args) => skipOptions(args)],
  ['builtin', (args) => skipOptions(args)],
  ['exec', execArgs],
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
  ['repeat', (args) => args.slice(1)],
  ['caffeinate', (args) => skipOptions(args, 'tw')],
  ['arch', archArgs],
  ['xcrun', (args) => skipOptions(args.map(xcrunOption), '', ['sdk', 'toolchain'])],
  ['sandbox-exec', (args) => skipOptions(args, 'fnpD')],
  ['script', scriptArgs],
])

function shellBlockReason(shell: string, args: Word[], check: Check): string | null {
  if (unmodelledShells.has(shell)) return unmodelledShell
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
      if (globSubst(name)) return evalExpansion
      if (name === 'command' && split !== -1) scripts.push({ ...word, text: text.slice(split + 1) })
      else if (name === 'command') command = true
      else if (split === -1 && ['rcfile', 'init-file', 'emulate'].includes(name)) {
        if (args[index]?.dynamic) return dynamicCommand
        index += 1
      }
      continue
    }
    const flags = text.slice(1)
    if (/[oO]./.test(flags)) return attachedOption
    if (flags.includes('c')) command = true
    if (flags.includes('s')) stdin = true
    if (!/[oO]$/.test(flags)) continue
    const value = args[index]
    if (value?.dynamic) return dynamicCommand
    if (value && globSubst(value.text)) return evalExpansion
    index += 1
  }
  const rest = args.slice(index)
  if (command && rest[0]) scripts.push(rest[0])
  if (!command && scripts.length === 0 && (stdin || !rest[0] || readsStdin(rest[0].text))) {
    return stdinShell
  }
  for (const script of scripts) {
    if (script.dynamic) return dynamicCommand
    const reason = scriptReason(script.text, { ...check, dialect: dialects.get(shell) })
    if (reason) return reason
  }
  return null
}

const globSubst = (text: string) =>
  /globsubst|braceccl/.test(text.toLowerCase().replaceAll('_', ''))

const runnerValues = new Set([
  '-p',
  '--package',
  '--registry',
  '--prefix',
  '--userconfig',
  '--cache',
  '--cwd',
  '--filter',
  '-F',
  '-C',
  '--dir',
  '--loglevel',
  '--reporter',
  '--workspace-concurrency',
  '--resume-from',
  '--node-options',
])

const runnerFlags = new Set([
  '-y',
  '--yes',
  '--no',
  '-q',
  '--quiet',
  '-s',
  '--silent',
  '-r',
  '--recursive',
  '--parallel',
  '--stream',
  '--workspace-root',
  '--workspaces',
  '--include-workspace-root',
  '--prefer-offline',
  '--prefer-online',
  '--offline',
  '--ignore-existing',
  '--no-install',
  '--aggregate-output',
  '--report-summary',
  '--bail',
  '--no-bail',
  '--sort',
  '--no-sort',
  '--reverse',
  '--color',
  '--no-color',
  '-g',
  '--global',
  '--bun',
])

function runnerReason(args: Word[], check: Check): string | null {
  if (check.depth > maxNesting) return tooDeep
  let index = 0
  let unknown = false
  while (index < args.length) {
    const word = args[index]!
    const text = word.text
    if (word.dynamic) return dynamicCommand
    if (text === '--') {
      index += 1
      unknown = false
      break
    }
    if (!text.startsWith('-') || text === '-') break
    const split = text.indexOf('=')
    const option = split === -1 ? text : text.slice(0, split)
    if (option === '-c' || option === '--call' || option === '--shell-mode') {
      const script =
        split === -1 ? args.slice(index + 1) : [{ ...word, text: text.slice(split + 1) }]
      if (script.some((part) => part.dynamic)) return dynamicCommand
      return scriptReason(joined(script), check)
    }
    const value = split === -1 && runnerValues.has(option)
    unknown = split === -1 && !value && !runnerFlags.has(option)
    index += value ? 2 : 1
  }
  const command = args.slice(index)
  if (command.length === 0) return null
  if (command[0]!.dynamic) return dynamicCommand
  const reason = segmentBlockReason(command, deeper(check))
  if (reason || !unknown) return reason
  return runnerReason(command.slice(1), deeper(check))
}

const callsScript = (option: string) =>
  option === '-c' || (option.length >= 5 && '--call'.startsWith(option))

function npmCallReason(args: Word[], check: Check): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]!.text
    const split = text.indexOf('=')
    if (!callsScript(split === -1 ? text : text.slice(0, split))) continue
    const script = split === -1 ? args[index + 1] : { ...args[index]!, text: text.slice(split + 1) }
    if (script?.dynamic) return dynamicCommand
    const reason = script ? scriptReason(script.text, check) : null
    if (reason) return reason
  }
  return null
}

const versionBlocked =
  'npm, pnpm, yarn and bun version commands commit and tag. Pass --no-git-tag-version, or edit package.json.'
const gitTagFlag = /^--(?:no-)?git-tag-version(?:=|$)/
const noGitTag = /^--(?:no-git-tag-version|git-tag-version=(?:false|0))$/

const isVersionCommand = (tool: string, sub: string) =>
  sub === 'version' ||
  sub === 'verison' ||
  (tool === 'npm' && sub.length >= 4 && ['version', 'verison'].some((name) => name.startsWith(sub)))

function versionArgs(tool: string, sub: string, rest: Word[]) {
  if (tool === 'bun') return sub === 'pm' && rest[0]?.text === 'version' ? rest.slice(1) : null
  return isVersionCommand(tool, sub) ? rest : null
}

function versionReason(tool: string, sub: string, rest: Word[], args: Word[]): string | null {
  const bump = versionArgs(tool, sub, rest)
  if (!bump) return null
  if (bump.some((word) => word.dynamic)) return dynamicCommand
  const tagFlag = args.findLast((word) => gitTagFlag.test(word.text))
  if (tagFlag && noGitTag.test(tagFlag.text)) return null
  return tool === 'yarn' || bump.some((word) => !word.text.startsWith('-')) ? versionBlocked : null
}

function packageReason(tool: string, args: Word[], check: Check): string | null {
  const call = tool === 'npm' ? npmCallReason(args, check) : null
  return call ?? packageCommandReason(tool, args, args, false, check)
}

function packageCommandReason(
  tool: string,
  args: Word[],
  all: Word[],
  shellMode: boolean,
  check: Check,
): string | null {
  if (check.depth > maxNesting) return tooDeep
  let index = 0
  let unknown = false
  while (index < args.length) {
    const word = args[index]!
    if (word.dynamic) return dynamicCommand
    const text = word.text
    if (!text.startsWith('-') || text === '-') break
    if (text === '-c' || text === '--shell-mode') shellMode = true
    const value = !text.includes('=') && runnerValues.has(text)
    unknown = !text.includes('=') && !value && !runnerFlags.has(text)
    index += value ? 2 : 1
  }
  const sub = args[index]
  if (!sub) return null
  const rest = args.slice(index + 1)
  const reason = subcommandReason(tool, sub, rest, all, shellMode, check)
  if (reason || !unknown) return reason
  return packageCommandReason(tool, rest, all, shellMode, deeper(check))
}

function subcommandReason(
  tool: string,
  sub: Word,
  rest: Word[],
  all: Word[],
  shellMode: boolean,
  check: Check,
): string | null {
  const version = versionReason(tool, sub.text, rest, all)
  if (version) return version
  const runs = ['exec', 'x', 'dlx'].includes(sub.text)
  if ((tool === 'bun' && sub.text === 'exec') || (shellMode && runs)) {
    if (rest.some((word) => word.dynamic)) return dynamicCommand
    return scriptReason(joined(rest), check)
  }
  if (runs) return runnerReason(rest, deeper(check))
  if (tool === 'pnpm' && checkedCommand(commandName(sub.text))) {
    return segmentBlockReason([sub, ...rest], deeper(check))
  }
  return null
}

const findActions = new Set(['-exec', '-execdir', '-ok', '-okdir'])

function findReason(args: Word[], check: Check): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (!findActions.has(args[index]!.text)) continue
    let end = index + 1
    while (
      end < args.length &&
      args[end]!.text !== ';' &&
      !(args[end]!.text === '+' && args[end - 1]!.text === '{}')
    ) {
      end += 1
    }
    const command = args
      .slice(index + 1, end)
      .map((word) => (word.text.includes('{}') ? { ...word, dynamic: true } : word))
    const reason = segmentBlockReason(command, deeper(check))
    if (reason) return reason
    index = end
  }
  return null
}

function watchReason(args: Word[], check: Check): string | null {
  const rest = skipOptions(args, 'nq', ['interval'])
  if (typeof rest === 'string') return rest
  if (rest.some((word) => word.dynamic)) return dynamicCommand
  return scriptReason(joined(rest), check)
}

function trapReason(args: Word[], check: Check): string | null {
  let index = 0
  while (args[index] && /^-[lp]+$/.test(args[index]!.text)) index += 1
  if (args[index]?.text === '--') index += 1
  const action = args[index]
  if (!action) return null
  if (action.dynamic) return dynamicCommand
  return scriptReason(action.text, check)
}

function emulateReason(args: Word[], check: Check): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]!.text
    if (/^k?sh$/i.test(text) || globSubst(text)) return evalExpansion
    if (!/^-[A-Za-z]*c$/.test(text)) continue
    const script = args[index + 1]
    if (script?.dynamic) return dynamicCommand
    return script ? scriptReason(script.text, check) : null
  }
  return null
}

function mapfileReason(args: Word[], check: Check): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]!.text !== '-C') continue
    const callback = args[index + 1]
    if (callback?.dynamic) return dynamicCommand
    const reason = callback ? scriptReason(callback.text, check) : null
    if (reason) return reason
  }
  return bindReason(args)
}

function printReason(args: Word[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!
    const target = /^-[A-Za-z]*v(.*)$/.exec(word.text)
    const named =
      target && (target[1] ? [{ ...word, text: target[1] }] : args.slice(index + 1, index + 2))
    const reason = (named && bindReason(named)) ?? arithmeticReason(word.text)
    if (reason) return reason
  }
  return null
}

const arithmeticTests = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])

function conditionReason(args: Word[], check: Check): string | null {
  const close = args.findIndex((word) => !word.quoted && word.text === ']]')
  const operands = close === -1 ? args : args.slice(0, close)
  for (const [index, word] of operands.entries()) {
    const strict = [operands[index - 1], operands[index + 1]].some(
      (near) => near !== undefined && arithmeticTests.has(near.text),
    )
    const reason = arithmeticReason(word.text, strict)
    if (reason) return reason
  }
  return close === -1 ? null : segmentBlockReason(args.slice(close + 1), deeper(check))
}

function sourceReason(args: Word[]): string | null {
  const file = args[0]
  if (!file) return null
  if (file.commands.length > 0) return dynamicCommand
  return readsStdin(file.text) ? stdinShell : null
}

function zstyleReason(args: Word[]): string | null {
  const option = args[0]
  if (option?.dynamic) return dynamicName
  if (option?.text === '-e') return evalExpansion
  if (/^-[sab]$/.test(option?.text ?? '')) return bindReason(args.slice(3, 4))
  return option?.text === '-g' ? bindReason(args.slice(1, 2)) : null
}

type CommandCheck = (args: Word[], check: Check) => string | null

const declare: CommandCheck = (args) => declarationReason(args, false)
const optionsReason: CommandCheck = (args) =>
  args.some((word) => globSubst(word.text)) ? evalExpansion : null
const optionValue = (args: Word[], option: RegExp) => {
  const at = args.findIndex((word) => option.test(word.text))
  return at === -1 ? [] : args.slice(at + 1, at + 2)
}
const loopReason: CommandCheck = (args) => {
  const end = args.findIndex((word) => word.text === 'in' && !word.quoted)
  return bindReason(end === -1 ? args : args.slice(0, end))
}

const commandChecks = new Map<string, CommandCheck>([
  ['source', sourceReason],
  ['.', sourceReason],
  ['trap', trapReason],
  [
    'hash',
    (args) =>
      args.some((word) => word.text.includes('=') || /^-[A-Za-z]*p/.test(word.text))
        ? 'Naming commands with hash is blocked. Run the command by name.'
        : null,
  ],
  [
    'alias',
    (args) =>
      args.some((word) => word.text.includes('='))
        ? 'Defining aliases is blocked. Run the command directly.'
        : null,
  ],
  [
    'functions',
    (args) =>
      args.some((word) => /^[-+][A-Za-z]*[cM]/.test(word.text))
        ? 'functions -c and -M are blocked. Run the command directly.'
        : null,
  ],
  ['autoload', () => 'autoload is blocked. Run the command directly.'],
  [
    'compgen',
    (args) =>
      args.some((word) => /^-[A-Za-z]*[CF]/.test(word.text))
        ? 'compgen -C and -F are blocked. Run the command directly.'
        : null,
  ],
  ['find', findReason],
  ['watch', watchReason],
  ['setopt', optionsReason],
  ['unsetopt', optionsReason],
  ['set', (args, check) => optionsReason(args, check) ?? bindReason(optionValue(args, /^[-+]A$/))],
  ['emulate', emulateReason],
  ['[[', conditionReason],
  ['let', (args) => args.map((word) => arithmeticReason(word.text, true)).find(Boolean) ?? null],
  ['printf', printReason],
  ['print', printReason],
  ['read', bindReason],
  ['getopts', (args) => bindReason(args.slice(1, 2))],
  ['vared', bindReason],
  ['strftime', (args) => bindReason(optionValue(args, /^-[A-Za-z]*s$/))],
  ['zstyle', zstyleReason],
  [
    'zparseopts',
    (args) =>
      bindReason(args.flatMap((word) => word.text.split('=').map((text) => ({ ...word, text })))),
  ],
  ['mapfile', mapfileReason],
  ['readarray', mapfileReason],
  ['for', loopReason],
  ['select', loopReason],
  ['foreach', loopReason],
  ...[...declarationBuiltins].map((name): [string, CommandCheck] => [name, declare]),
  [
    'unset',
    (args) =>
      args.some((word) => /^-[A-Za-z]*m/.test(word.text))
        ? 'unset -m is blocked. Unset each variable by name.'
        : declarationReason(args, true),
  ],
  ['npx', runnerReason],
  ['pnpx', runnerReason],
  ['bunx', runnerReason],
  ['npm', (args, check) => packageReason('npm', args, check)],
  ['pnpm', (args, check) => packageReason('pnpm', args, check)],
  ['yarn', (args, check) => packageReason('yarn', args, check)],
  ['bun', (args, check) => packageReason('bun', args, check)],
])

const checkedCommand = (name: string) =>
  name === 'git' ||
  name.startsWith('git-') ||
  name === 'gh' ||
  name === 'eval' ||
  shells.has(name) ||
  interpreters.test(name) ||
  wrappers.has(name) ||
  commandChecks.has(name)

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
const gitGlobalValues = new Set(['-C', '--git-dir', '--work-tree'])
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
      if (isPrefixOf(name, listFlags)) list = true
      if (isPrefixOf(name, rules.values) && !arg.includes('=')) index += 1
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

const fetchValues = [
  'depth',
  'deepen',
  'shallow-since',
  'shallow-exclude',
  'jobs',
  'negotiation-tip',
  'server-option',
  'refmap',
  'upload-pack',
  'recurse-submodules-default',
  'submodule-prefix',
  'filter',
]
const fetchFlags = [
  'verbose',
  'quiet',
  'all',
  'set-upstream',
  'append',
  'atomic',
  'force',
  'multiple',
  'tags',
  'prefetch',
  'prune',
  'prune-tags',
  'recurse-submodules',
  'dry-run',
  'porcelain',
  'write-fetch-head',
  'keep',
  'update-head-ok',
  'progress',
  'unshallow',
  'refetch',
  'update-shallow',
  'ipv4',
  'ipv6',
  'negotiate-only',
  'auto-maintenance',
  'auto-gc',
  'show-forced-updates',
  'write-commit-graph',
  'stdin',
]
const fetchOptions = [...fetchFlags, ...fetchValues]
const fetchBlocked = ['update-head-ok', 'upload-pack', 'stdin', 'prune-tags', 'set-upstream']

function resolveOption(name: string, options: string[]) {
  if (options.includes(name)) return name
  const matches = options.filter((option) => option.startsWith(name))
  return matches.length === 1 ? matches[0]! : null
}
const fetchDestinations = ['refs/remotes/', 'refs/tags/']

function refspecReason(spec: string): string | null {
  const body = spec.startsWith('+') ? spec.slice(1) : spec
  const split = body.indexOf(':')
  const destination = split === -1 ? '' : body.slice(split + 1)
  if (body.startsWith('^') || destination === '') return null
  const allowed = fetchDestinations.some((prefix) => destination.startsWith(prefix))
  return allowed && !destination.includes('..')
    ? null
    : `git fetch into ${destination} is blocked: fetch into refs/remotes/ or refs/tags/`
}

function fetchReason(args: string[]): string | null {
  let multiple = false
  const positionals: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--') {
      positionals.push(...args.slice(index + 1))
      break
    }
    if (arg.startsWith('--')) {
      const name = longName(arg)
      const split = arg.indexOf('=')
      if (name !== 'prune' && name.length >= 2 && isPrefixOf(name, fetchBlocked)) {
        return `git fetch --${name} is blocked`
      }
      const option = resolveOption(name, fetchOptions)
      if (option === 'multiple') multiple = true
      if (name.startsWith('no-') && resolveOption(name.slice(3), fetchFlags) === 'multiple') {
        multiple = false
      }
      const value =
        split !== -1
          ? arg.slice(split + 1)
          : option !== null && fetchValues.includes(option)
            ? args[++index]
            : undefined
      const reason = option === 'refmap' && value !== undefined ? refspecReason(value) : null
      if (reason) return reason
    } else if (isShortCluster(arg)) {
      for (let at = 1; at < arg.length; at += 1) {
        const flag = arg[at]!
        if (flag === 'u') return 'git fetch --update-head-ok is blocked'
        if (flag === 'P') return 'git fetch --prune-tags is blocked'
        if (flag === 'm') multiple = true
        if (flag === 'j' || flag === 'o') {
          if (at === arg.length - 1) index += 1
          break
        }
      }
    } else positionals.push(arg)
  }
  if (multiple) return null
  for (const spec of positionals.slice(1)) {
    const reason = refspecReason(spec)
    if (reason) return reason
  }
  return null
}

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
      const staged =
        longOptionIn(args, ['staged'], 2) ||
        args.some((arg) => isShortCluster(arg) && arg.includes('S'))
      const worktree =
        longOptionIn(args, ['worktree']) ||
        args.some((arg) => isShortCluster(arg) && arg.includes('W'))
      return staged && !worktree ? null : 'git restore is limited to --staged'
    },
  ],
  ['fetch', fetchReason],
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

const safeConfigKeys = new Set([
  'core.quotepath',
  'core.abbrev',
  'diff.noprefix',
  'diff.renames',
  'diff.algorithm',
  'diff.context',
  'format.pretty',
  'column.ui',
  'safe.directory',
  'user.name',
  'user.email',
  'init.defaultbranch',
  'grep.linenumber',
])
const safeConfigSections = ['color.', 'log.', 'advice.']

function gitConfigReason(entry: string, fromEnv: boolean): string | null {
  const split = entry.indexOf('=')
  const key = split === -1 ? entry : entry.slice(0, split)
  const lower = key.toLowerCase()
  const option = fromEnv ? '--config-env' : '-c'
  if (lower === 'core.pager' || lower.startsWith('pager.')) {
    return !fromEnv && (split === -1 || safePager(entry.slice(split + 1)))
      ? null
      : `git ${option} ${key} is blocked: use a plain pager like cat or less`
  }
  const safe =
    safeConfigKeys.has(lower) ||
    (lower !== 'log.showsignature' &&
      safeConfigSections.some((section) => lower.startsWith(section)))
  return safe ? null : `git ${option} ${key} is blocked: only display settings can be changed`
}

function gitBlockReason(args: Word[], readOnly: boolean): string | null {
  if (args.some((word) => word.text === '--no-verify')) return 'git --no-verify is blocked'
  let index = 0
  while (index < args.length) {
    const word = args[index]!
    if (word.dynamic) return dynamicGit
    const text = word.text
    if (text === '-c' || text === '--config-env' || text.startsWith('--config-env=')) {
      const attached = text.startsWith('--config-env=')
      const value = attached
        ? { ...word, text: text.slice('--config-env='.length) }
        : args[index + 1]
      if (value?.dynamic) return dynamicGit
      const reason = gitConfigReason(value?.text ?? '', text !== '-c')
      if (reason) return reason
      index += attached ? 1 : 2
    } else if (gitGlobalValues.has(text)) {
      if (args[index + 1]?.dynamic) return dynamicGit
      index += 2
    } else if (text === '--exec-path' || text.startsWith('--exec-path=')) {
      return 'git --exec-path is blocked'
    } else if (gitGlobalFlags.has(text) || /^--(git-dir|work-tree)=/.test(text)) index += 1
    else break
  }
  const subcommand = args[index]
  if (!subcommand) return null
  const sub = gitSubcommandAliases.get(subcommand.text) ?? subcommand.text
  if (!gitReadCommands.has(sub) && !gitEditCommands.has(sub)) {
    return `git ${sub} is blocked: PRism only allows git commands that read or stage changes (agents never commit, push or rewrite history)`
  }
  if (readOnly && gitEditCommands.has(sub)) return `git ${sub} is not allowed in a read-only stage`
  const check = gitArgChecks.get(sub)
  if (!check) return null
  const rest = args.slice(index + 1)
  if (rest.some((word) => word.dynamic)) return dynamicGit
  return check(rest.map((word) => word.text))
}

const canExpandAlias = (word: Word, shell: ShellContext) =>
  !word.quoted && !word.dynamic && shell.aliases.has(word.text) && !word.fromAlias?.has(word.text)

function aliasTokens(words: Word[], shell: ShellContext, count: number): Token[] {
  if (count > maxNesting) throw new Error('Aliases are nested too deeply')
  const [head, ...rest] = words
  const value = shell.aliases.get(head!.text) ?? ''
  const fromAlias = new Set(head!.fromAlias).add(head!.text)
  const expansion = lex(value).tokens.map((token) =>
    token.kind === 'word' ? { ...token, fromAlias } : token,
  )
  const next = rest[0]
  const tail =
    /[ \t]$/.test(value) && next && canExpandAlias(next, shell)
      ? aliasTokens(rest, shell, count + 1)
      : rest.map((word) => ({ ...word, commands: [] }))
  return [...expansion, ...tail]
}

function functionReason(name: string, check: Check): string | null {
  const body = check.shell?.functions.get(name)
  if (body === undefined || name === 'git' || name === 'gh') return null
  if (check.checkedFunctions.has(name)) return null
  check.checkedFunctions.add(name)
  let reason: string | null
  try {
    reason = scriptReason(body, check)
  } catch (error) {
    reason = error instanceof Refusal ? error.message : tooComplex
  }
  return reason && `${name} is a shell function that runs something PRism blocks: ${reason}`
}

function shellContextReason(words: Word[], check: Check): string | null {
  const shell = check.shell
  const head = words[0]!
  if (!shell) return null
  const user = { ...check, dialect: undefined }
  if (canExpandAlias(head, shell)) {
    const reason = tokensBlockReason(aliasTokens(words, shell, 0), deeper(user))
    if (reason) return reason
  }
  return functionReason(head.text, user)
}

const gitServerPrograms = new Set([
  'receive-pack',
  'upload-pack',
  'upload-archive',
  'shell',
  'cvsserver',
])

function gitProgram(name: string, path: string) {
  if (!name.startsWith('git-')) return null
  const sub = name.slice(4)
  const mapped =
    !path.includes('/') || /(?:^|\/)git-core\//i.test(path) || gitServerPrograms.has(sub)
  return mapped ? sub : null
}

function finalReason(
  name: string,
  args: Word[],
  check: Check,
  input: string[],
  path = name,
): string | null {
  if (name === 'git') return gitBlockReason(args, check.readOnly)
  const sub = gitProgram(name, path)
  if (sub !== null) return gitBlockReason([{ ...newWord(), text: sub }, ...args], check.readOnly)
  if (name === 'gh') {
    if (args.some((word) => word.dynamic)) return dynamicGh
    return ghBlockReason(args.map((word) => word.text))
  }
  if (name === 'eval') return 'eval is blocked. Run the command directly.'
  if (shells.has(name)) return shellBlockReason(name, args, check)
  const code = interpreters.test(name)
    ? backstopReason([...args.map((word) => word.text), ...input].join('\n'))
    : null
  return code ?? commandChecks.get(name)?.(args, check) ?? null
}

function segmentBlockReason(segment: Word[], check: Check, input: string[] = []): string | null {
  if (check.depth > maxNesting) return tooDeep
  if (segment.length === 0) return null
  check.budget.left -= 1
  if (check.budget.left < 0) return tooComplex
  let words = segment
  for (let steps = 0; steps <= 2 * maxNesting; steps += 1) {
    const head = words[0]
    if (!head) return null
    if (assignment.test(head.text)) {
      const reason = assignmentReason(head)
      if (reason) return reason
      words = words.slice(1)
      continue
    }
    if (head.dynamic) return dynamicCommand
    if (prefixWords.has(head.text)) {
      words = words.slice(1)
      continue
    }
    const shellReason = shellContextReason(words, check)
    if (shellReason) return shellReason
    const name = commandName(head.text)
    const wrapper = wrappers.get(name)
    if (!wrapper) return finalReason(name, words.slice(1), check, input, head.text)
    const next = wrapper(words.slice(1), check)
    if (typeof next === 'string') return next
    words = next
  }
  return tooComplex
}

function dialectReason(tokens: Token[], dialect: Dialect): string | null {
  for (const token of tokens) {
    if (token.kind === 'redirect' && token.text.startsWith('&>')) return backgroundRedirect
    if (dialect !== 'posix') continue
    if (token.kind === 'op' && token.text === '))') return posixSyntax
    if (token.kind === 'word' && token.start && !token.quoted && token.text === '[[') {
      return posixSyntax
    }
  }
  return null
}

function tokensBlockReason(tokens: Token[], check: Check): string | null {
  if (check.depth > maxNesting) return tooDeep
  const dialect = check.dialect ? dialectReason(tokens, check.dialect) : null
  if (dialect) return dialect
  let piped: string[] = []
  for (const { words, all, bash, input, pipe } of splitSegments(tokens)) {
    for (const word of all) {
      if (word.blocked) return word.blocked
      for (const inner of word.commands) {
        const nestedReason = tokensBlockReason(inner, deeper(check))
        if (nestedReason) return nestedReason
      }
    }
    const stdin = [...piped, ...input]
    const reason =
      segmentBlockReason(words, check, stdin) ??
      (bash && segmentBlockReason(bash, check, stdin)) ??
      backstopReason(joined(words.filter((word) => !word.quoted)))
    if (reason) return reason
    piped = pipe ? [...input, joined(words)] : []
  }
  return null
}

function scriptBlockReason(script: string, check: Check): string | null {
  return tokensBlockReason(lex(script).tokens, check)
}

const gitWriteBlocked = 'git commit/push is blocked'

function backstopReason(text: string): string | null {
  let afterGit = false
  for (const token of text.split(/\s+/)) {
    if (afterGit && /^(?:commit|push)\b/i.test(token)) return gitWriteBlocked
    afterGit = (afterGit && token.startsWith('-')) || /(?:^|[^\w-])git$/i.test(token)
  }
  return null
}

function scriptReason(script: string, check: Check): string | null {
  return scriptBlockReason(script, deeper(check)) ?? backstopReason(script)
}

const maxCommandLength = 64 * 1024
const maxWork = 50_000

export function commandBlockReason(
  command: string,
  options: { readOnly?: boolean; shell?: ShellContext } = {},
): string | null {
  if (command.length > maxCommandLength) return tooLong
  if (command.includes('\r')) return carriageReturn
  try {
    return scriptBlockReason(command, {
      readOnly: options.readOnly ?? false,
      shell: options.shell,
      depth: 0,
      checkedFunctions: new Set(),
      budget: { left: maxWork },
    })
  } catch (error) {
    return error instanceof Refusal ? error.message : tooComplex
  }
}

const editTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

function linkTarget(path: string): string | null | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null
  } catch {
    return undefined
  }
}

function realPath(path: string): string {
  const pending = path.split('/').reverse()
  const parts: string[] = []
  let missing = 0
  let links = 0
  while (pending.length > 0) {
    const part = pending.pop()!
    if (part === '' || part === '.') continue
    if (part === '..') {
      parts.pop()
      if (missing > 0) missing -= 1
      continue
    }
    parts.push(part)
    if (missing > 0) {
      missing += 1
      continue
    }
    const target = linkTarget(`/${parts.join('/')}`)
    if (target === undefined) missing = 1
    else if (target !== null) {
      links += 1
      if (links > 40) throw new Error('Too many symbolic links')
      parts.pop()
      if (target.startsWith('/')) parts.length = 0
      pending.push(...target.split('/').reverse())
    }
  }
  return `/${parts.join('/')}`
}

function isInside(file: string, worktree: string) {
  const base = resolve(worktree)
  const root = realPath(base)
  const candidates = [resolve(base, file), isAbsolute(file) ? file : `${base}/${file}`]
  return candidates.every((candidate) => {
    const path = relative(root, realPath(candidate))
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  })
}

function editPath(file: string): string | null {
  const path = file.trim()
  if (path === '~' || path.startsWith('~/')) return `${homedir()}${path.slice(1)}`
  return path.startsWith('~') ? null : path
}

function editPathReason(files: string[], worktree: string): string | null {
  try {
    const inside = files.every((file) => {
      const path = editPath(file)
      return path !== null && isInside(path, worktree)
    })
    return inside ? null : 'Edits are limited to the pull request worktree'
  } catch {
    return 'PRism could not check this file path. Use a plain path inside the worktree.'
  }
}

export function toolBlockReason(
  toolName: string,
  input: Record<string, unknown>,
  options: { readOnly: boolean; worktree: string; shell?: ShellContext },
): string | null {
  try {
    if (typeof input.command === 'string') {
      const reason = commandBlockReason(input.command, {
        readOnly: options.readOnly,
        shell: options.shell,
      })
      if (reason) return reason
    }
    if (!editTools.has(toolName)) return null
    if (options.readOnly) return 'This stage is read-only: report findings instead of editing files'
    const files = [input.file_path, input.notebook_path].filter(
      (file): file is string => typeof file === 'string',
    )
    return editPathReason(files, options.worktree)
  } catch {
    return 'PRism could not check this tool call.'
  }
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

export function pushBlockEnv(
  base: Record<string, string> = {},
  urls: string[] = [],
): Record<string, string> {
  const existing = Number(base.GIT_CONFIG_COUNT ?? 0)
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0
  const values = [...new Set([...pushBlockedUrls, ...urls])]
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(start + values.length),
  }
  values.forEach((url, offset) => {
    env[`GIT_CONFIG_KEY_${start + offset}`] = 'url.prism-push-blocked://.pushInsteadOf'
    env[`GIT_CONFIG_VALUE_${start + offset}`] = url
  })
  return env
}
