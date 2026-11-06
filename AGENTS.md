# AGENTS.md

Guide for coding agents and contributors working on PRism. Product context lives in [PLAN.md](PLAN.md). User-facing setup lives in [README.md](README.md).

## Architecture

Electron app, three processes plus shared code:

| Path                          | Role                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`           | App bootstrap: opens the DB, builds `Ctx`, registers IPC, starts sync                                                                                         |
| `src/main/services/`          | Business logic, one file per area (see below)                                                                                                                 |
| `src/main/ipc/`               | `register.ts` (zod-validated `ipcMain.handle`), `handlers.ts` (onboarding/config), `board-handlers.ts` (board + sync), `emit.ts` (push events to all windows) |
| `src/main/db/`                | `schema.ts` (Drizzle), `client.ts` (opens SQLite, WAL, runs migrations), `settings.ts` (typed key/value)                                                      |
| `src/main/skills/`            | Skill scanning, `prism-source.json` manifest parsing, stage matching                                                                                          |
| `src/main/system/exec.ts`     | `run` / `runStreaming` with the user's login-shell `PATH`                                                                                                     |
| `src/preload/index.ts`        | `window.prism` bridge: `invoke(channel, input)` and `on(event, listener)`, both allowlisted                                                                   |
| `src/shared/channels.ts`      | Allowlists: `ipcChannels`, `ipcEvents`                                                                                                                        |
| `src/shared/ipc.ts`           | `ipcContract` (zod input/output per channel) and `IpcEventPayloads`                                                                                           |
| `src/shared/domain.ts`        | Domain schemas and types shared by main and renderer                                                                                                          |
| `src/renderer/src/features/`  | `board/` (board, card, drawer, toolbar, archive, zustand store in `model.ts`), `onboarding/`                                                                  |
| `src/renderer/src/lib/api.ts` | `invoke`, TanStack Query hooks, query keys, event subscriptions                                                                                               |
| `drizzle/`                    | Generated migrations, applied on startup                                                                                                                      |
| `resources/skills/`           | Built-in starter skills, bundled via `extraResources`                                                                                                         |

### Main services

| Service                     | Responsibility                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                 | Onboarding status, agent config, full reset                                                                          |
| `github.ts` / `gh-api.ts`   | `gh` CLI helpers; GraphQL/REST client using `gh auth token` (`graphql`, `graphqlPartial`, `probe` with ETag, `rate`) |
| `repos.ts` / `git.ts`       | Watched repositories, clone detection, worktree root                                                                 |
| `sources.ts` / `library.ts` | Skill sources (locate, install, bootstrap, sync) and the skill library + stage bindings                              |
| `agents.ts`                 | Agent CLI detection and login checks                                                                                 |
| `sync.ts`                   | Per-repo board query, stale refresh, takeover detection, CI, daily snapshots, auto-archive, sync scheduler           |
| `pr-stage.ts`               | Pure stage derivation (`deriveStage`) and manual-override basis (`stageBasis`)                                       |
| `prs.ts` / `checks.ts`      | Board list, PR detail, flags, manual stages, board settings; CI checks with ignored patterns                         |

### Data model

SQLite at `~/Library/Application Support/PRism/prism.db`. Tables: `settings`, `skill_sources`, `repos`, `skills`, `stage_bindings`, `prs`, `pr_flags`, `snapshots`. Planned tables are listed in PLAN.md §12.

## Conventions

- **IPC:** add a channel to `ipcChannels` in `src/shared/channels.ts` and its zod `input`/`output` in `ipcContract` (`src/shared/ipc.ts`), then a handler in `src/main/ipc/`. Events go in `ipcEvents` + `IpcEventPayloads`. Validate everything crossing the boundary with zod.
- **Schema:** edit `src/main/db/schema.ts`, then `pnpm db:generate`. Commit the generated SQL and snapshot.
- **Services** take `ctx: Ctx` first and stay free of Electron imports where possible so they are testable.
- **Tests:** Vitest. Services are tested with an in-memory DB (`openDb(':memory:', migrations)`) and fakes (e.g. a fake `GithubApi`; implement `graphqlPartial` in fakes).
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

## Outward-action rule

Agents run by PRism, and agents working on this repo, never commit, push, or post on GitHub on their own. In the app, only `ActionService` (Phase 4) commits, pushes and posts, after the user confirms. Guardrails: PLAN.md §3.

## Gotchas

- The preload allowlist is not hot-reloaded in `pnpm dev`: restart the app after adding a channel or event, else "Unknown channel".
- Subscribe to board events (`prs:changed`, `sync:status`) in `RootLayout`, not `AppLayout`: onboarding sits outside `AppLayout`.
- dnd-kit's default auto-scroll threshold jerks the wide board sideways; keep `threshold.x` around `0.08`.
- GitHub GraphQL returns `data` with `errors` on partial failures. Use `graphqlPartial` when null nodes matter (e.g. `nodes(ids:)`), and only drop a PR on `NOT_FOUND`.
- Local builds must be ad-hoc signed (`pnpm install:app`). Signing with an Apple Development cert + hardened runtime makes the app die on launch.
- better-sqlite3 ships N-API prebuilds, so the same binary works in Vitest and Electron.
- TypeScript 7: no `baseUrl`; `paths` must start with `./`.
- oxlint flags `no-shadow` (watch `resolve` in tests). `__typename` is allowed.
- Visual checks: `pnpm build`, then Playwright `_electron` with `--user-data-dir=<scratch dir>` for a fresh profile.

## Status

| Phase                        | State                 |
| ---------------------------- | --------------------- |
| 0 Scaffold                   | Done                  |
| 1 Onboarding + skill sources | Done                  |
| 2 Sync + board               | Done                  |
| 3 Agent runner (Claude)      | Next                  |
| 4–8                          | Planned (PLAN.md §15) |
