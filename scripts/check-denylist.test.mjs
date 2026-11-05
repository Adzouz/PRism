import { describe, expect, it } from 'vitest'
import { buildPatterns, parseTerms, scan } from './check-denylist.mjs'

describe('denylist check', () => {
  it('parses terms from lines and commas, skipping comments', () => {
    expect(parseTerms('# private\nacme-internal, secret-team\n\n')).toEqual([
      'acme-internal',
      'secret-team',
    ])
  })

  it('flags private terms case-insensitively and builtin secrets', () => {
    const patterns = buildPatterns(['acme-internal'])
    const hits = scan(
      [
        { path: 'a.ts', content: 'ok\nsee ACME-Internal docs' },
        { path: 'b.ts', content: `token = "ghp_${'a'.repeat(36)}"` },
        { path: 'c.ts', content: 'nothing here' },
      ],
      patterns,
    )
    expect(hits).toEqual([
      { path: 'a.ts', line: 2, name: 'Denylisted term' },
      { path: 'b.ts', line: 1, name: 'GitHub token' },
    ])
  })
})
