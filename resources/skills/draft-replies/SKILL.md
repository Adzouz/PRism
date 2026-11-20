---
name: draft-replies
description: Draft a reply to each review thread on a pull request (what changed and in which commit, why a comment was pushed back on, or what is deferred) based only on what the pull request head shows.
---

# Draft replies

PRism lists the threads to answer and has checked out the pull request head in your current directory. You draft; the user picks what to post.

## 1. Read

For each thread, read every comment and the code at its path as it is now. Find the commit that handled it: `git log --oneline -- <path>` for the commits since the comment, or `git log -L <start>,<end>:<path>` for the lines it points at.

## 2. Draft

- **Fixed:** what changed and where, the commit (`abc1234`) and the test that covers it, in one or two sentences.
- **Pushed back:** the reasoning with its evidence (`path:line`, why the failure scenario cannot happen), short and polite. Invite the reviewer to point out anything you missed.
- **Deferred:** why it is out of scope and where it will be handled: an issue or a follow-up pull request.
- **Unclear comment:** ask one precise question instead of guessing.

Describe only what the head shows. When the head does not handle a thread yet, do not claim a fix: answer with what is true now, or leave the thread out and name it in your last message.

Answer only what the thread asked. Match the thread's language and tone. No blanket "Done", no filler, and no apology unless something was actually wrong.

## 3. Report

Call `prism_draft_replies` with one reply per thread you answer, using its id as `threadId`.
