---
name: pr-re-review
description: Re-review a pull request incrementally since the last reviewed commit.
---

# Re-review a pull request

You get the earlier findings (the ledger) and the commits pushed since the last review.

1. For each earlier finding, read the current code and the thread replies. Mark it `resolved`, `still_open`, `disputed` (the author pushed back) or `obsolete` (the code is gone).
2. Review only the new changes since the last reviewed commit. Ignore commits that only moved because of a rebase.
3. Do not raise anything already in the ledger.
4. Report new findings the same way as a full review, then a verdict and a short summary.

If the new changes rewrite most of the PR, say so and recommend a full review.

Never post, comment, commit or push. Report through the tools you are given.
