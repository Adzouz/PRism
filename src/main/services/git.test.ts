import { describe, expect, it } from 'vitest'
import { parseRepoInput } from '@shared/domain'
import { parseScopes } from './github'
import { githubUrl, isRemoteUrl, normalizeRemote } from './git'
import { parseSourceInput } from './sources'

describe('git remotes', () => {
  it('normalizes ssh and https urls to the same key', () => {
    const key = 'github.com/acme/skills'
    expect(normalizeRemote('git@github.com:Acme/skills.git')).toBe(key)
    expect(normalizeRemote('https://github.com/acme/skills')).toBe(key)
    expect(normalizeRemote('https://user@github.com/acme/skills.git/')).toBe(key)
    expect(normalizeRemote('ssh://git@github.com/acme/skills.git')).toBe(key)
  })

  it('detects urls and expands owner/name', () => {
    expect(isRemoteUrl('git@github.com:a/b.git')).toBe(true)
    expect(isRemoteUrl('acme/skills')).toBe(false)
    expect(githubUrl('acme/skills')).toBe('https://github.com/acme/skills')
  })

  it('parses source input', () => {
    expect(parseSourceInput('mattpocock/skills')).toMatchObject({
      kind: 'git',
      name: 'mattpocock/skills',
    })
    expect(parseSourceInput('/tmp/my-skills')).toMatchObject({ kind: 'local', name: 'my-skills' })
    expect(() => parseSourceInput('nope')).toThrow('Enter a git URL')
  })
})

describe('gh scopes', () => {
  it('reads the token scopes line', () => {
    const output = "  - Token: gho_***\n  - Token scopes: 'gist', 'read:org', 'repo'\n"
    expect(parseScopes(output)).toEqual(['gist', 'read:org', 'repo'])
  })
})

describe('repo input', () => {
  it('accepts owner/name, urls and ssh remotes', () => {
    expect(parseRepoInput('acme/app')).toBe('acme/app')
    expect(parseRepoInput('https://github.com/acme/app')).toBe('acme/app')
    expect(parseRepoInput('github.com/acme/app.git')).toBe('acme/app')
    expect(parseRepoInput('https://github.com/acme/app/pull/12')).toBe('acme/app')
    expect(parseRepoInput('git@github.com:acme/app.git')).toBe('acme/app')
    expect(parseRepoInput('acme')).toBeNull()
    expect(parseRepoInput('https://gitlab.com/acme/app')).toBeNull()
  })
})
