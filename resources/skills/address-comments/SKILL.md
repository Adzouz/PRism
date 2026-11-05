---
name: address-comments
description: Address review comments on your pull request by fixing the code and drafting replies.
---

# Address review comments

You get the review threads to handle. For each thread:

1. Read the comment, the code it points to and the rest of the thread.
2. Decide: `fix` (the comment is right), `push_back` (it is wrong or out of scope, explain why) or `defer` (valid, but for a follow-up).
3. For `fix`, change the code in the worktree with the smallest correct change. Keep the existing style.
4. Run the tests and linters that cover the files you touched.
5. Draft a short reply per thread: what you changed, or why you did not.

Report per thread the decision, the files touched and the test results.

Never commit, push, post or reply on GitHub. PRism does that after the user confirms.
