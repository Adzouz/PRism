---
name: pr-test-plan
description: Write a "How to test" plan for a pull request that has none.
---

# Write a test plan

1. Read the PR description, the linked issues and the diff.
2. Work out what a reviewer must set up (data, configuration, feature flags) and what they must do to see the change working.
3. Write short numbered steps, each with the expected result.
4. Add the edge cases worth checking by hand and the regressions to watch for.
5. Mention the automated tests that already cover the change, if any.

Keep it concrete and runnable by someone new to the codebase.

Never post, comment, commit or push. Return the plan as markdown.
