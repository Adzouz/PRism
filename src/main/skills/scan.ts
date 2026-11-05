import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { parse } from 'yaml'
import type { ScannedSkill } from '@shared/domain'

export type Frontmatter = { name: string; description: string }

export function parseFrontmatter(text: string): Frontmatter | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return null
  try {
    const data = parse(match[1] ?? '') as Record<string, unknown> | null
    if (!data || typeof data.name !== 'string') return null
    return {
      name: data.name.trim(),
      description: typeof data.description === 'string' ? data.description.trim() : '',
    }
  } catch {
    return null
  }
}

export async function readSkillFile(file: string): Promise<Frontmatter> {
  const text = await readFile(file, 'utf8')
  return (
    parseFrontmatter(text) ?? {
      name: basename(file)
        .replace(/\.md$/i, '')
        .replace(/^SKILL$/i, basename(join(file, '..'))),
      description: '',
    }
  )
}

const ignored = new Set(['.git', 'node_modules'])

export async function scanSkills(
  root: string,
  options: { base?: string; identity?: string | null } = {},
): Promise<ScannedSkill[]> {
  const base = options.base ?? root
  const found: ScannedSkill[] = []
  async function walk(dir: string, depth: number) {
    if (depth > 8) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const skillFile = entries.find((entry) => entry.isFile() && entry.name === 'SKILL.md')
    if (skillFile) {
      const text = await readFile(join(dir, skillFile.name), 'utf8')
      const frontmatter = parseFrontmatter(text)
      if (frontmatter) {
        found.push({
          ...frontmatter,
          dir,
          relDir: relative(base, dir) || '.',
          identity: options.identity ?? null,
        })
      }
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !ignored.has(entry.name))
        await walk(join(dir, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return found.sort((a, b) => a.relDir.localeCompare(b.relDir))
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue
    const rel = join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(dir, rel)))
    else if (entry.isFile()) files.push(rel)
  }
  return files
}

export async function hashPath(path: string) {
  const hash = createHash('sha256')
  const info = await stat(path).catch(() => null)
  if (!info) return 'missing'
  if (info.isFile()) {
    hash.update(await readFile(path))
    return hash.digest('hex')
  }
  for (const file of (await listFiles(path)).sort()) {
    hash.update(file)
    hash.update('\0')
    hash.update(await readFile(join(path, file)))
    hash.update('\0')
  }
  return hash.digest('hex')
}
