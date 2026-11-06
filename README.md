# PRism

PRism is a macOS app for reviewing GitHub pull requests with AI agents. Watch your repositories, get a kanban board of the pull requests that involve you, run review and address-comments skills in parallel, and follow each run live. Nothing touches git history or GitHub until you say so.

> Screenshots coming soon.

Status: early development. See [Status](AGENTS.md#status) for what works today and [PLAN.md](PLAN.md) for the full plan.

## Features

- **Board:** a Reviews tab (pull requests you review) and a My PRs tab (authored or taken over), with stages derived from GitHub and kept in sync every 60 seconds and on focus.
- **Card actions:** star, hide, archive, drag to override a stage. A manual stage holds until GitHub's state changes.
- **Skills:** pick a skill source per repository (a public or private git repo, or a local folder), import or link skills, and bind one to each stage (review, re-review, test plan, address comments, draft replies).
- **Agent runs:** drag a card into Reviewing (or Addressing), or pick a stage in the drawer (review, re-review, test plan, address comments, draft replies), to run the bound skill with Claude in a dedicated git worktree per pull request. Address and draft-replies runs work on the review threads you pick. Runs go in parallel, stream a live transcript, report a verdict, findings, changes or draft replies, and pause in a Needs you column with an inline answer form when the agent has a question. Sessions resume after an answer or an app restart, take follow-up messages, and open in your terminal (`claude --resume`) or editor.
- **Guardrails:** agents work in their pull request's worktree. A command guard, a read-only `gh` shim, a push block and a prompt contract keep them from committing, pushing or posting, and project settings come from your own clone, never from the pull request. These layers stop accidents and naive prompt injection; they are not a sandbox.

## Requirements

- macOS (Apple silicon or Intel)
- [GitHub CLI](https://cli.github.com) logged in (`gh auth login`, scopes `repo` and `read:org`)
- An agent CLI logged in. [Claude Code](https://claude.com/claude-code) is supported today, other agents are planned.
- For development: Node 26 and pnpm 10

## Install

```sh
pnpm install
pnpm dev            # run in development
pnpm install:app    # build an ad-hoc signed app into /Applications
```

## Scripts

| Script                              | What it does                                                   |
| ----------------------------------- | -------------------------------------------------------------- |
| `pnpm dev`                          | Start the app with hot reload                                  |
| `pnpm build`                        | Build main, preload and renderer into `out/`                   |
| `pnpm typecheck`                    | Type-check main and renderer                                   |
| `pnpm lint`                         | oxlint, warnings fail                                          |
| `pnpm format` / `pnpm format:check` | Prettier                                                       |
| `pnpm test`                         | Vitest                                                         |
| `pnpm check:denylist`               | Scan the repo for secrets and private terms                    |
| `pnpm db:generate`                  | Generate a Drizzle migration after a schema change             |
| `pnpm install:app`                  | Build and install a local, ad-hoc signed app                   |
| `pnpm dist:mac`                     | Signed and notarized release build (needs a Developer ID cert) |

## Project layout

```
src/
  main/         Electron main process: services, IPC handlers, SQLite
  preload/      contextBridge with a channel allowlist
  renderer/     React app: board, drawer, onboarding, settings
  shared/       Domain types and the zod-validated IPC contract
  main/agents/  Agent adapters, PRism MCP tools, guardrails
drizzle/        SQL migrations
resources/      Built-in starter skills
scripts/        Denylist check, local install
```

## Documentation

- [PLAN.md](PLAN.md): product plan, architecture, data model, phases
- [AGENTS.md](AGENTS.md): architecture map, conventions, commands and gotchas for contributors and coding agents

## License

[MIT](LICENSE)
