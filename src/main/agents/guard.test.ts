import { execFile } from 'node:child_process'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  commandBlockReason,
  ghBlockReason,
  ghShimScript,
  prePushHookScript,
  tokenize,
  toolBlockReason,
} from './guard'

describe('command guard', () => {
  it.each([
    'git commit -m "x"',
    'git push',
    'git -C /tmp/x push origin HEAD',
    'git -c core.hooksPath=/dev/null push --force',
    'git reset --hard HEAD~1',
    'cd repo && git add . && git commit -m wip',
    'FOO=1 git push',
    '/usr/bin/git push',
    'bash -c "git push origin main"',
    'gh pr review 12 --approve',
    'gh pr comment 12 --body hi',
    'gh pr merge 12',
    'gh issue comment 3 -b x',
    'gh api -X POST repos/acme/app/issues/1/comments -f body=x',
    'gh api repos/acme/app/pulls/1/reviews -f event=APPROVE',
    'gh api --method=PATCH repos/acme/app/pulls/1',
    "gh api graphql -f query='mutation { addComment }'",
    'echo ok; git push',
  ])('blocks %s', (command) => {
    expect(commandBlockReason(command)).not.toBeNull()
  })

  it.each([
    'git status',
    'git diff origin/main...HEAD',
    'git log --oneline -20',
    'git reset --soft HEAD',
    'git fetch origin',
    'gh pr view 12 --comments',
    'gh pr diff 12',
    'gh api repos/acme/app/pulls/1/comments',
    'gh api -X GET search/issues -f q=bug',
    "gh api graphql -f query='query { viewer { login } }'",
    'pnpm test -- --grep "push notifications"',
    'rg "commit" src',
  ])('allows %s', (command) => {
    expect(commandBlockReason(command)).toBeNull()
  })

  it('tokenizes quotes and operators', () => {
    expect(tokenize(`a "b c" 'd' e&&f`)).toEqual(['a', 'b c', 'd', 'e', '&', '&', 'f'])
  })

  it('reports gh reasons', () => {
    expect(ghBlockReason(['pr', 'create'])).toBe('gh pr create is blocked')
    expect(ghBlockReason(['--version'])).toBeNull()
  })

  it('guards edits by stage and worktree', () => {
    const options = { readOnly: false, worktree: '/w/pr-1' }
    expect(toolBlockReason('Edit', { file_path: '/w/pr-1/a.ts' }, options)).toBeNull()
    expect(toolBlockReason('Edit', { file_path: '/w/pr-10/a.ts' }, options)).not.toBeNull()
    expect(
      toolBlockReason('Write', { file_path: '/w/pr-1/a.ts' }, { ...options, readOnly: true }),
    ).not.toBeNull()
    expect(toolBlockReason('Read', { file_path: '/etc/hosts' }, options)).toBeNull()
  })
})

function sh(file: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string }>((done) => {
    execFile(file, args, { env: { PATH: '/usr/bin:/bin', ...env } }, (error, stdout) =>
      done({ code: error ? Number(error.code ?? 1) : 0, stdout }),
    )
  })
}

describe('gh shim', () => {
  it('passes reads through and refuses writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-shim-'))
    const real = join(dir, 'real-gh')
    await writeFile(real, '#!/bin/sh\necho "real $*"\n')
    const shim = join(dir, 'gh')
    await writeFile(shim, ghShimScript(real))
    await Promise.all([chmod(real, 0o755), chmod(shim, 0o755)])

    expect(await sh(shim, ['pr', 'view', '12'])).toEqual({ code: 0, stdout: 'real pr view 12\n' })
    expect((await sh(shim, ['api', 'repos/acme/app/pulls/1'])).code).toBe(0)
    expect((await sh(shim, ['api', '-X', 'get', 'search/issues', '-f', 'q=x'])).code).toBe(0)
    expect((await sh(shim, ['api', 'graphql', '-f', 'query=query { a }'])).code).toBe(0)
    expect((await sh(shim, ['pr', 'comment', '12'])).code).toBe(1)
    expect((await sh(shim, ['pr', 'review', '12', '--approve'])).code).toBe(1)
    expect((await sh(shim, ['api', '-X', 'POST', 'repos/a/b/issues'])).code).toBe(1)
    expect((await sh(shim, ['api', 'repos/a/b/issues', '-f', 'title=x'])).code).toBe(1)
    expect((await sh(shim, ['api', 'graphql', '-f', 'query=mutation { a }'])).code).toBe(1)
    expect((await sh(shim, ['auth', 'token'])).code).toBe(1)
  })

  it('refuses a push without the nonce', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'prism-hook-'))
    const hook = join(dir, 'pre-push')
    const nonce = join(dir, 'nonce')
    await writeFile(hook, prePushHookScript(nonce))
    await chmod(hook, 0o755)
    expect((await sh(hook, [])).code).toBe(1)
    await writeFile(nonce, 'abc')
    expect((await sh(hook, [], { PRISM_PUSH_NONCE: 'nope' })).code).toBe(1)
    expect((await sh(hook, [], { PRISM_PUSH_NONCE: 'abc' })).code).toBe(0)
  })
})
