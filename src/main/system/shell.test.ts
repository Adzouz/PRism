import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentShell, parseAliases, parseFunctions, probeShell, rcFile } from './shell'

const rc = `alias g=git
alias gst='git status'
alias grhh='git reset --hard'
alias quoted='echo it'\\''s'
ship() { git push "$@"; }
_complete_me() { git commit; }
__helper() { echo help; }
`

describe('shell probe', () => {
  it('parses alias listings from zsh and bash', () => {
    const aliases = parseAliases(
      [
        'g=git',
        "gst='git status'",
        "'gc!'='git commit --amend'",
        "alias quoted='echo it'\\''s'",
        "alias -- dash='ls -la'",
        "esc=$'printf \\'a\\\\tb\\''",
      ].join('\n'),
    )
    expect(Object.fromEntries(aliases)).toEqual({
      g: 'git',
      gst: 'git status',
      'gc!': 'git commit --amend',
      quoted: "echo it's",
      dash: 'ls -la',
      esc: "printf 'a\\tb'",
    })
  })

  it('keeps the first 1000 alias lines, like the CLI snapshot', () => {
    const lines = Array.from({ length: 1001 }, (_, index) => `a${index}=ls`)
    const aliases = parseAliases(lines.join('\n'))
    expect(aliases.has('a999')).toBe(true)
    expect(aliases.has('a1000')).toBe(false)
  })

  it('parses function bodies', () => {
    const functions = parseFunctions(
      '\n__PRISM_SHELL_FUNCTION__ ship\n\tgit push "$@"\n__PRISM_SHELL_FUNCTION__ -odd\n\techo a\n\techo b\n',
    )
    expect(functions.get('ship')).toBe('\tgit push "$@"')
    expect(functions.get('-odd')).toBe('\techo a\n\techo b\n')
  })

  it('picks the rc file the CLI sources', () => {
    expect(rcFile('/bin/zsh', '/h')).toBe('/h/.zshrc')
    expect(rcFile('/opt/homebrew/bin/bash', '/h')).toBe('/h/.bashrc')
    expect(rcFile('/bin/sh', '/h')).toBe('/h/.profile')
  })

  it('picks the shell the CLI runs commands in', () => {
    expect(agentShell({ SHELL: '/opt/homebrew/bin/bash' })).toBe('/opt/homebrew/bin/bash')
    expect(agentShell({ CLAUDE_CODE_SHELL: '/usr/local/bin/zsh', SHELL: '/bin/bash' })).toBe(
      '/usr/local/bin/zsh',
    )
    expect(agentShell({ SHELL: '/opt/homebrew/bin/fish' })).toBe('/bin/zsh')
    expect(agentShell({})).toBe('/bin/zsh')
  })

  it('fails when the probe does not finish', async () => {
    const home = await mkdtemp(join(tmpdir(), 'prism-home-'))
    await writeFile(join(home, '.bashrc'), `${rc}sleep 5\n`)
    await expect(probeShell({ shell: '/bin/bash', home, timeout: 500 })).rejects.toThrow(
      'did not finish',
    )
  })

  it('does not wait for input while sourcing the rc', async () => {
    const home = await mkdtemp(join(tmpdir(), 'prism-home-'))
    await writeFile(join(home, '.bashrc'), `read -r answer\n${rc}`)
    const context = await probeShell({ shell: '/bin/bash', home, timeout: 3000 })
    expect(context.aliases.get('g')).toBe('git')
  })

  it.skipIf(!existsSync('/bin/zsh'))('reads aliases and functions from a zsh rc', async () => {
    const home = await mkdtemp(join(tmpdir(), 'prism-home-'))
    await mkdir(join(home, 'functions'))
    await writeFile(join(home, 'functions/lazy'), 'git commit -m lazy\n')
    await writeFile(
      join(home, '.zshrc'),
      `${rc}alias -g G='| grep'\nfpath=(~/functions $fpath)\nautoload -U lazy\n`,
    )
    const context = await probeShell({ shell: '/bin/zsh', home })
    expect(context.aliases.get('g')).toBe('git')
    expect(context.aliases.get('grhh')).toBe('git reset --hard')
    expect(context.aliases.get('quoted')).toBe("echo it's")
    expect(context.aliases.get('G')).toBe('| grep')
    expect(context.functions.get('ship')).toContain('git push "$@"')
    expect(context.functions.get('lazy')).toContain('git commit -m lazy')
    expect(context.functions.get('__helper')).toContain('echo help')
    expect(context.functions.has('_complete_me')).toBe(false)
  })

  it('reads aliases and functions from a bash rc', async () => {
    const home = await mkdtemp(join(tmpdir(), 'prism-home-'))
    await writeFile(join(home, '.bashrc'), rc)
    const context = await probeShell({ shell: '/bin/bash', home })
    expect(context.aliases.get('gst')).toBe('git status')
    expect(context.functions.get('ship')?.trim()).toBe('git push "$@"')
    expect(context.functions.has('__helper')).toBe(true)
    expect(context.functions.has('_complete_me')).toBe(false)
  })

  it('returns an empty context when there is no rc file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'prism-home-'))
    const context = await probeShell({ shell: '/bin/bash', home })
    expect(context.aliases.get('g')).toBeUndefined()
    expect(context.functions.has('ship')).toBe(false)
  })
})
