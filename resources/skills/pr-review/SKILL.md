---
name: pr-review
description: Review a pull request in one pass (correctness, regressions, tests, security, data and contracts, performance, docs) and report verified findings, each with a failure scenario, plus a GO, GO WITH NITS or NO GO verdict.
---

# Review a pull request

One pass: gather, read, check, report. The pull request is checked out in your current directory. You read and report; you never change files, post, commit or push.

## 1. Gather

- The description, the conversation and the linked issues (`gh pr view <n> --comments`). Note what the change claims to do and its type: fix, feature, refactor or chore.
- Every review thread (`gh api repos/<owner>/<repo>/pulls/<n>/comments --paginate`). Do not repeat a point someone already raised, and never report again a finding PRism lists as open.
- The full diff against the base, with the command the task gives.
- The project's own rules: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, the README and the CI configuration (`.github/workflows/` and the like). They say which checks must pass, how tests are written and what the maintainers care about. Hold the change to them.

## 2. Read the code

For anything beyond a trivial change, read the whole files the diff touches, then the callers, types and tests it depends on. A diff alone hides what it breaks.

## 3. Run checks when it is cheap

When the worktree already has its dependencies installed, run the checks CI runs that cover the changed files: type check, lint, the related tests. Do not install dependencies for a review: install scripts and tests run the pull request's code on the user's machine. Note what you ran and what you skipped in the dimension scan. A failing check is blocking.

## 4. Analyze every dimension

1. **Correctness and intent:** does the change do what it claims? Edge cases, null and empty values, error paths, races, off-by-one errors, wrong precedence. Say so plainly when the approach is wrong or over-built.
2. **Regressions:** what existing behaviour changes? Trace the callers. Check renamed or removed exports, changed defaults, changed payload shapes, and data written by older versions.
3. **Tests:** a fix needs a test that fails without it. A feature needs its happy path, an edge case and an error case. Tests check behaviour, not mocks.
4. **Security:** untrusted input reaching shell commands, queries, file paths, HTML or redirects; missing authentication or authorization checks; secrets in code, logs or fixtures; unsafe defaults.
5. **Data and contracts:** a schema change ships with a migration that works on existing data. Public APIs, events, command-line flags and configuration stay compatible, or the break is intended and documented.
6. **Performance:** work in hot paths or loops, N+1 queries, unbounded lists, missing pagination, needless network calls.
7. **Maintainability:** unclear names, duplication, dead code. Suggest a refactor only when it clearly simplifies.
8. **Docs:** the README, changelog or docs updated when behaviour, commands or configuration change, as far as the project's rules ask.

Skip a dimension the change does not touch, and say so.

## 5. Write findings

Before you report a finding, prove it against the code: open the file, follow the call, make sure the failure really happens. Drop what you cannot back up. Merge findings that share a root cause. Signal over volume.

For each finding:

- `path` and `line`: a line of the diff, numbered in the new file (`side: RIGHT`), or in the old file for a removed line (`side: LEFT`). When the problem lives outside the diff, point at the changed line that causes it, or use `line: null` to put the finding in the review body.
- `severity`:
  - `blocking`: a correctness bug, a regression, a security issue, a fix without a regression test, a failing check, a missing migration, secrets or private data in the diff.
  - `nit`: a real but minor issue: an edge case with little impact, an unclear name, a docs gap.
  - `refactor`: a simplification worth doing, never required.
- `title`: a few words that name the problem.
- `body`: the problem, a concrete failure scenario (this input or state gives this wrong result) and the fix. Write it for the author, in plain words.
- `suggestion`: the replacement code when the fix is small, without code fences.

For every `nit` and `refactor`, decide whether it should be handled before merge. Set `nitDecision` and start the body with the matching call:

- `address`, body starts with `**Address before merge.**`: a real edge case, a visible glitch, a contract or docs gap, or a cheap fix that is clearly better.
- `followup`, body starts with `**Follow-up is fine.**`: worth doing, but outside the pull request's scope or bigger than the change itself.
- `skip`, body starts with `**Skip.**`: taste or cosmetics; the code is fine as it is.

## 6. Verdict and report

- `request_changes` (NO GO): at least one `blocking` finding.
- `comment` (GO WITH NITS): nothing blocking, at least one finding to address before merge.
- `approve` (GO): nothing to change before merge. Findings marked follow-up or skip go along as comments.

Write the summary in two or three sentences: what the pull request does, whether it delivers, and the main risk. When there are nits or refactors, end it with `Nits: address <n> before merge (<short list>).` or `Nits: fine to merge as is (<why>).`

Report the verdict, the summary, every dimension (`clean`, `issues` or `skipped`, with a short note) and every finding in one `prism_report_findings` call.
