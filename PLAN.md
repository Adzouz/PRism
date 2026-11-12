# PRism — build plan

PRism is a macOS app for reviewing GitHub pull requests with AI agents. You watch repositories and get a kanban board of the PRs that involve you. You run review / address-comments skills in parallel and watch each one live. Every action that touches git history or GitHub waits for your go.

Status: phases 0–2 done, phase 3 in review (see [AGENTS.md](AGENTS.md#status)). The repo is public (MIT), so this document, the code and the defaults stay generic: no private repo names, no internal tooling, no personal data.

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
| Charts | shadcn charts (Recharts) | |
| Diff | `@pierre/diffs` or `react-diff-view` + Shiki | Findings anchored on diff lines |
| Markdown | react-markdown + remark-gfm + Shiki | Skill reports |
| DB | SQLite (better-sqlite3) + Drizzle | |
| GitHub | GraphQL/REST with the token from `gh auth token` | No new OAuth app |
| Agents | `@anthropic-ai/claude-agent-sdk`; CLI adapters for `codex exec --json`, `gemini -p --output-format stream-json`, `cursor-agent -p --output-format stream-json` | |
| Packaging | electron-builder, hardened runtime, notarytool, electron-updater on GitHub Releases | |
| Tests | Vitest (main + core logic), Playwright for Electron (smoke) | |

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
   6. **Options:** auto-run (read-only stages), expected-red CI checks to ignore, labels that mean "QA pending".
4. **Initial scan:** PRs requesting your review (direct + team), PRs you authored, PRs you took over (you pushed commits to someone else's PR). Progress per repo, then the board opens. Daily snapshot #1 is written.

---

## 6. Board

Jira-style cards in stage columns. Drag & drop changes the stage.

### One review loop, both tabs

Action columns run something when a card is dropped on them; state columns show where the pull request stands after it. The loop circles until the pull request reaches To approve.

| Column | Kind | Shown when |
| --- | --- | --- |
| Needs you | agent | A run asks a question (hidden when empty) |
| To review | state | Nothing reviewed yet (Reviews: review requested; My PRs: no change request) |
| Reviewing | **action**: review / re-review | Review run active, or finished with its post gate open |
| Changes requested | state | Last posted review is NO GO or GO WITH NITS; on Reviews also my review with no new commits since |
| Addressing | **action**: address (My PRs only) | Address run active, or finished with its post gate open |
| To re-review | state | Address posted, or new commits since the last review; drop on Reviewing to re-review |
| To approve | state | Last posted review is GO |
| Approved | **action**: approve | Approved on GitHub, or approved from PRism at the current head. Own PR: GitHub refuses Approve, so PRism posts a Comment saying GO |
| Done | state | Merged / closed |

Posting a gate moves the card: review → To approve (GO) or Changes requested (GO WITH NITS, NO GO), or straight to Approved when submitted as Approve; address → To re-review. Skipping a gate moves it the same way.

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

**Escalation to a full review:** a **Full review** button, plus automatic escalation when the delta touches more than ~40% of the PR's changed lines or the PR's scope changed (new packages touched).

Cost/time win: a typical re-review reads a few hundred lines instead of the whole PR, and only new findings are posted.

---

## 8. Post gate (after every review or address run)

When a run ends, the card moves to **Verdict ready** / **Ready to post** and a **Post to PR?** panel opens. It shows a live checklist, and the post button unlocks only when every check passes:

**After a review**
- [ ] Findings validated (include/exclude/edit each)
- [ ] Review status chosen (Approve / Comment / Request changes, pre-filled from the verdict)
- [ ] Mode: **Submit now** or **Stage as pending draft**. The default is **Stage as pending draft**, set in Settings, and each repository can override it.

**After addressing comments**
- [ ] Named threads have a verdict (fix / push back / defer)
- [ ] Changes committed: **Commit** button (editable short message)
- [ ] Pushed: **Push** button (`--force-with-lease` after a rebase)
- [ ] Remote head == local head (verified via the API, not the push output)
- [ ] Replies chosen: tick the threads to answer (only those), edit drafts, AI tag line appended

**Behaviour**
- Unmet checks show what's missing with the button that fixes it.
- The panel re-opens (notification + Needs-you badge) whenever state changes or the app regains focus, until the comments are **posted** or you click **Skip posting comment**.
- Skip is stored per run, and the card moves to the next derived column.
- After posting, PRism links each GitHub comment id back to its finding in the ledger.

---

## 9. PR drawer

Tabs:
- **Overview:** description, linked issues, labels, CI (ignoring the repo's expected-red checks).
- **Runs:** live transcript, tokens/cost, resume.
- **Findings:** grouped by severity, anchored on the diff, plus the ledger history.
- **Changes:** worktree diff.
- **Report:** full markdown.
- **Post:** the post gate.
- Footer: open the worktree in your editor / terminal, or resume the agent session in a terminal.

---

## 10. Dashboard

- Stat tiles with Δ% vs yesterday: open PRs, open issues, awaiting my review, my open PRs.
- Opened / merged / closed per day: exact daily counts from GitHub search date qualifiers, so useful from day 1.
- Open-total trend from daily snapshots, starting at install.
- Review latency: median time from request to my first review (7d / 30d).
- Needs-you list + running agents strip.

---

## 11. Agent runs

- Unlimited parallel runs, one worktree each.
- Lifecycle: `queued → preparing → running ⇄ needs_you → done | failed | cancelled`.
- Session ids are persisted, so a run resumes after a Needs-you answer or an app restart.
- **Worktrees:** `<repo worktree folder>/pr-<number>`. Fork PRs get a remote per fork. Existing worktrees of the branch (from any tool, via `git worktree list`) are reused. Cleanup is offered on archive.
- **Address runs:** rebase onto the PR's real base first (stacked PRs included).
- **Mirador bridge** (optional, auto-detected): reports review/addressing steps through the `mirador` CLI.
- **Notifications:** needs you, run done, new review request, CI red on my PR. The dock badge shows the Needs-you count. The menu bar shows running agents and the Needs-you list.

---

## 12. Data model (SQLite, in `~/Library/Application Support/PRism`)

```
repos(id, owner, name, local_path, worktree_root, auto_run, ignored_checks_json, added_at)
skill_sources(id, url_or_path, local_path, manifest_json, identity, last_synced_at)
skills(id, source_id?, name, description, mode[copy|link|custom|linked_file], path, content_hash)
stage_bindings(scope[global|repo], repo_id?, stage, skill_id, validated_at)
prs(id, repo_id, number, title, author, is_draft, head_ref, head_oid, base_ref, base_oid,
    state, review_decision, ci_state, labels_json, additions, deletions, updated_at,
    my_role[reviewer|author|takeover], derived_stage, synced_at)
pr_flags(pr_id, starred, hidden, archived_at, manual_stage, manual_stage_basis_hash)
runs(id, pr_id, stage, skill_id, agent, model, session_id, worktree_path, status,
     reviewed_head_oid, reviewed_base_oid, started_at, ended_at, tokens_in, tokens_out, cost_usd, error)
run_events(id, run_id, ts, kind, payload_json)
findings(id, pr_id, run_id, anchor_path, anchor_line, hunk_hash, severity, nit_decision,
         title, body, suggestion, included, edited_body, status, gh_comment_id)
post_gates(run_id, kind[review|address], checklist_json, mode, posted_at, skipped_at)
asks(id, run_id, prompt, schema_json, answer_json, answered_at)
snapshots(repo_id, day, open_prs, open_issues, awaiting_me, my_open, opened, merged, closed, latency_median_s)
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
2. `mattpocock/skills` default: confirm its layout fits stage hints (checked at phase 1), else ship a tiny built-in starter set as the zero-config fallback.
