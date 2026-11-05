import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const builtinPatterns = [
  { name: 'GitHub token', regex: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { name: 'Anthropic key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI key', regex: /\bsk-(proj-)?[A-Za-z0-9]{32,}/ },
  { name: 'AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Apple app-specific password', regex: /\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b/ },
]

const skippedFiles = [/^pnpm-lock\.yaml$/, /\.(png|jpe?g|gif|icns|ico|woff2?|ttf)$/i]

export function parseTerms(text) {
  return text
    .split(/[\n,]/)
    .map((term) => term.trim())
    .filter((term) => term && !term.startsWith('#'))
}

function escapeRegex(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function buildPatterns(terms) {
  return [
    ...builtinPatterns,
    ...terms.map((term) => ({
      name: 'Denylisted term',
      regex: new RegExp(escapeRegex(term), 'i'),
    })),
  ]
}

export function scan(files, patterns) {
  const hits = []
  for (const { path, content } of files) {
    content.split('\n').forEach((line, index) => {
      for (const { name, regex } of patterns) {
        if (regex.test(line)) hits.push({ path, line: index + 1, name })
      }
    })
  }
  return hits
}

const skippedDirs = new Set(['.git', 'node_modules', 'out', 'dist'])

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = dir === '.' ? entry.name : join(dir, entry.name)
    if (entry.isDirectory()) return skippedDirs.has(entry.name) ? [] : walk(path)
    return entry.isFile() && entry.name !== '.denylist.local' ? [path] : []
  })
}

function candidateFiles() {
  let paths
  try {
    paths = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\0')
  } catch {
    paths = walk('.')
  }
  return paths.filter(
    (path) => path && existsSync(path) && !skippedFiles.some((re) => re.test(path)),
  )
}

function main() {
  const terms = [
    ...parseTerms(process.env.PRISM_DENYLIST ?? ''),
    ...(existsSync('.denylist.local') ? parseTerms(readFileSync('.denylist.local', 'utf8')) : []),
  ]
  const files = candidateFiles().map((path) => ({ path, content: readFileSync(path, 'utf8') }))
  const hits = scan(files, buildPatterns(terms))
  if (hits.length === 0) {
    console.log(`Denylist check passed (${files.length} files, ${terms.length} private terms).`)
    return
  }
  for (const hit of hits) console.error(`${hit.path}:${hit.line}  ${hit.name}`)
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
