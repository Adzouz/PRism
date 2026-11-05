import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  importCommand,
  listIdentities,
  readJsonPath,
  readManifest,
  scanSource,
  stripJsonComments,
} from './manifest'
import { proposeFromSource } from './match'
import { hashPath, parseFrontmatter } from './scan'

async function skill(root: string, rel: string, name: string, description = '') {
  await mkdir(join(root, rel), { recursive: true })
  await writeFile(
    join(root, rel, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${description}"\nargument-hint: x\n---\n\nBody`,
  )
}

describe('frontmatter', () => {
  it('reads name and description and ignores extras', () => {
    expect(parseFrontmatter('---\nname: a\ndescription: "b: c"\nextra: 1\n---\nx')).toEqual({
      name: 'a',
      description: 'b: c',
    })
  })

  it('rejects files without a name', () => {
    expect(parseFrontmatter('# no frontmatter')).toBeNull()
    expect(parseFrontmatter('---\ndescription: x\n---')).toBeNull()
  })
})

describe('manifest', () => {
  it('strips comments but keeps strings', () => {
    const text = '{\n  "a": "http://x", // note\n  /* block */ "b": 1\n}'
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 'http://x', b: 1 })
  })

  it('reads json paths', () => {
    expect(readJsonPath({ user: { name: 'ada' } }, '$.user.name')).toBe('ada')
    expect(readJsonPath({ user: 'x' }, '$.user.name')).toBeNull()
  })

  it('quotes import command values', () => {
    expect(importCommand('tool steal {from} --skills {skills}', "o'neil", ['a', 'b c'])).toBe(
      `tool steal 'o'\\''neil' --skills 'a' 'b c'`,
    )
  })

  it('lists identities, current identity, and scans identity roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-src-'))
    await writeFile(
      join(root, 'prism-source.json'),
      JSON.stringify({
        identities: { list: 'people/*', current: { file: 'local.json', jsonPath: '$.me' } },
        skillRoots: ['shared', 'people/{identity}/skills'],
        stageHints: { review: ['pr-review'] },
      }),
    )
    await skill(root, 'shared/lint', 'lint')
    await skill(root, 'people/ada/skills/pr-review', 'pr-review', 'Review a PR')
    await skill(root, 'people/bob/skills/pr-review', 'pr-review', 'Review a PR')
    await skill(root, 'people/bob/skills/address-comments', 'address-comments')
    await mkdir(join(root, 'people/.hidden'), { recursive: true })

    const { manifest } = await readManifest(root)
    const identities = await listIdentities(root, manifest)
    expect(identities).toEqual(['ada', 'bob'])

    const scanned = await scanSource(root, manifest, identities)
    expect(scanned.map((s) => `${s.identity ?? '-'}:${s.relDir}`)).toEqual([
      '-:shared/lint',
      'ada:people/ada/skills/pr-review',
      'bob:people/bob/skills/address-comments',
      'bob:people/bob/skills/pr-review',
    ])

    const proposals = proposeFromSource(scanned, manifest, 'ada')
    expect(proposals.find((p) => p.stage === 'review')).toMatchObject({
      reason: 'hint',
      skill: { identity: 'ada' },
    })
    expect(proposals.find((p) => p.stage === 'address')?.reason).toBe('none')
  })

  it('reports invalid manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-src-'))
    await writeFile(join(root, 'prism-source.json'), '{"setup": "not-an-array"}')
    const result = await readManifest(root)
    expect(result.manifest).toBeNull()
    expect(result.error).toBeTruthy()
  })
})

describe('matching', () => {
  const s = (name: string, description = '') => ({
    name,
    description,
    dir: `/x/${name}`,
    relDir: name,
    identity: null,
  })

  it('matches by name, then description, and keeps review out of re-review', () => {
    const proposals = proposeFromSource(
      [s('code-review'), s('pr-re-review'), s('helper', 'Write a test plan for the PR')],
      null,
      null,
    )
    const byStage = Object.fromEntries(proposals.map((p) => [p.stage, p.skill?.name ?? null]))
    expect(byStage).toEqual({
      review: 'code-review',
      're-review': 'pr-re-review',
      'test-plan': 'helper',
      address: null,
      'draft-replies': null,
    })
  })
})

describe('hashPath', () => {
  it('changes when a nested file changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-hash-'))
    await skill(root, 'a', 'a')
    await mkdir(join(root, 'a/agents'))
    await writeFile(join(root, 'a/agents/x.md'), '1')
    const before = await hashPath(join(root, 'a'))
    await writeFile(join(root, 'a/agents/x.md'), '2')
    expect(await hashPath(join(root, 'a'))).not.toBe(before)
  })
})
