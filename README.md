<p align="center">
  <img src="build/icon.png" alt="PRism icon" width="128" height="128">
</p>

<h1 align="center">PRism</h1>

PRism is a macOS app for reviewing GitHub pull requests with AI agents. Watch your repositories, get a kanban board of the pull requests that involve you, run review and address-comments skills in parallel, and follow each run live. Nothing touches git history or GitHub until you say so.

> Screenshots coming soon.

Status: early development. See [Status](AGENTS.md#status) for what works today and [PLAN.md](PLAN.md) for the full plan.

## Features

- **Board:** a Reviews tab (pull requests you review) and a My PRs tab (authored or taken over), kept in sync every 60 seconds and on focus. Both follow one review loop: drop a card on Reviewing to review it, on Addressing to address the comments on your own pull request, on Approved to approve it; posting moves the card to Changes requested, To approve, or back to Waiting review after you address the comments on your own pull request, until it reaches To approve. A Next step button in the drawer starts the step that moves a card forward, or moves it to any column; on your own pull request waiting for GO with unresolved comments (a GO WITH NITS), Address sits next to Post GO. When a review of your own pull request is ready to submit with findings, Post and address next to Post submits it and starts Address on the nits right away. When your pull request conflicts with its base, its card gets a merge mark and Resolve conflicts becomes the next step.
- **Card actions:** star, hide, archive, drag to override a stage. A manual stage holds until GitHub's state changes.
- **Skills:** pick a skill source per repository (a public or private git repo, or a local folder), import or link skills, and bind one to each stage (review, re-review, test plan, address comments, draft replies). No skills yet? PRism ships a built-in starter for every stage, proposed for any stage your source does not cover and updated with the app.
- **Agent runs:** drag a card into Reviewing (or Addressing), or pick a stage in the drawer (review, re-review, test plan, address comments, draft replies), to run the bound skill with Claude in a dedicated git worktree per pull request (removed once the pull request is merged or closed, unless it holds work that is not on GitHub). Address and draft-replies runs work on the review threads you pick. Resolve conflicts (your own pull request, while GitHub says it conflicts) merges the base branch into the worktree, lets the agent resolve the conflicted files and run the checks, and needs no skill. Runs go in parallel, stream a live transcript, report a verdict, findings, changes or draft replies, and pause in a Needs you column with an inline answer form when the agent has a question. A pull request that conflicts with its base never gets a GO. Re-reviews cover only what changed since the last review (PRism works it out, including after a force-push) and never repeat an open finding; a Full review reads everything again. Sessions resume after an answer or an app restart, take follow-up messages, and open in your terminal (`claude --resume`) or editor.
- **Auto-run:** off by default; turn it on per repository in Settings. When someone requests your review by name, PRism starts a review on its own, or a re-review if you reviewed before, two at a time at most. New commits and team requests never start one.
- **Mirador (optional):** if you track your work in [Mirador](https://github.com/Adzouz/Mirador), a macOS work tracker, a per-repository switch makes PRism tell it when a review or address run starts, and add the status you posted as a note when you post a review (marked `draft:` for a pending draft). Without Mirador installed, the switch doesn't show and nothing changes.
- **Post gate:** an Actions tab lists every finished review, address or draft-replies run as a timeline, newest first, and the open one comes with a live checklist. Ask agent anything on a step takes you to its run with the message box ready. Include, exclude or edit findings, pick the review status (pre-filled from the verdict; always Comment on your own pull request, the only status GitHub allows there) and submit now or stage a pending draft (pending draft by default, overridable per repository in Settings). Address runs commit and push from the gate, and PRism checks the new head on GitHub before posting the replies you tick. Resolve conflicts runs commit the merge (refused while a conflict or a conflict marker is left) and push it, which closes the step. A merge left by a failed or stopped Resolve conflicts run blocks Address comments and its commit and push until Resolve conflicts finishes it or you run `git merge --abort`. Everything PRism posts ends with an AI tag line, and nothing is posted until you click.
- **Dashboard:** open pull requests, open issues, pull requests awaiting your review and your own open ones, each with the change since yesterday; pull requests opened, merged and closed per day (from GitHub search, so it fills from day one); the open pull requests at the end of each day over 30 days, from GitHub search too; the pull requests merged over 7 days (against the 7 days before) and 30 days; your median review latency over 7 and 30 days; agent cost per day over 30 days, cost, runs and tokens over 7 and 30 days, and cost per stage (as reported by the agent, at API prices); agents waiting for an answer and the ones running. Filter by repository.
- **Notifications and menu bar:** native notifications when an agent asks a question (answer it right from the notification), a run finishes or fails, someone requests your review, or checks fail on your pull request. A Dock badge and a menu bar item count the agent questions and runs ready to post; the menu lists them, then the pull requests where it's your turn (to review, re-review, approve or address) and the agents running. Onboarding asks macOS for permission, Settings links to System Settings when banners don't show, and each kind can be turned off; hidden pull requests stay quiet.
- **Guardrails:** agents work in their pull request's worktree. A command guard, a read-only `gh` shim, a push block and a prompt contract keep them from committing, pushing or posting, and project settings come from your own clone, never from the pull request. These layers stop accidents and naive prompt injection; they are not a sandbox.

## Requirements

- macOS (Apple silicon or Intel)
- [GitHub CLI](https://cli.github.com) logged in (`gh auth login`, scopes `repo` and `read:org`)
- An agent CLI logged in. [Claude Code](https://claude.com/claude-code) is supported today, other agents are planned.
- For development: Node 24 or later and pnpm 10

## Install

```sh
pnpm install
pnpm dev            # run in development
pnpm install:app    # build an ad-hoc signed app into /Applications
```

## Scripts

| Script                              | What it does                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm dev`                          | Start the app with hot reload                                                         |
| `pnpm build`                        | Build main, preload and renderer into `out/`                                          |
| `pnpm preview`                      | Run the built app from `out/`                                                         |
| `pnpm typecheck`                    | Type-check main and renderer                                                          |
| `pnpm lint`                         | oxlint, warnings fail                                                                 |
| `pnpm format` / `pnpm format:check` | Prettier                                                                              |
| `pnpm test`                         | Vitest                                                                                |
| `pnpm check:denylist`               | Scan the repo for secrets and private terms                                           |
| `pnpm db:generate`                  | Generate a Drizzle migration after a schema change                                    |
| `pnpm install:app`                  | Build and install a local, ad-hoc signed app                                          |
| `pnpm dist:mac:dev`                 | Ad-hoc signed arm64 app in `dist/`, not notarized                                     |
| `pnpm dist:mac`                     | Release DMG and zip, Developer ID signed and notarized ([Gotchas](AGENTS.md#gotchas)) |

## Project layout

```
src/
  main/         Electron main process: services, IPC handlers, SQLite
  preload/      contextBridge with a channel allowlist
  renderer/     React app: dashboard, board, drawer, onboarding, settings
  shared/       Domain types and the zod-validated IPC contract
  main/agents/  Agent adapters, PRism MCP tools, guardrails
build/          App icon and macOS entitlements
drizzle/        SQL migrations
resources/      Built-in starter skills, menu bar icon
scripts/        Denylist check, dev app name, local install
```

## Documentation

- [PLAN.md](PLAN.md): product plan, architecture, data model, phases
- [AGENTS.md](AGENTS.md): architecture map, conventions, commands and gotchas for contributors and coding agents

## License

[MIT](LICENSE)
