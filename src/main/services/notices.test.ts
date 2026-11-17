import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Ask, BoardPr, BoardRun, Run } from '@shared/domain'
import { openDb } from '../db/client'
import { setSetting } from '../db/settings'
import type { Ctx } from './context'
import {
  clip,
  getNotificationSettings,
  needsYouItems,
  prNotice,
  runNotice,
  runningItems,
  setNotificationSettings,
  yourTurnItems,
} from './notices'

const migrations = resolve(__dirname, '../../../drizzle')

const makeCtx = (): Ctx => ({
  db: openDb(':memory:', migrations),
  userData: '',
  builtinSkillsDir: '',
  log: () => {},
  skillsChanged: () => {},
})

function boardRun(overrides: Partial<BoardRun> = {}): BoardRun {
  return {
    id: 7,
    stage: 'review',
    status: 'running',
    progress: null,
    error: null,
    verdict: null,
    findings: 0,
    ask: null,
    stale: false,
    gateClosed: false,
    ...overrides,
  }
}

function boardPr(overrides: Partial<BoardPr> = {}): BoardPr {
  return {
    id: 1,
    repoId: 1,
    repo: 'acme/app',
    number: 42,
    title: 'Add retries',
    url: 'https://github.com/acme/app/pull/42',
    author: 'octocat',
    authorAvatar: null,
    isDraft: false,
    state: 'OPEN',
    ciState: 'success',
    labels: [],
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    unresolvedThreads: 0,
    reviewRequested: true,
    requestedTeam: null,
    myReviewState: null,
    role: 'reviewer',
    tab: 'reviews',
    derivedStage: 'to-review',
    stage: 'to-review',
    manual: false,
    stageSince: 0,
    updatedAt: 0,
    closedAt: null,
    starred: false,
    hidden: false,
    archivedAt: null,
    reviewed: false,
    run: null,
    ...overrides,
  }
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 7,
    prId: 1,
    stage: 'review',
    skillName: 'code-review',
    agent: 'claude',
    model: 'claude-sonnet-5-5',
    status: 'running',
    progress: null,
    sessionId: 'session',
    worktreePath: '/worktrees/pr-42',
    reviewedHeadOid: 'head1',
    report: null,
    changes: null,
    replies: [],
    threadIds: [],
    bodyFindings: [],
    createdAt: 0,
    startedAt: 0,
    endedAt: null,
    dismissedAt: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    error: null,
    ask: null,
    ...overrides,
  }
}

const ask: Ask = {
  id: 3,
  runId: 7,
  prompt: 'Should I\n  rename the option?',
  options: ['Yes', 'No'],
  placeholder: null,
  answer: null,
  createdAt: 0,
  answeredAt: null,
}

describe('notification settings', () => {
  it('defaults to everything on and saves patches', () => {
    const ctx = makeCtx()
    expect(Object.values(getNotificationSettings(ctx)).every(Boolean)).toBe(true)
    expect(setNotificationSettings(ctx, { ciFailed: false })).toMatchObject({
      ciFailed: false,
      needsYou: true,
    })
    expect(getNotificationSettings(ctx).ciFailed).toBe(false)
  })

  it('fills fields missing from an older saved value', () => {
    const ctx = makeCtx()
    setSetting(ctx.db, 'notifications', { menuBar: false })
    expect(getNotificationSettings(ctx)).toMatchObject({ menuBar: false, dockBadge: true })
  })
})

describe('runNotice', () => {
  it('asks for an answer with the question and its options', () => {
    const notice = runNotice('running', makeRun({ status: 'needs_you', ask }), boardPr())
    expect(notice).toEqual({
      id: 'ask:3',
      kind: 'needsYou',
      title: 'Review needs your answer',
      subtitle: 'acme/app #42 · Add retries',
      body: 'Should I rename the option?',
      target: { prId: 1, page: 'reviews', tab: 'runs', runId: 7 },
      ask: { id: 3, options: ['Yes', 'No'] },
      dedupe: null,
    })
  })

  it('announces a finished review with its verdict, ready to post', () => {
    const pr = boardPr({ run: boardRun({ status: 'done', findings: 3 }) })
    const run = makeRun({
      status: 'done',
      report: { verdict: 'request_changes', summary: 'Two bugs', dimensions: [] },
    })
    expect(runNotice('running', run, pr)).toMatchObject({
      id: 'run:7',
      kind: 'runFinished',
      title: 'Review done',
      body: 'Request changes · 3 findings · Ready to post',
      target: { tab: 'post', runId: 7 },
    })
    expect(runNotice('running', run, { ...pr, reviewed: true })?.title).toBe('Full review done')
  })

  it('describes address, replies and test plan runs', () => {
    const pr = boardPr({ role: 'author', tab: 'mine' })
    const address = makeRun({
      stage: 'address',
      status: 'done',
      changes: { threads: [{ threadId: 't1', action: 'fix' }], filesTouched: [], checks: [] },
    })
    expect(runNotice('running', address, pr)).toMatchObject({
      title: 'Address comments done',
      body: '1 thread handled · Ready to commit and push',
      target: { page: 'mine', tab: 'post' },
    })
    const replies = makeRun({
      stage: 'draft-replies',
      status: 'done',
      replies: [
        { threadId: 't1', body: 'Done' },
        { threadId: 't2', body: 'Fixed' },
      ],
    })
    expect(runNotice('running', replies, pr)?.body).toBe('2 draft replies · Ready to post')
    const plan = makeRun({
      stage: 'test-plan',
      status: 'done',
      report: { verdict: 'comment', summary: 'Check the\nlogin flow', dimensions: [] },
    })
    expect(runNotice('running', plan, pr)).toMatchObject({
      body: 'Check the login flow',
      target: { tab: 'runs' },
    })
  })

  it('reports failures with the error', () => {
    const run = makeRun({ status: 'failed', error: 'The worktree is dirty' })
    expect(runNotice('preparing', run, boardPr())).toMatchObject({
      title: 'Review failed',
      body: 'The worktree is dirty',
      target: { tab: 'runs' },
    })
  })

  it('stays quiet without a transition, on cancel and for muted pull requests', () => {
    const done = makeRun({ status: 'done' })
    expect(runNotice(undefined, done, boardPr())).toBeNull()
    expect(runNotice('done', done, boardPr())).toBeNull()
    expect(runNotice('needs_you', makeRun({ status: 'running' }), boardPr())).toBeNull()
    expect(runNotice('running', makeRun({ status: 'cancelled' }), boardPr())).toBeNull()
    expect(runNotice('running', done, boardPr({ hidden: true }))).toBeNull()
    expect(runNotice('running', done, boardPr({ archivedAt: 1 }))).toBeNull()
  })
})

describe('prNotice', () => {
  const event = { kind: 'reviewRequested' as const, prId: 1, headOid: 'abcdef123456' }

  it('announces review requests', () => {
    expect(prNotice(event, boardPr())).toEqual({
      id: 'review:1',
      kind: 'reviewRequested',
      title: 'Review requested',
      subtitle: 'acme/app #42 · Add retries',
      body: 'From @octocat',
      target: { prId: 1, page: 'reviews', tab: 'overview', runId: null },
      ask: null,
      dedupe: 'review:1',
    })
    expect(
      prNotice(event, boardPr({ requestedTeam: 'core', myReviewState: 'COMMENTED' })),
    ).toMatchObject({
      title: 'Re-review requested',
      body: 'From @octocat, for the core team',
    })
  })

  it('announces failing checks once per head', () => {
    const pr = boardPr({ role: 'author', tab: 'mine' })
    expect(prNotice({ ...event, kind: 'ciFailed' }, pr)).toMatchObject({
      kind: 'ciFailed',
      title: 'Checks failed',
      body: 'A check failed on abcdef1',
      dedupe: 'ci:1:abcdef123456',
      target: { page: 'mine', tab: 'overview' },
    })
  })

  it('stays quiet for hidden, archived and closed pull requests', () => {
    expect(prNotice(event, boardPr({ hidden: true }))).toBeNull()
    expect(prNotice(event, boardPr({ archivedAt: 1 }))).toBeNull()
    expect(prNotice(event, boardPr({ state: 'MERGED' }))).toBeNull()
  })
})

describe('menu bar items', () => {
  const question = boardPr({
    id: 1,
    number: 1,
    title: 'Question',
    stage: 'needs-you',
    run: boardRun({ id: 10, status: 'needs_you', ask }),
  })
  const ready = boardPr({
    id: 2,
    number: 2,
    title: 'Ready',
    stage: 'reviewing',
    reviewed: true,
    run: boardRun({ id: 11, status: 'done' }),
  })
  const posted = boardPr({
    id: 3,
    stage: 'changes-requested',
    run: boardRun({ id: 12, status: 'done', gateClosed: true }),
  })
  const hidden = boardPr({ id: 4, hidden: true, run: boardRun({ id: 13, status: 'needs_you' }) })
  const running = boardPr({
    id: 5,
    number: 5,
    role: 'author',
    tab: 'mine',
    run: boardRun({ id: 14, stage: 'address', status: 'running', progress: 'Running tests' }),
  })
  const queued = boardPr({ id: 6, number: 6, run: boardRun({ id: 15, status: 'queued' }) })

  it('lists agent questions first, then runs ready to post', () => {
    expect(needsYouItems([ready, posted, hidden, running, question])).toEqual([
      {
        label: 'app #1 · Question',
        detail: ask.prompt,
        target: { prId: 1, page: 'reviews', tab: 'runs', runId: 10 },
      },
      {
        label: 'app #2 · Ready',
        detail: 'Full review ready to post',
        target: { prId: 2, page: 'reviews', tab: 'post', runId: 11 },
      },
    ])
  })

  it('lists the other cards that need you, by column', () => {
    const toApprove = boardPr({ id: 7, number: 7, title: 'Approve me', stage: 'to-approve' })
    const toReview = boardPr({ id: 8, number: 8, title: 'Review me', updatedAt: 5 })
    const older = boardPr({ id: 9, number: 9, title: 'Older', updatedAt: 1 })
    const mine = boardPr({
      id: 10,
      number: 10,
      title: 'Mine',
      role: 'author',
      tab: 'mine',
      stage: 'changes-requested',
    })
    const waiting = boardPr({ id: 11, role: 'author', tab: 'mine', stage: 'waiting-review' })
    const closed = boardPr({ id: 12, state: 'MERGED' })
    const hiddenReview = boardPr({ id: 13, hidden: true })
    expect(
      yourTurnItems([
        question,
        ready,
        toApprove,
        older,
        toReview,
        mine,
        waiting,
        closed,
        hiddenReview,
      ]),
    ).toEqual([
      {
        label: 'app #8 · Review me',
        detail: 'To review',
        target: { prId: 8, page: 'reviews', tab: 'overview', runId: null },
      },
      {
        label: 'app #9 · Older',
        detail: 'To review',
        target: { prId: 9, page: 'reviews', tab: 'overview', runId: null },
      },
      {
        label: 'app #7 · Approve me',
        detail: 'To approve',
        target: { prId: 7, page: 'reviews', tab: 'overview', runId: null },
      },
      {
        label: 'app #10 · Mine',
        detail: 'Changes requested',
        target: { prId: 10, page: 'mine', tab: 'overview', runId: null },
      },
    ])
  })

  it('lists running agents with their progress', () => {
    expect(runningItems([question, ready, running, queued])).toEqual([
      {
        label: 'Review · app #6',
        detail: 'Queued',
        target: { prId: 6, page: 'reviews', tab: 'runs', runId: 15 },
      },
      {
        label: 'Address comments · app #5',
        detail: 'Running tests',
        target: { prId: 5, page: 'mine', tab: 'runs', runId: 14 },
      },
    ])
  })
})

describe('clip', () => {
  it('folds whitespace and cuts long text', () => {
    expect(clip('  one\n two  ', 20)).toBe('one two')
    expect(clip('abcdefghij', 6)).toBe('abcde…')
  })
})
