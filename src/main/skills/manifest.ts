import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { manifest as manifestSchema, type Manifest, type ScannedSkill } from '@shared/domain'
import { scanSkills } from './scan'

export const manifestFile = 'prism-source.json'

export async function readManifest(
  dir: string,
): Promise<{ manifest: Manifest | null; error: string | null }> {
  let text: string
  try {
    text = await readFile(join(dir, manifestFile), 'utf8')
  } catch {
    return { manifest: null, error: null }
  }
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(stripJsonComments(text)))
    if (parsed.success) return { manifest: parsed.data, error: null }
    return { manifest: null, error: parsed.error.issues.map((issue) => issue.message).join('; ') }
  } catch (error) {
    return { manifest: null, error: (error as Error).message }
  }
}

export function stripJsonComments(text: string) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      out += char
      if (char === '\\') out += text[++i] ?? ''
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else {
      out += char
    }
  }
  return out
}

export async function listIdentities(dir: string, manifest: Manifest | null) {
  const pattern = manifest?.identities?.list
  if (!pattern) return []
  const segments = pattern.split('/').filter(Boolean)
  const starIndex = segments.lastIndexOf('*')
  if (starIndex === -1) return []
  const results = new Set<string>()
  async function walk(base: string, index: number, captured: string | null) {
    if (index === segments.length) {
      if (captured) results.add(captured)
      return
    }
    const segment = segments[index]!
    if (segment !== '*') {
      await walk(join(base, segment), index + 1, captured)
      return
    }
    const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      await walk(join(base, entry.name), index + 1, index === starIndex ? entry.name : captured)
    }
  }
  await walk(dir, 0, null)
  return [...results].sort((a, b) => a.localeCompare(b))
}

export function readJsonPath(data: unknown, path: string) {
  const keys = path
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean)
  let value: unknown = data
  for (const key of keys) {
    if (value === null || typeof value !== 'object') return null
    value = (value as Record<string, unknown>)[key]
  }
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export async function currentIdentity(dir: string, manifest: Manifest | null) {
  const current = manifest?.identities?.current
  if (!current) return null
  try {
    const data = JSON.parse(await readFile(join(dir, current.file), 'utf8')) as unknown
    return readJsonPath(data, current.jsonPath)
  } catch {
    return null
  }
}

export async function scanSource(
  dir: string,
  manifest: Manifest | null,
  identities: string[],
): Promise<ScannedSkill[]> {
  const roots = manifest?.skillRoots ?? ['.']
  const results: ScannedSkill[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    const targets = root.includes('{identity}')
      ? identities.map((identity) => ({ path: root.replaceAll('{identity}', identity), identity }))
      : [{ path: root, identity: null }]
    for (const target of targets) {
      for (const skill of await scanSkills(join(dir, target.path), {
        base: dir,
        identity: target.identity,
      })) {
        if (seen.has(skill.dir)) continue
        seen.add(skill.dir)
        results.push(skill)
      }
    }
  }
  return results
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function importCommand(template: string, from: string, skills: string[]) {
  return template
    .replaceAll('{from}', shellQuote(from))
    .replaceAll('{skills}', skills.map(shellQuote).join(' '))
}
