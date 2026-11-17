# PRism — build plan

PRism is a macOS app for reviewing GitHub pull requests with AI agents. You watch repositories and get a kanban board of the PRs that involve you. You run review / address-comments skills in parallel and watch each one live. Every action that touches git history or GitHub waits for your go.

Status: phases 0–6 done, phase 8 started with notifications, the Dock badge, the menu bar, auto-run and the Mirador bridge (see [AGENTS.md](AGENTS.md#status)). The repo is public (MIT), so this document, the code and the defaults stay generic: no private repo names, no internal tooling, no personal data.

---

## 1. Principles

1. **Nothing goes out without your go.** Agents read code and edit the worktree, nothing more. Commit, push, review comments and replies run only from PRism, after you confirm.
2. **Ask until done or skipped.** After a review or an address run, PRism keeps offering to post on the PR until the comments are posted or you click **Skip posting comment** (§8).
3. **Less noise.** Stars, hide, archive, statuses that move on their own. Don't add buttons where automation will do.
4. **GitHub owns what GitHub knows.** Statuses are derived by the sync. A manual drag overrides until GitHub's state changes again.
5. **Generic by design.** Any repo, any skill source (public or private git repo, or a local folder), any supported agent. Project-specific behaviour lives in per-repo settings and in skill-source manifests, never in PRism's code.
6. **No server, no shared secrets.** Each user brings their own `gh` login, agent login and skill sources.

---

## 2. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | Electron + electron-vite, TypeScript | The Claude Agent SDK is Node-native, and spawning `gh`/`git`/CLIs is simple |
| UI | React 19, Tailwind v4, shadcn/ui, Geist + Geist Mono | |
| Routing / data | TanStack Router, TanStack Query over typed IPC | Cache + live invalidation pushed from main |
| State | Zustand (UI only) | |
| Kanban | dnd-kit | Accessible drag & drop, keyboard support |
| Charts | Hand-written SVG | Tiles, daily bars and one trend line don't need a chart library |
| Diff | Planned: `@pierre/diffs` or `react-diff-view` + Shiki | Findings anchored on diff lines |
| Markdown | react-markdown + remark-gfm; DOMPurify for GitHub's HTML | Skill reports; PR descriptions |
| DB | SQLite (better-sqlite3) + Drizzle | |
| GitHub | GraphQL/REST with the token from `gh auth token` | No new OAuth app |
| Agents | `@anthropic-ai/claude-agent-sdk`; CLI adapters for `codex exec --json`, `gemini -p --output-format stream-json`, `cursor-agent -p --output-format stream-json` | |
| Packaging | electron-builder, hardened runtime, notarytool, electron-updater on GitHub Releases | |
| Tests | Vitest (main + core logic), Playwright `_electron` for visual checks | |

### Theme tokens

Dark uses the given palette. Light is derived from it, and the app follows macOS appearance with an override in Settings.

| Token | Dark | Light |
| --- | --- | --- |
| `--background` | `#0B0D13` | `#F7F7FA` |
| `--surface` | `#151821` | `#FFFFFF` |
| `--border` | `#272B36` | `#E3E4EA` |
| `--primary` | `#7955E8` | `#6A45DD` |
| `--accent` | `#B4A0FF` | `#7C63F0` (text) / `#EEE9FF` (bg) |
| `--success` | `#60D6A0` | `#1F9D67` |
| `--warning` | `#F5BB68` | `#B7791F` |
| `--destructive` | `#F2757A` | `#D64045` |
| `--muted-foreground` | `#8A90A2` | `#5F6475` |

---

## 3. Architecture

```
┌──────────────────────── Electron main (Node) ────────────────────────┐
│ SyncService     GitHub poll 60s + on focus, ETags, rate budget       │
│ Store           SQLite                                               │
│ SkillSources    clone/update/bootstrap sources, import skills         │
│ SkillLibrary    imported + linked + custom skills, stage bindings     │
│ StageEngine     derives PR stage, overrides, auto-run, post gate      │
│ AgentRunner     unlimited parallel runs, adapters, session resume    │
│   ├ ClaudeAdapter (Agent SDK, canUseTool + hooks)                    │
│   ├ Codex / Gemini / Cursor adapters (CLI, JSONL)                    │
│   └ PrismMCP     tools shared by every adapter                       │
│ WorktreeService own git worktree mgmt (+ Mirador bridge if present)  │
│ Guardrails      gh shim + pre-push hook + tool policy               │
│ ActionService   the ONLY code that commits / pushes / posts          │
│ Notifier · Tray · Dock badge · Updater                               │
└──────────────── typed IPC (contextBridge, zod-validated) ────────────┘
┌──────────────────────── Renderer (React) ────────────────────────────┐
│ Onboarding · Dashboard · Board · PR drawer · Archive · Runs · Settings│
└──────────────────────────────────────────────────────────────────────┘
```

### PRism MCP tools (exposed to every agent)

| Tool | Purpose |
| --- | --- |
| `prism_report_findings` | Verdict, review status, summary, findings[] `{path, line, side, severity: blocking\|nit\|refactor, nitDecision: address\|followup\|skip, title, body, suggestion?, priorFindingId?}`, dimension scan |
| `prism_report_prior_status` | Re-review: status of each earlier finding: `resolved \| still_open \| disputed \| obsolete` |
| `prism_report_changes` | Address flow: per thread `fix \| push_back \| defer`, files touched, test/lint results |
| `prism_draft_replies` | Draft reply per thread id (posted only through the post gate) |
| `prism_ask_user` | Pauses the run. The card goes to **Needs you** with an inline form, and the answer resumes the same session |
| `prism_progress` | Live step label |

### Guardrails (layered, so they hold for every agent)

1. **Claude:** `canUseTool` + PreToolUse hook check every command: git by a subcommand allowlist, `gh` read-only (`gh api` parsed flag by flag, no writes or mutations), dynamic commands (`$(…)`, `eval`, piping into a shell) refused, edits only inside the worktree.
2. **All agents:** a `gh` shim first on the agent's `PATH`, read subcommands only.
3. **All agents:** a `pre-push` hook in every PRism worktree that refuses unless `PRISM_PUSH_NONCE` is set (only ActionService sets it), plus a push block in the agent env (`pushInsteadOf`) that `--no-verify` cannot skip.
4. **Codex:** `--sandbox workspace-write` (no network) for read-only stages.
5. **PRism contract:** a prompt appended to every run. It overrides any skill step that would post, commit or push, and turns it into `prism_draft_replies` / `prism_ask_user`.

Project settings, hooks and MCP config always come from the user's clone, never from the pull request checkout. These layers stop accidents and naive prompt injection; an OS-level sandbox for Claude runs is a follow-up.

---

## 4. Skills: sources, import, stage bindings

### Stages that run a skill

| Stage | What the skill does |
| --- | --- |
| Review | Full review of a PR → findings + verdict |
| Re-review | Incremental review since the last reviewed commit (§7) |
| Test plan | Write "How to test" when the PR has none |
| Address comments | Fix named review threads in the worktree, draft replies |
| Draft replies | Write replies for threads (also runs standalone) |

### Skill sources

A **skill source** is a git repo URL (public or private, cloned with the user's own git credentials) or a local folder. Examples: a public collection such as `github.com/mattpocock/skills` (proposed by default for new repos), a company-private skills repo, or the user's own folder.

For each source, PRism:
1. **Locates** it: checks for a configured path, then common folders for an existing clone with the same remote URL.
2. **Installs** it if missing: clones into the folder you choose (default `~/Library/Application Support/PRism/sources/<name>`).
3. **Bootstraps** it if the source declares a setup step (dependency install, identity, etc.; see manifest below), and shows the output.
4. **Scans** for `SKILL.md` files (agent-skills format: frontmatter `name` + `description`).
5. **Imports** the chosen skills into the PRism library ("steal"). You then validate which skill serves which stage. Import is by **copy** (you own it, it can diverge) or by **link** (tracks the source, re-synced on `git pull`).

### Optional source manifest: `prism-source.json`

A skill repo can describe itself so PRism handles identity and import the way the repo expects. Without a manifest, PRism uses generic mode (scan + copy/link).

```jsonc
{
  "name": "Team skills",
  "setup": ["pnpm install"],                       // run after clone / when health check fails
  "health": "./bin/tool --version",                // optional
  "identities": {                                  // "who are you?"
    "list": "personal/*",                          // glob → one identity per folder
    "current": { "file": "local/config.json", "jsonPath": "$.username" }
  },
  "skillRoots": ["skills", "personal/{identity}/skills"],
  "import": "./bin/tool steal {from} --skills {skills}",   // optional native import cmd
  "stageHints": { "review": ["pr-review"], "address": ["address-comments"] }
}
```

This keeps PRism agnostic. A private team repo adds this file on its side, and PRism never names it.

### Custom skills (last fallback)

For any stage you can drop a `SKILL.md` / `.md` file or write one in the built-in editor. You choose:
- **Copy into library:** editable in PRism.
- **Link to local file:** PRism watches the file and picks up edits automatically.

### Bindings

Every stage has a global default. Each repo can override per stage. Every binding shows its origin badge: `Imported · <source>`, `Linked · <source>`, `Custom`, `Linked file`.

---

## 5. Onboarding (first launch, re-runnable)

1. **GitHub:** run `gh auth status`. If it fails, show `gh auth login`. Show the user and scopes (`repo`, `read:org`).
2. **Agent:** detect `claude`, `codex`, `gemini`, `cursor-agent`, test login for each, pick the default agent + one global model.
3. **Repositories:** add any `owner/name`. Then, per repo:
   1. **Local clone:** auto-detect, or pick/clone.
   2. **Worktree folder:** default `<parent of clone>/<repoName>-worktrees/` (e.g. `~/code/acme-worktrees/`), editable.
   3. **Skill engine:** pick a skill source (default proposal: `mattpocock/skills`; or paste a git URL, or a local folder) → locate / install / bootstrap.
   4. **Who are you?** Only when the source manifest declares identities. Pre-selected from `identities.current`.
   5. **Stage bindings:** proposed from `stageHints`, else from name/description matching. A missing stage shows warning-yellow with three ways to fill it:
      - pick a skill from another identity (manifest `import` if declared, else copy),
      - pick from another source,
      - drop / write a custom file.
      Every stage must be validated (✓) by you.
   6. **Options:** auto-run (a review when someone requests yours by name), report to Mirador (when its CLI is installed), expected-red CI checks to ignore, labels that mean "QA pending".
4. **Notifications** (optional): **Turn on notifications** sends a test, so the macOS permission prompt shows while you are looking. macOS asks only once per app; after a refusal only System Settings can turn them on, so Settings → Notifications has an **Open System Settings** button.
5. **Initial scan:** PRs requesting your review (direct + team), PRs you authored, PRs you took over (you pushed commits to someone else's PR). Progress per repo, then the board opens. Daily snapshot #1 is written.

---

## 6. Board

Jira-style cards in stage columns. Drag & drop changes the stage.

### One review loop, both tabs

Action columns run something when a card is dropped on them; state columns show where the pull request stands after it. The loop circles until the pull request reaches To approve.

| Column | Kind | Shown when |
| --- | --- | --- |
| Needs you | agent | A run asks a question (hidden when empty) |
| Waiting review | state | My PRs only: nobody reviewed yet, or address / replies posted, waiting on reviewers (drop on Reviewing to self-review) |
| To review | state | Reviews only: review requested, nothing reviewed yet |
| Reviewing | **action**: review / re-review | Review run active, or finished with its post gate open |
| Changes requested | state | Last posted review is NO GO or GO WITH NITS; on Reviews also my review with no new commits since |
| Addressing | **action**: address (My PRs only) | Address run active, or finished with its post gate open |
| To re-review | state | New commits pushed after a NO GO / GO WITH NITS was posted (after a GO: any commit the review did not cover); drop on Reviewing to re-review |
| To approve | state | Last posted review is GO |
| Approved | **action**: approve | Approved on GitHub, or approved from PRism at the current head. Own PR: GitHub refuses Approve, so PRism posts a Comment saying GO |
| Done | state | Merged / closed |

Posting a gate moves the card: review → To approve (GO) or Changes requested (GO WITH NITS, NO GO), or straight to Approved when submitted as Approve; address and replies on My PRs → Waiting review (back to the reviewers). Skipping a gate moves it the same way.

**Next step:** the drawer header, and the summary of a posted or skipped gate, show a split button for cards in state columns. Its main action moves the loop forward (To review / Waiting review / To re-review → review or re-review run, Changes requested → address on My PRs or To re-review on Reviews, To approve → approve); its menu lists every other run, Approve, and every other state column.

**Card:** repo chip, `#num`, title, author avatar, stage age, CI dot, labels, size, verdict badge, unresolved threads, star, live spinner, Needs-you glow.

**Card actions** (hover + context menu + keyboard):
- **Star:** pinned at the top of its column, shown by the "Starred" filter.
- **Hide:** off the board but still tracked and synced. A "Show hidden (n)" toggle brings it back. Notifications muted.
- **Archive:** removed from the board, moved to the **Archive** section (sidebar). Sync stops except a light state check. Can be restored. Done PRs auto-archive after 24h (setting).

**Drag rules**
- Dropping into Reviewing or Addressing starts that stage's skill (confirm the first time).
- Dropping into Approved approves the pull request on GitHub (confirmed every time).
- Any other drop is a manual override, marked "manual", and cleared when GitHub's derived state changes.

**Toolbar:** repo filter, Starred, Needs me, Show hidden, search (`#num`, `@user`, words), density.

---

## 7. Re-review (incremental)

**Today:** every review is a full pass, and it avoids repeats only by reading existing comments first. That's slow on large PRs and still repeats itself sometimes.

**PRism:** a review ledger per PR.
- Each run stores `reviewedHeadOid`, `reviewedBaseOid`, and every finding with a stable id + anchor (`path`, line, hunk hash).
- Posted comments are linked to their finding (GitHub comment id ↔ finding id).

A re-review runs two cheap passes instead of one full one:
1. **Prior findings check:** for each open finding, look at the current code + thread replies and mark it `resolved / still_open / disputed / obsolete`. Disputed findings show the author's reply, and you decide.
2. **Delta review:** review only `reviewedHeadOid..headOid`.
   - **Force-push / rebase:** use `git range-diff` to drop commits that only changed by the rebase, then review just the real changes.
   - **Base-only merges:** skipped.

The agent gets the ledger as context with the rule "don't raise anything already in the ledger".

**Escalation to a full review:** a **Full review** button (the Review stage on an already reviewed pull request). Automatic escalation when the delta touches more than ~40% of the PR's changed lines or the PR's scope changed (new packages touched) is a follow-up.

**Phase 5 scope (trimmed, 2026-11-12):** PRism-computed delta (new commits, base-merge skip, range-diff after a force-push), repeat guard on stable anchors, Full review. Follow-ups: automatic escalation, the disputed-finding view with the author's reply, and a per-PR ledger history in the drawer.

Cost/time win: a typical re-review reads a few hundred lines instead of the whole PR, and only new findings are posted.

---

## 8. Post gate (after every review or address run)

When a run ends, its card stays in Reviewing or Addressing, marked ready to post, and the drawer's **Post** tab shows a live checklist. The post button unlocks only when every check passes:

**After a review**
- [ ] Findings validated (include/exclude/edit each)
- [ ] Review status chosen (Approve / Comment / Request changes, pre-filled from the verdict). GitHub refuses Approve and Request changes on your own pull request, so there it is Comment and the picker is hidden
- [ ] Mode: **Submit now** or **Stage as pending draft**. The default is **Stage as pending draft**, set in Settings, and each repository can override it.

**After addressing comments**
- [ ] Named threads have a verdict (fix / push back / defer)
- [ ] Changes committed: **Commit** button (editable short message)
- [ ] Pushed: **Push** button (`--force-with-lease` after a rebase)
- [ ] Remote head == local head (verified via the API, not the push output)
- [ ] Replies chosen: tick the threads to answer (only those), edit drafts, AI tag line appended

**Behaviour**
- Unmet checks show what's missing with the button that fixes it.
- The checklist is recomputed live (GitHub head, pending review, worktree), and the gate stays open, counted in the Dock badge and the menu bar, until the comments are **posted** or you click **Skip posting**.
- Skip is stored per run, and the card moves to the next derived column.
- After posting, PRism links each GitHub comment id back to its finding in the ledger.
- A pending review you already have gets the new comments instead of a second review. Everything posted ends with one AI tag line: when PRism adds to a pending review, the draft's tag moves to the end instead of repeating.

---

## 9. PR drawer

Tabs:
- **Overview:** checks (ignoring the repo's expected-red checks), reviewers, linked issues, labels, description.
- **Runs:** each run's live transcript and report (verdict, findings, changes or draft replies), tokens/cost; answer a question, send a follow-up, dismiss. Footer: open the worktree in your editor, or resume the agent session in your terminal.
- **Post:** the post gate.
- Planned: a **Findings** tab anchored on the diff with the ledger history, and a **Changes** tab with the worktree diff.

---

## 10. Dashboard

- Stat tiles with Δ% vs yesterday: open PRs, open issues, awaiting my review, my open PRs.
- Opened / merged / closed per day: exact daily counts from GitHub search date qualifiers, so useful from day 1.
- Open-total trend: open pull requests at the end of each day (open now and created by then, plus closed after it), from GitHub search, so useful from day 1.
- Review latency: median time from request to my first review (7d / 30d).
- Needs-you list + running agents strip.

---

## 11. Agent runs

- Unlimited parallel runs, one worktree each.
- Lifecycle: `queued → preparing → running ⇄ needs_you → done | failed | cancelled`.
- Session ids are persisted, so a run resumes after a Needs-you answer or an app restart.
- **Worktrees:** `<repo worktree folder>/pr-<number>`. Fork PRs get a remote per fork. Existing worktrees of the branch (from any tool, via `git worktree list`) are reused. PRism removes its own worktrees once the pull request is merged or closed, unless they hold uncommitted changes or commits that are not on GitHub.
- **Address runs:** rebase onto the PR's real base first (stacked PRs included).
- **Auto-run** (opt-in per repository): a review request that names you starts a Review, or a Re-review when you reviewed before, two runs at a time at most. New commits never start one: the author asks again when it's ready. Team requests stay manual, since a teammate may take them.
- **Mirador bridge** ([Mirador](https://github.com/Adzouz/Mirador) is a macOS work tracker; optional: offered only when its `mirador` CLI is installed, then switched on per repository, since Mirador tracks a single repository): marks a pull request Reviewing when a review or re-review run starts and Addressing when an address run starts on your pull request, and adds the verdict as a note (GO / GO WITH NITS / NO GO + one reason) when a review is posted. Mirador's own GitHub sync sets every other status.
- **Notifications:** needs you (answer from the notification), run done or failed, new review request, CI red on my PR. The dock badge shows the Needs-you count: agent questions plus runs ready to post. The menu bar shows the Needs-you list, the cards where it's your turn (not counted) and running agents. macOS asks for permission once per app: onboarding triggers the prompt, and Settings links to System Settings.

---

## 12. Data model (SQLite, in `~/Library/Application Support/PRism`)

`src/main/db/schema.ts` is the source of truth; migrations live in `drizzle/`.

```
repos(id, owner, name, local_path, worktree_root, skill_source_id, auto_run, mirador,
      ignored_checks_json, qa_labels_json, post_mode[submit|draft]?, added_at, last_synced_at)
skill_sources(id, kind[git|local|builtin], name, url_or_path, local_path, manifest_json, identity,
              setup_at, last_synced_at)
skills(id, source_id?, name, description, mode[copy|link|custom|linked_file], path, content_hash)
stage_bindings(id, scope[global|repo], repo_id?, stage, skill_id, validated_at)
prs(id, repo_id, node_id, number, title, url, author, author_avatar, is_draft, state, head_ref, head_oid,
    base_ref, base_oid, review_decision, ci_state, labels_json, additions, deletions, changed_files,
    unresolved_threads, review_requested, requested_team, my_review_state, my_review_oid, my_review_at,
    changes_requested_at, my_role[reviewer|author|takeover], derived_stage, stage_since,
    created_at, updated_at, closed_at, synced_at)
pr_flags(pr_id, starred, hidden, archived_at, restored_at, manual_stage, manual_stage_basis,
         approved_oid, approved_at)
runs(id, pr_id, stage, skill_id, skill_name, agent, model, session_id, worktree_path, status, progress,
     reviewed_head_oid, reviewed_base_oid, report_json, changes_json, replies_json, threads_json,
     findings_json, push_remote, push_ref, created_at, started_at, ended_at, dismissed_at,
     tokens_in, tokens_out, cost_usd, error)
run_events(id, run_id, ts, kind, payload_json)
findings(id, pr_id, run_id, anchor_path, anchor_line, side, hunk_hash, severity, nit_decision,
         title, body, suggestion, prior_finding_id, included, edited_body, status, gh_comment_id)
post_gates(run_id, kind[review|address|replies], mode, event, body, commit_message, committed_oid,
           pushed_oid, replies_json, gh_review_id, gh_review_url, posted_body, posted_head_oid,
           confirmed_at, posted_at, skipped_at)
asks(id, run_id, prompt, schema_json, answer_json, created_at, answered_at)
snapshots(repo_id, day, open_prs, open_issues, awaiting_me, my_open, taken_at)
activity(repo_id, day, opened, merged, closed, open_prs, fetched_at)
review_latency(repo_id, pr_node_id, requested_at, reviewed_at)
settings(key, value_json)
```

---

## 13. Public repo & sensitive data

The repo `Adzouz/prism` is safe to make public if these rules hold:

| Item | Where it lives | In repo? |
| --- | --- | --- |
| GitHub token | read at runtime from `gh auth token`, never stored | No |
| Agent credentials | each agent CLI / SDK's own login | No |
| Any API key (optional providers) | macOS Keychain | No |
| Apple ID, app-specific password, cert | GitHub Actions secrets + local Keychain profile | No |
| Apple Team ID | public anyway (visible in any signed binary); still read from env in CI | No (env) |
| Local DB, transcripts, worktree paths | `~/Library/Application Support/PRism` | No |
| Private skill sources | user-entered URLs, stored locally | No |
| Defaults in code | generic only (e.g. `mattpocock/skills`) | Yes |

Plus:
- a CI check that greps for a denylist of private names/keys, and
- transcripts redact tokens before storage.

---

## 14. Distribution

- Developer ID Application cert, hardened runtime. No App Sandbox, because the app spawns `git`/`gh`/agents.
- Notarization via `notarytool`, with credentials from GitHub Actions secrets.
- Universal DMG on GitHub Releases, with electron-updater (public repo, so no token needed).
- Today: `pnpm install:app` builds an ad-hoc signed arm64 app into `/Applications` for your own Mac. The DMG waits on a Developer ID Application certificate, which only the Apple developer team's Account Holder can create, and on notarization credentials.

---

## 15. Phases

| # | Phase | Done when |
| --- | --- | --- |
| 0 | Scaffold: electron-vite, shadcn, tokens dark/light, Geist, typed IPC, SQLite, lint/test, signed dev build, secret-denylist CI | Empty signed app opens, theme switches |
| 1 | Onboarding + skill sources: gh/agent detection, repos, worktree folder, source locate/install/bootstrap/manifest, import copy/link/custom, stage validation | Fresh machine reaches a validated config |
| 2 | Sync + Board: stage derivation, kanban dnd, star/hide/archive, overrides, filters, Archive section, PR drawer Overview | Board mirrors GitHub within 60s |
| 3 | Agent runner (Claude): worktrees, MCP tools, guardrails, live transcript, Needs-you, resume, any stage from the drawer (incl. test plan, draft replies), review-thread picker, follow-up messages, dismiss, open worktree in editor/terminal, resume in terminal | Review runs in parallel on 3 PRs |
| 4 | Post gate + actions: findings editing, submit/draft review, commit, push + verify, replies, ledger linking | Full review→post and address→push→reply loops on real PRs |
| 5 | Re-review ledger: prior-findings pass, delta + range-diff, escalation | Re-review posts only new findings |
| 6 | Dashboard | Δ% correct on day 2 |
| 7 | Codex / Gemini / Cursor adapters | Same review runs on each |
| 8 | macOS polish + release: notifications, badge, menu bar, auto-run, Mirador bridge, notarized DMG + updater | v0.1.0 installs on a teammate's Mac |

---

## 16. Open questions

1. ~~Default review post mode~~: answered in §8 (pending draft by default, per-repo override).
2. ~~`mattpocock/skills` default~~: answered. Onboarding proposes it, and offers **Use built-in starter** (`resources/skills/`) as the zero-config fallback.
