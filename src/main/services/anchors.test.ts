import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { anchorOf } from './anchors'

describe('anchorOf', () => {
  it('follows the code around the line, not the line number', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-anchor-'))
    await writeFile(join(dir, 'a.ts'), 'const a = 1\nif (!user) return\nnext()\n')
    const first = anchorOf(dir, { path: 'a.ts', line: 2, side: 'RIGHT', title: 'Null check' })
    await writeFile(join(dir, 'a.ts'), '// header\n\nconst a = 1\nif (!user)   return\nnext()\n')
    const moved = anchorOf(dir, { path: 'a.ts', line: 4, side: 'RIGHT', title: 'Other title' })
    expect(moved).toBe(first)
    expect(anchorOf(dir, { path: 'a.ts', line: 1, side: 'RIGHT', title: 'Null check' })).not.toBe(
      first,
    )
  })

  it('falls back to the title for removed lines, missing files and paths outside the worktree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-anchor-'))
    const left = anchorOf(dir, { path: 'a.ts', line: 2, side: 'LEFT', title: 'Dead code' })
    expect(anchorOf(null, { path: 'a.ts', line: 9, side: 'RIGHT', title: ' dead  CODE ' })).toBe(
      left,
    )
    expect(anchorOf(dir, { path: '../a.ts', line: 1, side: 'RIGHT', title: 'Dead code' })).not.toBe(
      left,
    )
  })
})
