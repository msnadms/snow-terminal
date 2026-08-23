# Marrying Claude agents to workflows — implementation plan

Self-contained. Read this plus `CLAUDE.md` (sections **Workflows**, **Agents (Claude and Codex)**,
**Session tabs**, **User config**) and you have everything needed to implement without prior
conversation.

Every git and filesystem fact asserted in §3 was verified on this machine (Windows 11, Git Bash).
Every `file:line` was checked against the working tree at commit `d56f629` (v1.4.0) **with
uncommitted changes present** — the session-status feature (§2) is mid-flight in the working tree, so
re-check line numbers before trusting them, but do **not** re-derive the facts.

---

## 1. The problem

snow is a good _substrate_ for parallel agents — per-worktree indexes, a real diff/stage/commit
surface per branch, durable registry state — but it is not yet _married_ to them. Three gaps:

1. **Session status is inferred from bytes, not observed.** `Terminal.tsx` calls a pane `busy` after
   a sustained burst of PTY output and `idle` after quiet. That cannot distinguish "Claude finished"
   from "Claude is blocked on a permission prompt", cannot see thinking (quiet, no output), and pins
   `busy` forever on an animated spinner. The one state worth surfacing — _it needs you_ — is exactly
   the one the heuristic cannot see.
2. **Cost is global, not attributed.** `usage.ts` sums spend across every agent session on the
   machine. With five parallel workflows, "what did this branch cost" is unanswerable.
3. **Fan-out is cheap, fan-in is unbuilt.** Launching N workflows is one click. Reconciling N diffs is
   the actual bottleneck, and `WorkflowManager` shows registry state (parked, promoted) rather than
   _review_ state (changed files, ahead of base).

Plus one live hazard, §7.

## 2. What already exists — do not rebuild it

The working tree already contains a partial version of this. Read it before writing anything.

| Piece                                                | Where                                                          | State                                             |
| ---------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| `SessionStatus = 'busy' \| 'attention' \| 'idle'`    | `src/renderer/src/App.tsx:33`                                  | done                                              |
| Per-session status map + `handleSessionStatus`       | `App.tsx:96`, `App.tsx:522`                                    | done                                              |
| Status keyed by **normalized directory**             | `App.tsx:252` (`sessionDirStatuses`)                           | done — this is the join key everything below uses |
| Byte-burst status detection                          | `Terminal.tsx:150-165` (`BUSY_MS`/`IDLE_MS`/`quietUntilRef`)   | **to be superseded, not deleted**                 |
| `attention` = went idle while unfocused              | `Session.tsx:76-89`                                            | **to be superseded**                              |
| Activity string from xterm `onTitleChange` (OSC 0/2) | `Terminal.tsx:134` → `App.tsx:526`                             | done, keep                                        |
| Status dot + activity text in the manager            | `WorkflowManager.tsx:244-268` (`tab-status-*`, `wfm-activity`) | done — Phase 1 only changes what feeds it         |

**The display end is built.** Phase 1 replaces the _source_, not the UI.

## 3. Verified facts — do not re-derive

| Fact                                                                                                                                                                     | Evidence                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Worktrees cannot nest. `git worktree add` from inside a linked worktree registers a **sibling** in the main repo's `.git/worktrees/`.                                    | Scratch repo: `wt1/.git` is a file reading `gitdir: .../main/.git/worktrees/wt1`; adding from wt1 produced `worktrees/{wt1,wt2}` |
| `HEAD` and `index` are per-worktree; **`refs/stash` is shared**.                                                                                                         | `git rev-parse --git-path` from wt1 → `.../worktrees/wt1/HEAD`, `.../worktrees/wt1/index`, but `.../main/.git/refs/stash`        |
| Therefore every worktree sees one stash list. A stash pushed in wt2 appears in wt1's and main's `git stash list`.                                                        | Confirmed from all three                                                                                                         |
| snow's park machinery is **safe** against this: it matches `snow-wf:<branch>` markers and re-lists before every apply, never addressing by index.                        | `newestStash`/`stashEntries` in `git.ts`; `CLAUDE.md` § _Parked work_                                                            |
| A bare `git stash pop` run by an agent is **not** safe: it takes `stash@{0}` of the shared list, which may be another workflow's park.                                   | Follows from the two rows above. This is Phase 4.                                                                                |
| `~/.claude/projects/<dashed-cwd>/*.jsonl` — the directory name encodes the cwd.                                                                                          | `~/.claude/projects/C--Users-mason-Documents-Projects-snow/` exists on this machine                                              |
| `usage.ts` already walks that tree recursively with an `mtimeMs:size` cache and a `{ recursive: true }` watcher.                                                         | `usage.ts:168-200`, `usage.ts:225-250`                                                                                           |
| `~/.claude/settings.json` on this machine has **no** `hooks` block.                                                                                                      | Checked. Phase 1c must merge, not overwrite.                                                                                     |
| `mainWorktreeRoot` resolves via `--git-common-dir`, so promotion from inside a worktree already lands siblings in `<repo>-worktrees/`.                                   | `git.ts:524-536`                                                                                                                 |
| `withRepoLock` keys on `mainWorktreeRoot`, so snow serializes its own mutating handlers across **all** worktrees of a repo. Agent-run git in a PTY is outside that lock. | `git.ts:1037-1047`                                                                                                               |

## 4. Phase 1 — the hook status channel

**Goal:** replace inferred status with events Claude Code emits. Independently shippable. Everything
else in this document is optional relative to it.

### 4a. External contract — verify before coding

Claude Code hooks are configured in `~/.claude/settings.json` under a `hooks` key, receive a JSON
event on **stdin**, and are matched per event type. The events this plan uses:

| Event              | Meaning for snow                                                                       |
| ------------------ | -------------------------------------------------------------------------------------- |
| `SessionStart`     | an agent is alive in this cwd                                                          |
| `UserPromptSubmit` | → `busy`                                                                               |
| `PreToolUse`       | → `busy`, plus a detail string from the tool name                                      |
| `Notification`     | → **`attention`** (Claude is waiting on the user — the state the heuristic cannot see) |
| `Stop`             | → `idle`                                                                               |
| `SubagentStop`     | a dispatched agent finished; use for a subagent count                                  |
| `SessionEnd`       | drop the record                                                                        |

The stdin payload carries at least `session_id`, `cwd`, `hook_event_name`, and `transcript_path`;
`PreToolUse` adds `tool_name`/`tool_input`; `Notification` adds `message`.

> **Do not trust the field names above without checking.** This is an external contract that moves.
> Before writing `agents.ts`, confirm the event list, the exact stdin schema, and the settings.json
> shape — either with the `claude-code-guide` agent or from the current Claude Code hooks docs. If a
> field has been renamed, the plan is unchanged; only the parser is.

### 4b. `src/main/agents.ts` (new)

A fourth config-file module, built from the **same shared helpers** as `registry.ts` — read that file
first, it is the closest template (`config.ts` gives `configDir`, `writeDefaultConfig`,
`watchConfigFile`, `broadcast`, `samePath`, `expandHome`, `collapseHome`).

State directory: `~/.config/snow/agents/`, one file per agent session, named by `session_id`:

```json
{
  "sessionId": "...",
  "cwd": "/abs/path",
  "state": "busy",
  "detail": "Edit git.ts",
  "agent": "claude",
  "updated": 1740000000000
}
```

- `readAgents()` — read the directory, drop entries older than a staleness cutoff (suggest 12h) and
  entries whose file fails to parse. Never throw; a malformed file is skipped, matching how
  `snowignore.ts` degrades.
- Watch the **directory** with `fs.watch` (not `watchConfigFile`, which filters to one basename) and
  broadcast `agents:changed` on a debounce. Follow `usage.ts:230-245` for the debounce shape.
- `registerAgentHandlers()` exposing `agents:get`; register it in `index.ts` beside
  `registerUsageHandlers()`. Add `disposeAgentWatcher()` to the `will-quit` teardown.
- Preload: add an `agents` object to `src/preload/index.ts` (mirror the `usage` block at
  `preload/index.ts:277-283` — `get` plus an `onChanged` returning an unsubscribe) and add it to the
  `api` object at line 295.

**Writing** those files is the hook's job, not snow's — see 4c. Snow only reads.

### 4c. The hook script and its installer

- Ship one small Node script (e.g. `resources/hooks/snow-agent-hook.mjs`, unpacked like node-pty is
  in `electron-builder.yml`) that reads stdin, maps `hook_event_name` → state, and writes or removes
  `~/.config/snow/agents/<session_id>.json`. It must **exit 0 unconditionally and never print** — a
  hook that fails or is slow degrades the user's Claude session, and snow's status badge is not worth
  that. Wrap the whole body in try/catch.
- Installer in a new `src/main/hooks.ts`: read `~/.claude/settings.json`, **merge** a `hooks` block
  (preserving every existing key and any hooks the user already has), write it back. Report what it
  changed.

**Do not install it silently on launch.** `CLAUDE.md` § _The `snow` command_ establishes the rule:
snow never edits the user's environment behind their back (it refuses to edit `PATH` for exactly this
reason). `installCommand()` is not a precedent — that writes a file snow owns, in a directory snow
chose. `~/.claude/settings.json` is the user's.

Surface it as a CLI verb instead, alongside `snow theme`:

- `snow hooks install` / `snow hooks remove`.
- Dispatch in `runArgs` (`cli.ts:59-67`). The existing guard is
  `if (args[0] !== 'theme' || args.length < 2) return presetFor(args, cwd)`, so `snow theme` alone
  still means "open the ./theme directory". **A bare `snow hooks` cannot use that shape** — it would
  shadow a real directory named `hooks`. Requiring the second positional (`install`/`remove`) keeps
  the same two-positional guard and is the recommendation.
- The shim detaches and cannot print (`CLAUDE.md` § _The `snow` command_), so the result goes to
  `snow.log` and is broadcast for the renderer to show in the shared `FailureDialog`, exactly like
  `theme:installed` does.

### 4d. Renderer wiring

In `App.tsx`, keep `statuses` (PTY heuristic) and add `agentStatuses` (from `agents:get` +
`agents:changed`, keyed by normalized cwd). Merge when building `sessionDirStatuses`
(`App.tsx:252-264`):

**A hook-reported state always wins over the inferred one.** Fall back to the heuristic only for a
directory no agent has reported — a bottom shell, an `npm run dev` pane, a codex session with no
hooks installed. That is why `Terminal.tsx`'s detection stays: it is the floor, not the ceiling.

Tab-strip badges (`TabBar`) and the manager rows (`WorkflowManager.tsx:244`) then improve with no
changes of their own, because both already read the directory-keyed maps.

**Acceptance:** open two sessions running `claude`; ask one something that triggers a permission
prompt. Its tab shows `attention` **while the prompt is on screen**, not after it resolves. Today it
shows `busy` or `idle` depending on spinner output.

## 5. Phase 2 — attribute cost per workflow

**Goal:** answer "what has this branch cost" — impossible from the terminal title, which is why this
is worth doing even though Phase 1 gives activity text.

Depends on nothing; can land before or after Phase 1.

- `usage.ts` already parses every Claude transcript and prices it (`parseClaudeFile`,
  `anthropicCost`). The only missing step is **grouping by directory instead of summing globally**.
- Claude: derive the cwd from the containing `~/.claude/projects/<dashed-cwd>/` directory name. The
  encoding is lossy (separators and dots both become `-`), so **do not attempt to decode it**. Match
  forward instead: for each known workflow worktree path, compute its dashed form and compare.
- Codex: `~/.codex/sessions/` is date-nested and does **not** encode a cwd. Either extract it from the
  rollout payload if present, or report Codex spend as unattributed. Do not block Phase 2 on it.
- Extend `UsageResult` with `byDirectory: Record<string, number>` rather than changing
  `session`/`agents` — every existing consumer keeps working and the meter stays one number.
- Reuse the existing `fileCache` and watcher wholesale. This phase should add no new filesystem
  traversal.

**Acceptance:** two promoted workflows, each with a `claude` session; the manager shows a different
non-zero cost per row, and their sum matches the global meter.

## 6. Phase 3 — turn the manager into a review queue

**Goal:** fan-in. This is the part no agent-dispatch tool can copy, because it depends on per-worktree
indexes.

- New handler `workflow:review` (or a `detail` mode on `workflow:overview`) returning, per workflow
  entry: changed-file count, staged count, and ahead-of-base count.
- **Reuse `describeWorkflows`** (`workflow.ts:110-165`). `CLAUDE.md` § _The workflow manager_ is
  explicit that `workflow:list` and `workflow:overview` share one enrichment path so a row cannot read
  differently in two places — a second, parallel enrichment breaks that invariant.
- The numbers already exist: `GitStatus` (`git.ts:164-176`) carries `ahead` and `stageable`. Run it
  against the workflow's **worktree directory**, not the repo root.
- Cost: this adds a `git status` per registered workflow per call. Gate it — a separate handler the
  manager calls on mount and on `git:changed`, or a `detail?: boolean` parameter — so
  `WorkflowSelect`'s dropdown does not pay for it on every open.
- UI: a changed-file count per row in `WorkflowManager.tsx`, clicking through to `WorkingDiffView`
  scoped to that worktree. A workflow whose worktree does not exist must have that disabled, not
  error — `entry.worktreeExists` already tells you.

**Acceptance:** three promoted workflows with uncommitted work each show their own file count, and
each matches `git -C <worktree> status --porcelain | wc -l`.

## 7. Phase 4 — block bare `git stash` inside a workflow worktree

**Goal:** close the shared-`refs/stash` hazard from §3. Small, and it is the guarantee that justifies
the registry existing.

Depends on Phase 1's hook installer (4c) — same script, one more event.

- Add a `PreToolUse` hook matching `Bash`. Read the command from `tool_input`; if it invokes
  `git stash` **without** an explicit selector (`stash@{...}`) or a snow marker message, and the
  hook's `cwd` is inside a registered workflow worktree, **deny** it with a message naming the hazard.
- Determining "inside a registered worktree" means the hook script reading `.snowworkflows` directly —
  it is plain JSON in a known location, and the hook process cannot talk to the running app. Keep the
  parse defensive and fail **open**: an unreadable registry must let the command through, never block
  the user's git.
- Confirm the current deny mechanism before writing it — exit code 2 and a
  `hookSpecificOutput.permissionDecision` field have both been the documented path at different
  versions. Same warning as 4a.
- Blocklist, not allowlist: block bare `git stash`, `stash pop`, `stash apply`, `stash drop`,
  `stash clear`. Explicitly allow `git stash list` and `git stash show`.

**Acceptance:** in a promoted worktree, `git stash pop` typed into a Claude session is refused with an
explanatory message; `git stash list` works; the same command in a non-workflow directory works.

## 8. Order, and what is independently shippable

1. **Phase 1** (4a → 4b → 4c → 4d). Highest leverage; supersedes code currently being written.
2. **Phase 4** — small, and reuses 4c's installer. Do it while the hook script is fresh.
3. **Phase 3** — the differentiated feature. Independent of 1 and 4.
4. **Phase 2** — nice-to-have; independent of everything.

Each phase is a shippable commit. Do not batch them.

## 9. Conventions and closing steps

- `CLAUDE.md` § _Conventions_ governs: **no comments**, no vertical alignment padding, new privileged
  capability = `ipcMain` handler + preload wrapper, never direct Node in the renderer.
- The existing block comments in `workflow.ts` and `snowignore.ts` explain _why_ a non-obvious choice
  was made. Match that bar — explain a decision, never narrate the code.
- Run `npm run typecheck` and `npm run lint` before calling a phase done. There is no test runner.
- **Update `CLAUDE.md`.** This repo documents every subsystem's rationale there, and a new config file
  plus a new CLI verb plus a new IPC channel family is exactly what it covers. Add an _Agent status_
  subsection under **Agents (Claude and Codex)**, extend § _The `snow` command_ with `snow hooks`, and
  note the shared-`refs/stash` fact under § _Workflows_.

## 10. Confirmed non-issues — do not "fix" these

- **Nested worktrees.** Not a thing; `mainWorktreeRoot` already flattens. Do not add nesting support.
- **snow's park machinery vs. the shared stash.** Already safe (marker-keyed, re-listed before apply).
  Phase 4 protects _agents_, not snow.
- **`withRepoLock` being repo-wide across worktrees.** Correct as designed. It serializes snow's own
  handlers; it was never intended to constrain agent-run git in a PTY.
- **The PTY byte heuristic.** Keep it as the fallback for panes no hook reports. Deleting it regresses
  every non-Claude pane to no status at all.

## 11. Open questions for the implementer

- Should `snow hooks` be offered proactively (a one-time home-page prompt) rather than only as a CLI
  verb? The §4c rule forbids silent installation; it does not forbid _asking_. Not decided here.
- Should a workflow record gain a `prompt` field so "Launch all" starts each branch on its own task?
  Cheap (`startupCommand` already does the mechanical part) but expands `.snowworkflows`' shape.
  Deliberately out of scope; revisit after Phase 3 shows whether fan-in keeps up with fan-out.
