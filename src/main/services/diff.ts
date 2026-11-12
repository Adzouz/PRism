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

export function parseUnifiedDiff(text: string): DiffMap {
  const map: DiffMap = new Map()
  for (const section of text.split(/^diff --git /m).slice(1)) {
    const lines = section.split('\n')
    const target = lines.find((line) => line.startsWith('+++ '))
    const source = lines.find((line) => line.startsWith('--- '))
    const path =
      target && target !== '+++ /dev/null'
        ? headerPath(target).replace(/^b\//, '')
        : source && headerPath(source).replace(/^a\//, '')
    if (!path) continue
    const start = lines.findIndex((line) => line.startsWith('@@ '))
    map.set(path, commentableLines(start === -1 ? '' : lines.slice(start).join('\n')))
  }
  return map
}

const escapes: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
}

function headerPath(line: string) {
  const raw = line.slice(4).replace(/\t$/, '')
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw
  const bytes: number[] = []
  for (const [token, escaped] of raw.slice(1, -1).matchAll(/\\([0-7]{3}|.)|[^\\]+/gs)) {
    if (escaped === undefined) bytes.push(...Buffer.from(token))
    else if (escaped.length === 3) bytes.push(parseInt(escaped, 8))
    else bytes.push(escapes[escaped] ?? escaped.charCodeAt(0))
  }
  return Buffer.from(bytes).toString('utf8')
}
