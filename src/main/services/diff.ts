export type Side = 'LEFT' | 'RIGHT'

export type CommentableLines = Record<Side, Set<number>>

export function commentableLines(patch: string | undefined): CommentableLines {
  const lines: CommentableLines = { LEFT: new Set(), RIGHT: new Set() }
  if (!patch) return lines
  let left = 0
  let right = 0
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      left = Number(hunk[1])
      right = Number(hunk[2])
      continue
    }
    if (left === 0 && right === 0) continue
    if (line.startsWith('+')) {
      lines.RIGHT.add(right)
      right += 1
    } else if (line.startsWith('-')) {
      lines.LEFT.add(left)
      left += 1
    } else if (line.startsWith(' ')) {
      lines.LEFT.add(left)
      lines.RIGHT.add(right)
      left += 1
      right += 1
    }
  }
  return lines
}

export type DiffMap = Map<string, CommentableLines>

export function diffMap(files: { filename: string; patch?: string }[]): DiffMap {
  return new Map(files.map((file) => [file.filename, commentableLines(file.patch)]))
}

export function isCommentable(
  map: DiffMap,
  finding: { path: string; line: number | null; side: Side },
) {
  if (finding.line === null) return false
  return map.get(finding.path)?.[finding.side].has(finding.line) ?? false
}
