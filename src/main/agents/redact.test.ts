import { describe, expect, it } from 'vitest'
import { redact, redactText } from './redact'

const gh = `ghp_${'a1B2'.repeat(9)}`

describe('redact', () => {
  it('removes known secret shapes', () => {
    expect(redactText(`token=${gh}`)).toBe('token=[redacted]')
    expect(redactText(`key sk-proj-${'ab_cd-EF'.repeat(5)}`)).toBe('key [redacted]')
    expect(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe(
      'Authorization: [redacted]',
    )
    expect(redactText('curl -H "Authorization: token 0123456789abcdef"')).toBe(
      'curl -H "[redacted]"',
    )
    expect(redactText(`AKIA${'WXYZ'.repeat(4)}`)).toBe('[redacted]')
  })

  it('leaves ordinary code alone', () => {
    const code = 'const token = refreshAccessTokenForTheCurrentUserSession()'
    expect(redactText(code)).toBe(code)
    expect(redactText('token someVeryLongIdentifierNameInTheCode')).toBe(
      'token someVeryLongIdentifierNameInTheCode',
    )
  })

  it('walks nested values', () => {
    expect(redact({ list: [gh], nested: { text: `use ${gh}` }, count: 2 })).toEqual({
      list: ['[redacted]'],
      nested: { text: 'use [redacted]' },
      count: 2,
    })
  })
})
