# AGENTS.md

Guide for coding agents and contributors working on PRism. Product context lives in [PLAN.md](PLAN.md). User-facing setup lives in [README.md](README.md).

## Architecture

Electron app, three processes plus shared code:

| Path                          | Role                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/index.ts`           | App bootstrap: opens the DB, builds `Ctx`, registers IPC, starts sync, creates the agent runner and resumes interrupted runs                                                                                                                                             |
| `src/main/services/`          | Business logic, one file per area (see below)                                                                                                                                                                                                                            |
| `src/main/ipc/`               | `register.ts` (zod-validated `ipcMain.handle`), `handlers.ts` (onboarding/config), `board-handlers.ts` (board + sync), `run-handlers.ts` (agent runs), `gate-handlers.ts` (post gate, findings, post mode), `emit.ts` (push events to all windows)                       |
| `src/main/db/`                | `schema.ts` (Drizzle), `client.ts` (opens SQLite, WAL, runs migrations), `settings.ts` (typed key/value)                                                                                                                                                                 |
| `src/main/agents/`            | Agent layer: `types.ts` (`AgentAdapter`, `PrismTools`), `claude.ts` (Agent SDK adapter + PrismMCP tools), `guard.ts` (command guard, `gh` shim, pre-push hook), `prompt.ts` (PRism contract + task prompt), `redact.ts`                                                  |
| `src/main/skills/`            | Skill scanning, `prism-source.json` manifest parsing, stage matching                                                                                                                                                                                                     |
| `src/main/system/`            | `exec.ts`: `run` / `runStreaming` with the user's login-shell `PATH`; `shell.ts`: probes the user's shell aliases and functions for the guard                                                                                                                            |
| `src/preload/index.ts`        | `window.prism` bridge: `invoke(channel, input)` and `on(event, listener)`, both allowlisted                                                                                                                                                                              |
| `src/shared/channels.ts`      | Allowlists: `ipcChannels`, `ipcEvents`                                                                                                                                                                                                                                   |
| `src/shared/ipc.ts`           | `ipcContract` (zod input/output per channel) and `IpcEventPayloads`                                                                                                                                                                                                      |
| `src/shared/domain.ts`        | Domain schemas and types shared by main and renderer                                                                                                                                                                                                                     |
| `src/renderer/src/features/`  | `board/` (board, card, drawer, toolbar, archive, zustand store in `model.ts`: open PR, drawer tab, open run, per-column drop confirmations), `runs/` (drawer Runs tab, transcript, answer form, Runs page list), `post/` (drawer Post tab: the post gate), `onboarding/` |
| `src/renderer/src/lib/api.ts` | `invoke`, TanStack Query hooks, query keys, event subscriptions                                                                                                                                                                                                          |
| `drizzle/`                    | Generated migrations, applied on startup                                                                                                                                                                                                                                 |
| `resources/skills/`           | Built-in starter skills, bundled via `extraResources`                                                                                                                                                                                                                    |

### Main services

| Service                     | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                 | Onboarding status, agent config, full reset                                                                                                                                                                                                                                                                                                                                                                                      |
| `github.ts` / `gh-api.ts`   | `gh` CLI helpers; GraphQL/REST client using `gh auth token` (`graphql`, `graphqlPartial`, REST `get`, `probe` with ETag, `rate`)                                                                                                                                                                                                                                                                                                 |
| `repos.ts` / `git.ts`       | Watched repositories, clone detection, worktree root                                                                                                                                                                                                                                                                                                                                                                             |
| `sources.ts` / `library.ts` | Skill sources (locate, install, bootstrap, sync) and the skill library + stage bindings                                                                                                                                                                                                                                                                                                                                          |
| `agents.ts`                 | Agent CLI detection and login checks                                                                                                                                                                                                                                                                                                                                                                                             |
| `sync.ts`                   | Per-repo board query, stale refresh, takeover detection, CI, daily snapshots, auto-archive, sync scheduler                                                                                                                                                                                                                                                                                                                       |
| `pr-stage.ts`               | Pure stage derivation (`deriveStage`) and manual-override basis (`stageBasis`)                                                                                                                                                                                                                                                                                                                                                   |
| `prs.ts` / `checks.ts`      | Board list (with the run overlay), PR detail, flags, manual stages, board settings; CI checks with ignored patterns                                                                                                                                                                                                                                                                                                              |
| `runs.ts`                   | Runs, run events (redacted), findings, asks; `latestBoardRuns` + `boardRunFor` pick the run and agent column shown on a card                                                                                                                                                                                                                                                                                                     |
| `runner.ts`                 | `AgentRunner`: start, cancel, answer, follow up, dismiss, resume after restart, open the worktree, resume in a terminal; one worktree per run, unlimited parallel runs                                                                                                                                                                                                                                                           |
| `actions.ts` / `diff.ts`    | `ActionService` (`createActions`): the post gate per finished review, address or draft-replies run (live checklist), findings editing, commit, push through the pre-push nonce + verify the head on GitHub, post the review (submit or pending draft) and thread replies, skip; `diff.ts` reads commentable lines from a patch                                                                                                   |
| `apps.ts`                   | Detects installed editors and terminals, remembers the preferred ones (`apps` setting), opens a worktree, runs `claude --resume` in Terminal or iTerm                                                                                                                                                                                                                                                                            |
| `worktrees.ts`              | `prepareWorktree`: `<worktree root>/pr-<n>`, reuses existing worktrees of the branch, adds a `prism-<owner>` remote for forks, checks the head against the PR head (falls back to `pull/<n>/head`), follows force-pushes on clean worktrees still at the PR head it last checked out (`refs/prism/pr-<n>-checkout`, moved only when the worktree ends at the PR head), installs the pre-push guard on its own `pr-<n>` worktrees |

### Data model

SQLite at `~/Library/Application Support/PRism/prism.db`. Tables: `settings`, `skill_sources`, `repos`, `skills`, `stage_bindings`, `prs`, `pr_flags`, `snapshots`, `runs`, `run_events`, `findings`, `asks`, `post_gates`.

### Agent runs

- Lifecycle: `queued → preparing → running ⇄ needs_you → done | failed | cancelled`. The Agent SDK `session_id` is stored per run; answers and app restarts resume the same session.
- `prism_ask_user` records an ask and sets the run to `needs_you`; the agent ends its turn, and the answer is sent as the next prompt with `resume`. One question can be open at a time, and Stop closes it.
- A run that ends without its report tool gets one nudge, then fails. While a stopped run winds down, follow-ups and new runs on its pull request are refused.
- A run loads its skill by id, so rebinding a stage does not change runs already started; a run whose skill was deleted fails.
- Board: one review loop on both tabs (PLAN.md §6). Action columns (Reviewing, Addressing on My PRs, Approved) start something on drop; state columns (To review, Changes requested, To re-review, To approve, Done) are derived. A card's stage is the run overlay, else a manual move, else the loop stage (`loopStage`: the last closed review or address gate, an approval from PRism at the current head), else the GitHub stage (`deriveStage`). Run overlay: an active or finished-but-unposted review run shows in Reviewing (until posted, skipped, my next GitHub review, a manual move or Dismiss), address runs in Addressing, and any `needs_you` run in the Needs you column (shown only when non-empty). A finished verdict stays visible while another stage (test plan, draft replies) runs, and is flagged `stale` when the PR head moved since. Dismiss hides that run and earlier failed or cancelled runs; dismissing a run that finished without error also hides earlier finished runs of the same kind (review and re-review, address, test plan, draft replies).
- Sync keeps a pull request that has any undismissed run (active or finished), even when it no longer involves the user. Removing a repository or resetting stops its runs first.
- Any stage can be started from the drawer (stage picker) or the card menu; a drop on an action column starts its stage (`columnStage`: Reviewing runs re-review once I reviewed on GitHub or a review run finished, else review; Addressing runs address), and `runStageFor` picks the drawer's default. `runStagesByTab` lists the stages offered per tab.
- Re-review runs get the pull request's open findings from earlier review and re-review runs, and the head of the last finished review.
- Address and draft-replies runs take review threads: the picker passes `threadIds`, otherwise the runner selects every unresolved thread at start. The ids are stored on the run (`threads_json`) and listed in the prompt; agents use them as `threadId` in `prism_report_changes` / `prism_draft_replies`. Threads are paged, with the last 30 comments of each.
- A finished run with a session can be continued with a follow-up message (`runs:followUp`, same session, un-dismisses the run) or resumed by the user in a terminal (`claude --resume`, outside PRism's tool guard and push block; the pre-push hook still applies in PRism worktrees).
- Cost and tokens are session totals from the SDK (`total_cost_usd`, `modelUsage`), which continue across `resume`; a run stores the latest total of its session.
- IPC: `runs:*`, `prs:threads`, `apps:*` channels; events `runs:changed` (a `Run`) and `runs:event` (a transcript `RunEvent`).

### Post gate (`actions.ts`)

- A finished review or re-review run gets a review gate, an address run an address gate, a draft-replies run a replies gate (`gateKindOf`). The gate row (`post_gates`) is created on first read and stores only the user's choices; `gates:get` recomputes the checklist live (GitHub head, pending review, own PR, worktree status, diff).
- Post mode: `settings:getPostMode` (global, default `draft` = Stage as pending draft), overridden per repository (`repos.post_mode`, `repos:setPostMode`) and per gate.
- Review: findings are included/excluded and edited (`findings:update`, refused once posted), then confirmed in one click. Findings on a commentable diff line (from `compare/<reviewed base>...<reviewed head>`) become inline comments; the rest go in the review body under "Other findings". The review status is pre-filled from the verdict and clamped to Comment on your own pull request. If you already have a pending review, PRism adds threads to it (and submits or updates its body) instead of starting a second one. Posted comment ids are stored on findings (`gh_comment_id`).
- Address: threads need a verdict, Commit runs `git add -A` + `git commit -m` in the run's worktree, Push runs `git push --force-with-lease=refs/heads/<branch>:<last verified push, else head at checkout> <remote> HEAD:refs/heads/<branch>` with a one-time `PRISM_PUSH_NONCE` (written to `<userData>/hooks/.push-nonce`, removed after, one push at a time) and then polls GitHub until the PR head equals the local head. The push target is stored on the run at checkout (`push_remote`, `push_ref`).
- Replies: only ticked threads are answered; every posted reply and review body ends with `aiTag`. Replies already posted keep their URL, so a retry after a failure posts the rest.
- Commit, push and post are refused while any agent run is active on the pull request, and one action (commit, push, post, skip, approve) runs per pull request at a time. Posting or skipping closes the gate, stores its mode and status, clears a manual stage and moves the card per `reviewDirection` (the gate's `nextStage`, shown on the Post button). Approve (`gates:approve`, a drop on Approved) submits an Approve review saying GO (a Comment on your own pull request, adding to your pending review if any) and stores `pr_flags.approved_oid`.
- Guardrails (PLAN.md §3):
  - Layer 1: `canUseTool` + `PreToolUse` hook (`guard.ts`) check every tool input that has a `command`, once per tool use. git is an allowlist by subcommand (read commands everywhere; address runs can also add, rm, mv, apply and unstage), `-c` takes only an allowlist of display keys, `GIT_*` variables other than `GIT_PAGER`, `GIT_TERMINAL_PROMPT` and `GIT_OPTIONAL_LOCKS` are refused, options that skip hooks or run other programs (`--no-verify`, `--upload-pack`, `--exec-path`) are refused, long options are matched as git does (exact name first, then unique prefix), `git-<sub>` programs run by name or from a `git-core` folder, and git's server programs like `git-receive-pack`, are checked as `git <sub>`, and `git fetch` may only write `refs/remotes/` and `refs/tags/`. `npm`, `pnpm`, `yarn` and `bun pm` `version` commands commit and tag, so they need `--no-git-tag-version` (npm abbreviations like `npm vers` and options before the command are covered). `gh` is read-only, with `gh api` parsed flag by flag. Dynamic commands (`$(…)`, a variable as the command or as a variable name, `eval`, a shell reading stdin) are refused, `$(…)` and backticks are checked recursively, heredoc bodies only for substitutions (not at all with a quoted delimiter), and `case` patterns and `[[ … ]]` operands are read as patterns. Syntax the guard cannot model is refused rather than parsed, with a hint on how to rewrite the command: lone `{`/`}` and `(` outside command start, zsh `<n-m>` globs, carriage returns, heredocs inside `$(…)`, `case` patterns with line continuations, no closing `)` or starting with `esac`, `${ …; }` command substitutions (also `${|…}`, `${<…}` and `${>…}`), attached shell options like `-oerrexit`, the zsh `braceccl` and `globsubst` options, `&>` in sh/dash/ksh scripts and `[[ … ]]` or `(( … ))` commands in sh/dash scripts (read from the lexed script, so quoted text like `[[:space:]]` passes, and the user's functions and aliases keep bash/zsh rules), csh/tcsh/fish, writes to command tables (`functions`, `commands`, `aliases`, `BASH_CMDS`…), `functions -c`/`-M`, `autoload`, `exec -c`, `npm_config_*`, `LESS*`, and `PAGER`/`GH_PAGER`/`MANPAGER` values other than plain pagers. Scripts passed to `sh -c` and `npm -c`/`--call` are checked as commands. The `git commit`/`git push` text backstop applies to unquoted words, interpreter code, shell `-c` scripts and user function bodies. Commands over 64 KB are refused (long content goes in a file, written with the Write tool in stages that can edit), and a work budget keeps every check fast. The user's shell aliases are expanded and the user's shell functions are checked through their bodies (probed once per app session, see `system/shell.ts`). Edits must resolve, through `..` and symlinks, to a path inside the worktree; read-only stages cannot edit.
  - Layer 2: the same `gh` policy as a shim in `<userData>/bin`, first on the agent `PATH`.
  - Layer 3: a per-worktree `core.hooksPath` pre-push hook that needs `PRISM_PUSH_NONCE` to match `<userData>/hooks/.push-nonce`, plus a push block in the agent env (`GIT_CONFIG_*` setting `url.prism-push-blocked://.pushInsteadOf`, with an exact entry per configured remote URL of the clone, read before `insteadOf` rewriting, so longer user rules can't win) that `--no-verify` cannot skip. A remote it can't cover, such as one with its own `pushurl`, is named in the run's transcript.
  - Layer 5: `prismContract` appended to the system prompt.
  - Project settings, hooks and `.mcp.json` come from the user's clone (`projectConfigRoot`), never from the pull request checkout. Only PRism's MCP server is loaded (`strictMcpConfig`), and the built-in `AskUserQuestion` is disabled in favour of `prism_ask_user`. Tool output, findings, questions and errors are redacted before they are stored.
  - These layers stop accidents and naive prompt injection, not a determined agent: Bash can still run scripts or read local credentials. An OS-level sandbox is a follow-up.
- The adapter uses the user's installed `claude` binary (`pathToClaudeCodeExecutable`).

## Conventions

- **IPC:** add a channel to `ipcChannels` in `src/shared/channels.ts` and its zod `input`/`output` in `ipcContract` (`src/shared/ipc.ts`), then a handler in `src/main/ipc/`. Events go in `ipcEvents` + `IpcEventPayloads`. Validate everything crossing the boundary with zod.
- **Schema:** edit `src/main/db/schema.ts`, then `pnpm db:generate`. Commit the generated SQL and snapshot.
- **Services** take `ctx: Ctx` first and stay free of Electron imports where possible so they are testable.
- **Tests:** Vitest. Services are tested with an in-memory DB (`openDb(':memory:', migrations)`) and fakes (e.g. a fake `GithubApi`; implement `graphqlPartial` and `get` in fakes).
- **Comments:** minimal, default none. Name things well instead.
- **UX:** no Save buttons for simple choices (selecting saves), custom pickers over native controls, one-click actions, end flows with a summary.
- **Public repo:** generic names only in code, docs, tests and commits (`acme`, `octocat`, `mattpocock/skills`). No private repo names, internal tools or personal data.
- **Docs:** any change to architecture, commands, conventions, data model, IPC or phase status updates `README.md` and/or this file in the same commit.

## Commands and gates

Run before every commit:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm check:denylist
```

Opt-in live test of the Claude adapter (spends a few cents with Haiku): `PRISM_LIVE=1 pnpm vitest run src/main/agents/claude.live.test.ts`.

## Outward-action rule

Agents run by PRism, and agents working on this repo, never commit, push, or post on GitHub on their own. In the app, only `ActionService` (`services/actions.ts`) commits, pushes and posts, after the user clicks the matching button in the post gate. Guardrails: PLAN.md §3.

## Gotchas

- The preload allowlist is not hot-reloaded in `pnpm dev`: restart the app after adding a channel or event, else "Unknown channel".
- Subscribe to board events (`prs:changed`, `sync:status`) in `RootLayout`, not `AppLayout`: onboarding sits outside `AppLayout`.
- Electron drag regions (`drag` utility) ignore z-index: anything clickable that overlays one (drawers, dialogs) needs `no-drag`, or clicks on it start a window drag.
- dnd-kit's default auto-scroll threshold jerks the wide board sideways; keep `threshold.x` around `0.08`.
- A card's draggable body (`role="button"`, keyboard drag, accessible name) is separate from its run strip and answer form, which stop pointer and key events. Keep interactive controls out of the body. Column visibility is frozen while a drag is in progress.
- Manual stage moves are refused while the card has a live run, in the UI and in `setPrStage`.
- GitHub GraphQL returns `data` with `errors` on partial failures. Use `graphqlPartial` when null nodes matter (e.g. `nodes(ids:)`), and only drop a PR on `NOT_FOUND`.
- Local builds must be ad-hoc signed (`pnpm install:app`). Signing with an Apple Development cert + hardened runtime makes the app die on launch.
- better-sqlite3 ships N-API prebuilds, so the same binary works in Vitest and Electron.
- TypeScript 7: no `baseUrl`; `paths` must start with `./`.
- oxlint flags `no-shadow` (watch `resolve` in tests). `__typename` is allowed.
- Visual checks: `pnpm build`, then Playwright `_electron` with `--user-data-dir=<scratch dir>` for a fresh profile.
- The Agent SDK is ESM-only; main loads it with a dynamic `import()` (kept as-is in the CJS bundle).
- Bare `allowedTools` entries bypass `canUseTool`; keep guards in the `PreToolUse` hook too, since project settings can also allow tools.
- The pre-push guard enables `extensions.worktreeConfig` on the clone and sets `core.hooksPath` per worktree, so the repo's own hooks do not run in PRism-created worktrees. Reused worktrees (created by other tools) don't get the hook; PRism still fast-forwards them, and follows force-pushes when they are clean at the head it last checked out. `git push --no-verify` skips hooks, which is why the push block lives in the agent env. PRism re-installs the guard when it reuses its own `pr-<n>` worktree.
- The CLI snapshots the user's `~/.zshrc` (or `~/.bashrc`, `~/.profile`) and loads its aliases and functions before every Bash command, so they run in agent shells; `ZDOTDIR` does not change that. The snapshot keeps the first 1000 alias lines, turns global aliases into regular ones and skips functions named `_x…`. PRism probes them the same way once per app session (`probeShell`, in the shell the CLI uses: `CLAUDE_CODE_SHELL` or `SHELL` when it is zsh or bash, else `/bin/zsh`), so restart PRism after editing them. A probe that fails or times out is noted in the run's transcript and retried on the next run.
- Never let the SDK read project config from a pull request checkout: a PR can ship `.claude/settings.json` hooks that run as soon as a session starts. Pass `projectConfigRoot` (the user's clone).
- SDK result messages carry session totals (`total_cost_usd`, `modelUsage`) that continue across `resume`. Store the latest value; summing segments double-counts.
- Test agent runs with a fake `AgentAdapter` and a fake `prepare` (see `runner.test.ts`); `worktrees.test.ts` uses real temp git repos.

## Status

| Phase                        | State                 |
| ---------------------------- | --------------------- |
| 0 Scaffold                   | Done                  |
| 1 Onboarding + skill sources | Done                  |
| 2 Sync + board               | Done                  |
| 3 Agent runner (Claude)      | Done                  |
| 4 Post gate + actions        | In progress           |
| 5–8                          | Planned (PLAN.md §15) |

Known follow-ups:

- Address runs do not rebase onto the PR base yet (PLAN.md §11).
- Guard layers are not a sandbox; run agents under an OS-level sandbox (SDK `sandbox`) for real containment.
- Codex / Gemini / Cursor adapters (Phase 7) plug into `AgentAdapter`.
- Phase 4 in progress: post gate, findings editing and ActionService (commit, push + verify, post review, replies).
- Shell probe: the retry path is untested in a packaged build, and a failing probe is retried for each command segment.
- `remoteUrls` reads raw remote URLs only, so the push block has no exact entry for a URL rewritten by `insteadOf`.
- Guard hints: an unquoted `?` is reported as "built at run time", and the `git commit`/`git push` backstop can flag a later pipe stage.
