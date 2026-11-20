---
name: pr-re-review
description: Re-review a pull request after new commits. Check every earlier finding against the code, review only what changed since the last review, and give a new GO, GO WITH NITS or NO GO verdict.
---

# Re-review a pull request

An incremental pass. PRism gives you the earlier findings (`#<id> [severity] path:line title (status)`) and the scope: the commits since the last review, or a note that nothing new needs a review. You read and report; you never change files, post, commit or push.

## 1. Earlier findings

For each earlier finding, read the code at the pull request head and every reply in its thread (`gh api repos/<owner>/<repo>/pulls/<n>/comments --paginate`), then pick its status:

- `resolved`: the code now handles the failure scenario, ideally with a test. Check the code; a resolved thread proves nothing.
- `still_open`: not fixed, or only partly. Say what is missing in the summary.
- `disputed`: the author pushed back and the evidence does not convince you. Give your view in the summary; the user decides. When the reply does convince you, use `obsolete`.
- `obsolete`: the code is gone, or the finding no longer applies.

Report them with `prism_report_prior_status`, one item per finding id.

## 2. Review the scope

- Review only the commits in scope (`git show <sha>`), reading the surrounding code as needed. Fixes often bring new edge cases: check each one for correctness, regressions, tests, security, data and contracts, performance, maintainability and docs, as a full review would.
- After a force-push, PRism leaves out the commits that only moved and lists the reviewed commits that were removed: check that their removal breaks nothing.
- When nothing new needs a review (a rebase, a merge of the base branch), update the earlier findings and check the conflict resolutions of base merges with `git show --remerge-diff <merge>`.
- Never report an earlier finding again; PRism drops repeats. A different problem on the same code gets its own title.
- When the new commits rewrite most of the pull request or change its scope, say so in the summary and recommend a Full review.
- Follow the project's own rules (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, CI configuration). Run the checks CI runs on the changed files only when the worktree already has its dependencies installed; installing them would run the pull request's code on the user's machine.

## 3. Write new findings

Prove each finding against the code before you report it, and merge findings that share a root cause.

- `path` and `line`: a line of the diff, numbered in the new file (`side: RIGHT`), or in the old file for a removed line (`side: LEFT`). Use `line: null` for a problem outside the diff.
- `severity`: `blocking` for a correctness bug, a regression, a security issue, a fix without a regression test, a failing check or a missing migration; `nit` for a real but minor issue; `refactor` for a simplification that is never required.
- `title`: a few words that name the problem. `body`: the problem, a concrete failure scenario and the fix. `suggestion`: the replacement code when the fix is small, without code fences.
- For every `nit` and `refactor`, set `nitDecision` and start the body with the call: `address` (`**Address before merge.**`) for a real edge case, a visible glitch, a contract or docs gap or a cheap fix that is clearly better; `followup` (`**Follow-up is fine.**`) when it is out of scope or bigger than the change; `skip` (`**Skip.**`) for taste or cosmetics.

## 4. Verdict and report

Count the earlier findings that are still open together with the new ones:

- `request_changes` (NO GO): a new blocking finding, or an earlier blocking finding still open.
- `comment` (GO WITH NITS): nothing blocking, at least one new or still-open finding to address before merge.
- `approve` (GO): nothing left to change before merge.

Write the summary in two or three sentences: what changed since the last review, what is resolved and what is left. When nits or refactors are open, end it with `Nits: address <n> before merge (<short list>).` or `Nits: fine to merge as is (<why>).`, counting the earlier ones still open.

Report the verdict, the summary, the dimensions you checked and the new findings only in one `prism_report_findings` call.
