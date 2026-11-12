import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase()

const maxFileBytes = 2 * 1024 * 1024

function lineWindow(worktree: string, path: string, line: number) {
  const file = resolve(worktree, path)
  const rel = relative(worktree, file)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  try {
    if (statSync(file).size > maxFileBytes) return null
    const rows = readFileSync(file, 'utf8').split('\n')
    const window = rows
      .slice(Math.max(0, line - 2), line + 1)
      .map(normalize)
      .join('\n')
    return normalize(rows[line - 1] ?? '') ? window : null
  } catch {
    return null
  }
}

export type Anchorable = {
  path: string
  line: number | null
  side: 'LEFT' | 'RIGHT'
  title: string
}

export function anchorOf(worktree: string | null, finding: Anchorable) {
  const window =
    worktree && finding.line && finding.side === 'RIGHT'
      ? lineWindow(worktree, finding.path, finding.line)
      : null
  const key = window ? `code:${window}` : `title:${normalize(finding.title)}`
  return createHash('sha1').update(`${finding.path}\n${key}`).digest('hex').slice(0, 16)
}

export const titleKey = (path: string, title: string) => `${path}\n${normalize(title)}`
