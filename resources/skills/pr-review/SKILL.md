---
name: pr-review
description: Review a pull request end to end and report findings with a verdict.
---

# Review a pull request

You are reviewing the pull request checked out in the current worktree.

1. Read the PR title, description and linked issues. Note what the change claims to do.
2. Read existing review threads first. Do not repeat a point already raised.
3. Read the full diff against the PR base, then the surrounding code the diff depends on.
4. Look for, in this order:
   - correctness bugs, regressions and missing edge cases,
   - breaking changes to public APIs, data or configuration,
   - security issues (injection, secrets, unsafe input handling),
   - missing or weak tests for the changed behaviour,
   - clarity and maintainability problems worth fixing now.
5. Run the relevant tests or type checks when it is cheap to do so.

Report every finding with its file, line and side, a severity (`blocking`, `nit`, `refactor`), a short title, a body that explains the problem and why it matters, and a code suggestion when the fix is small.

End with a verdict: approve, comment or request changes, and a two or three sentence summary.

Never post, comment, commit or push. Report through the tools you are given.
