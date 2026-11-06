import { describe, expect, it } from 'vitest'
import { answerPrompt, buildPrompt, prismContract, type PromptContext } from './prompt'

const context: PromptContext = {
  stage: 're-review',
  repo: 'acme/app',
  number: 12,
  title: 'Add cache',
  url: 'https://github.com/acme/app/pull/12',
  author: 'octocat',
  headRef: 'feature/cache',
  headOid: '0123456789abcdef',
  baseRef: 'main',
  baseRemote: 'upstream',
  worktree: '/code/app-worktrees/pr-12',
  skillName: 'pr-re-review',
  skillDir: '/skills/pr-re-review',
  skill: '# Re-review\n\nCheck the delta.',
  worktreeWarning: null,
  priorFindings: ['#4 [blocking] src/a.ts:3 Null check (open)'],
  threads: [],
}

describe('prompt', () => {
  it('includes the pull request, skill, prior findings and reporting step', () => {
    const prompt = buildPrompt(context)
    expect(prompt).toContain('acme/app#12')
    expect(prompt).toContain('git diff upstream/main...HEAD')
    expect(prompt).toContain('prism_report_prior_status')
    expect(prompt).toContain('- #4 [blocking] src/a.ts:3 Null check (open)')
    expect(prompt).toContain('Check the delta.')
    expect(prompt).toContain('relative to /skills/pr-re-review')
    expect(prompt).not.toMatch(/\n{3,}/)
  })

  it('works without a skill or prior findings', () => {
    const prompt = buildPrompt({ ...context, stage: 'review', skill: null, priorFindings: [] })
    expect(prompt).toContain('prism_report_findings')
    expect(prompt).not.toContain('## Skill')
    expect(prompt).not.toContain('Earlier PRism findings')
  })

  it('keeps the contract strict and answers readable', () => {
    expect(prismContract).toMatch(/Never commit, push/)
    expect(prismContract).toContain('prism_ask_user')
    expect(answerPrompt('Which base?', 'main')).toBe(
      'Answer to your question "Which base?":\n\nmain',
    )
  })

  it('lists the threads to handle for address runs', () => {
    const comment = (author: string, body: string) => ({
      id: author,
      author,
      avatar: null,
      body,
      createdAt: 0,
      url: '',
    })
    const prompt = buildPrompt({
      ...context,
      stage: 'address',
      priorFindings: [],
      threads: [
        {
          id: 'PRRT_1',
          path: 'src/a.ts',
          line: 7,
          isResolved: false,
          isOutdated: true,
          totalComments: 10,
          comments: Array.from({ length: 8 }, (_, index) => comment(`u${index}`, `note ${index}`)),
        },
      ],
    })
    expect(prompt).toContain('### Thread `PRRT_1` · src/a.ts:7 (outdated)')
    expect(prompt).toContain('- … 2 earlier comment(s)')
    expect(prompt).toContain('- @u7: note 7')
    expect(prompt).toContain('threadId')
    expect(buildPrompt({ ...context, stage: 'draft-replies', threads: [] })).toContain(
      'No review threads were selected',
    )
  })
})
