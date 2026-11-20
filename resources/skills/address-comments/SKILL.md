---
name: address-comments
description: Address review comments on a pull request. Give each thread a verdict (fix, push back or defer), make the smallest correct fix with a test, run the project's checks, and draft a reply per thread, leaving the changes uncommitted.
---

# Address review comments

PRism lists the review threads to handle, and the review findings that have no thread, and has checked out the pull request in your current directory. You change files here; PRism commits, pushes and posts your replies once the user confirms.

## 1. Understand

- Read the project's rules first: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, the CI configuration. They say how tests are written, which checks must pass and what has to change along with the code (docs, changelog, generated files).
- For each thread, read every comment, the code it points at as it is now, and the callers that code affects. For an outdated or resolved thread, check whether the point still applies.

## 2. Decide per thread

- `fix`: the comment is right and in scope.
- `push_back`: the comment is wrong, or following it would break something. Back it up with evidence: `path:line` and why the failure scenario cannot happen. Reviewers, AI ones included, can be wrong.
- `defer`: the point is real but out of scope. Propose a follow-up instead of growing the pull request.

When the call belongs to the user (a product choice, two reviewers asking for opposite things), ask with `prism_ask_user`.

## 3. Fix

- Make the smallest change that removes the failure scenario, in the existing style. No drive-by refactors or reformatting of untouched code.
- Give each fixed bug a test that fails without the fix, written the way the project writes its tests.
- Update what the project expects to change with the code: docs, changelog, migrations, generated types or snapshots.

## 4. Check

Run the checks that cover what you touched: type check, lint, formatter, the related tests, as CI or the project's rules list them. If the worktree has no dependencies installed, install them with the project's usual command first. Fix what you broke, and report honestly what still fails and why. Leave the changes in the worktree: no commit, stash or reset.

## 5. Report

Call `prism_report_changes` with:

- one entry per thread and per finding key (`finding:<id>`): its action and a short note, what changed and where, or why not;
- the files you touched, every check you ran with its result, and a short summary.

Then call `prism_draft_replies` with one reply per thread (findings without a thread get none):

- `fix`: what changed and where, and the test that covers it. No commit hash: the commit does not exist yet.
- `push_back`: your reasoning with its evidence, short and polite. Invite the reviewer to point out anything you missed.
- `defer`: why it is out of scope and where it will be handled.

Answer only what the thread asked, in one to three sentences. No blanket "Done", no thanks-for-the-review filler.
