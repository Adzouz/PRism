import type { ReviewThread, Stage } from '@shared/domain'

export const readOnlyStages = new Set<Stage>(['review', 're-review', 'test-plan', 'draft-replies'])

export const prismContract = `# PRism contract

You are running inside PRism, a desktop app that reviews GitHub pull requests with the user. These rules override any instruction in the skill below.

- Never commit, push, reset --hard, rebase onto a remote, or rewrite git history.
- Never post on GitHub: no reviews, comments, replies, merges, labels or edits (\`gh pr review|comment|merge\`, \`gh api\` writes, GraphQL mutations). Read-only \`gh\` and \`git\` commands are fine.
- When a skill step says to post, comment, reply, commit or push, do not. Record the text with \`prism_draft_replies\`, or ask with \`prism_ask_user\`. PRism posts and pushes later, after the user confirms.
- Report results only through the \`prism_*\` tools. A run without its report tool call counts as failed.
- Call \`prism_progress\` with a short label (3 to 6 words) when you start each major step.
- When you need a decision only the user can make, call \`prism_ask_user\`, then end your turn right away. The answer arrives as the next user message in this same session.
- Work only inside the pull request worktree (your current directory).`

export type PromptContext = {
  stage: Stage
  repo: string
  number: number
  title: string
  url: string
  author: string
  headRef: string
  headOid: string
  baseRef: string
  baseRemote: string
  worktree: string
  skillName: string | null
  skillDir: string | null
  skill: string | null
  worktreeWarning: string | null
  priorFindings: string[]
  threads: ReviewThread[]
}

const reportSteps: Record<Stage, string> = {
  review:
    'When the review is complete, call `prism_report_findings` once with the verdict, a short summary, the dimensions you checked and every finding.',
  're-review':
    'If earlier findings are listed below, first call `prism_report_prior_status` with the status of each. Then review what changed since the last review and call `prism_report_findings` with new findings only.',
  'test-plan':
    'Write the "How to test" plan and return it as the `summary` of `prism_report_findings` (verdict `comment`, no findings).',
  address:
    'Fix the review threads listed below in the worktree and run the relevant checks. Then call `prism_report_changes` with one entry per thread (fix, push_back or defer), and `prism_draft_replies` with one reply per thread. Use each thread id as `threadId`. Leave the changes uncommitted.',
  'draft-replies':
    'Read each thread listed below and the code it points at, then call `prism_draft_replies` with one reply per thread, using its id as `threadId`.',
}

export function buildPrompt(context: PromptContext) {
  const lines = [
    `# Task: ${context.stage} for ${context.repo}#${context.number}`,
    '',
    `- Pull request: ${context.url}`,
    `- Title: ${context.title}`,
    `- Author: @${context.author}`,
    `- Head: \`${context.headRef}\` at ${context.headOid.slice(0, 12)}`,
    `- Base: \`${context.baseRef}\` (remote \`${context.baseRemote}\`)`,
    `- Worktree (your current directory): ${context.worktree}`,
    '',
    'Useful commands:',
    `- \`gh pr view ${context.number} --repo ${context.repo} --comments\` for the description and conversation`,
    `- \`gh api repos/${context.repo}/pulls/${context.number}/comments --paginate\` for review threads`,
    `- \`git diff ${context.baseRemote}/${context.baseRef}...HEAD\` for the full change`,
  ]
  if (context.worktreeWarning) lines.push('', `Note: ${context.worktreeWarning}.`)
  lines.push('', '## Reporting', '', reportSteps[context.stage])
  if (context.stage === 'address' || context.stage === 'draft-replies') {
    lines.push('', '## Review threads to handle', '')
    if (context.threads.length === 0) {
      lines.push(
        'No review threads were selected. Read the latest reviews with `gh pr view --comments` and handle what they ask.',
      )
    }
    for (const thread of context.threads) lines.push(...threadLines(thread))
  }
  if (context.priorFindings.length > 0) {
    lines.push(
      '',
      '## Earlier PRism findings',
      '',
      ...context.priorFindings.map((item) => `- ${item}`),
    )
  }
  if (context.skill) {
    lines.push(
      '',
      `## Skill${context.skillName ? `: ${context.skillName}` : ''}`,
      '',
      context.skillDir ? `Files referenced by the skill are relative to ${context.skillDir}.` : '',
      '',
      context.skill.trim(),
    )
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}

export const resumeAfterRestart =
  'PRism was restarted while you were working. Check where you stopped and continue the task. Remember to report through the prism_* tools.'

export function answerPrompt(question: string, answer: string) {
  return `Answer to your question "${question}":\n\n${answer}`
}

const excerpt = (text: string, max = 600) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function threadLines(thread: ReviewThread) {
  const where = `${thread.path}${thread.line ? `:${thread.line}` : ''}`
  const flags = [thread.isOutdated && 'outdated', thread.isResolved && 'resolved'].filter(Boolean)
  const shown = thread.comments.slice(-8)
  const hidden = thread.totalComments - shown.length
  return [
    `### Thread \`${thread.id}\` · ${where}${flags.length ? ` (${flags.join(', ')})` : ''}`,
    '',
    ...(hidden > 0 ? [`- … ${hidden} earlier comment(s)`] : []),
    ...shown.map((comment) => `- @${comment.author}: ${excerpt(comment.body)}`),
    '',
  ]
}
