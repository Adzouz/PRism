import { stages, type Manifest, type ScannedSkill, type Stage } from '@shared/domain'

const keywords: Record<Stage, { names: string[]; words: string[] }> = {
  review: {
    names: ['pr-review', 'code-review', 'review-pr', 'review'],
    words: [
      'review a pr',
      'review the pr',
      'pull request review',
      'code review',
      'review a branch',
    ],
  },
  're-review': {
    names: ['re-review', 'rereview', 'pr-re-review', 'incremental-review'],
    words: ['re-review', 'incremental review', 'review again'],
  },
  'test-plan': {
    names: ['test-plan', 'pr-test-plan', 'how-to-test', 'qa-plan'],
    words: ['test plan', 'how to test', 'testing instructions'],
  },
  address: {
    names: ['address-comments', 'address-review', 'pr-address', 'fix-comments'],
    words: ['address review comments', 'address comments', 'review comments', 'resolve threads'],
  },
  'draft-replies': {
    names: ['draft-replies', 'reply-comments', 'pr-replies', 'replies'],
    words: ['draft replies', 'reply to review', 'reply to comments', 'replies'],
  },
}

function score(skill: ScannedSkill, stage: Stage) {
  const name = skill.name.toLowerCase()
  const description = skill.description.toLowerCase()
  const { names, words } = keywords[stage]
  if (stage === 'review' && /re-?review|address|repl/.test(name)) return 0
  const nameIndex = names.indexOf(name)
  if (nameIndex !== -1) return 100 - nameIndex
  if (names.some((candidate) => name.includes(candidate))) return 50
  const wordIndex = words.findIndex((word) => description.includes(word))
  return wordIndex === -1 ? 0 : 20 - wordIndex
}

export type Match = { stage: Stage; skill: ScannedSkill | null; reason: 'hint' | 'match' | 'none' }

export function proposeFromSource(
  skills: ScannedSkill[],
  manifest: Manifest | null,
  identity: string | null,
): Match[] {
  const usable = skills.filter((skill) => skill.identity === null || skill.identity === identity)
  return stages.map((stage) => {
    for (const hint of manifest?.stageHints?.[stage] ?? []) {
      const hit =
        usable.find((skill) => skill.name === hint && skill.identity === identity) ??
        usable.find((skill) => skill.name === hint)
      if (hit) return { stage, skill: hit, reason: 'hint' }
    }
    let best: ScannedSkill | null = null
    let bestScore = 0
    for (const skill of usable) {
      const value = score(skill, stage)
      if (value > bestScore) {
        best = skill
        bestScore = value
      }
    }
    return { stage, skill: best, reason: best ? 'match' : 'none' }
  })
}
