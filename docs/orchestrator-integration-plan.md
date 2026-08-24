# Making snow addressable by an agent orchestrator — implementation plan

Self-contained. Read this plus `CLAUDE.md` (sections **Agents (Claude and Codex)**, **Workspaces
(workflow internals)**, **The `snow` command**, **Session tabs**) and you have everything needed to
implement without prior conversation.

Companion to `docs/agent-integration-plan.md`, which built the _observation_ half (the hook status
channel, cost attribution, the shared-stash guard). That half shipped. This document is about the
half it deliberately left out: snow can be **observed** by an orchestrator but cannot be **addressed**
by one, and the fan-in surface it opened is still one badge deep.

All `file:line` references were checked against the working tree at `36ac508` (v1.4.1) **with
uncommitted changes present** — `WorkflowManager.tsx`, `workflowText.ts`, `hooks.ts`, and `main.css`
are mid-flight. Re-check line numbers before trusting them; do not re-derive the §3 facts.

---

## 1. The problem

snow's stated position is the human's review console for parallel work — it observes agents and
refuses to dispatch them. That refusal is correct and this plan does not touch it. But "does not
dispatch" has been implemented as "has no machine interface at all", and those are different things.
Three gaps follow:

1. **The integration is one-directional.** A dispatcher can write status _in_ (drop a JSON record in
   `~/.config/snow/agents/`) and read the registry _out_ (`.snowworkflows` is plain JSON in a known
   location — the hook itself reads it). It cannot ask snow to _do_ anything. `runArgs` dispatches
   exactly two verbs, `theme` and `hooks` (`cli.ts:53,61`); every `workflow:*` mutation is an
   `ipcMain.handle` reachable only from the renderer. So an orchestrator fanning out to five branches
   must create the worktrees itself, and snow learns about them only when a human registers each one
   by hand in the UI — at which point the fleet view it was supposed to provide is a manual data-entry
   chore.

2. **The observation contract has an unstated heartbeat requirement.** `readAgents()` deletes any
   record older than 30 minutes for `busy`/`idle` (`agents.ts:113`). That is safe for Claude Code,
   whose every tool call rewrites the file — the design comment says so. It is _not_ safe for the
   third-party writers `CLAUDE.md` explicitly invites: a dispatcher that writes once at task start and
   once at completion has its record reaped mid-task, and the workspace goes dark on the very screen
   the contract exists to populate. There is also no `version` field, so a writer has no way to know
   which schema snow is reading.

3. **Fan-in is diagnosed but not built.** "Fan-out is one click; fan-in is the bottleneck" is the
   correct thesis and it is what separates snow from a worktree launcher. The current surface is a
   `3 ~ 1 + ↑2` badge and a button that opens one diff. `inboxSignal` (`workflowText.ts:98`) tiers the
   rows correctly — that is the right start — but nothing acts on the ordering it produces.

A fourth, smaller: **the fleet view cannot say how it knows.** A hook-reported `busy` and a
byte-burst-inferred `busy` render identically (`App.tsx:294-315`), so a workspace whose hooks were
never installed looks exactly like a healthy quiet one.

---

## 2. What already exists — do not rebuild it

| Piece                                                      | Where                                  | State                                               |
| ---------------------------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| Agent record schema + directory watcher                    | `agents.ts:9-154`                      | done — Phase B extends the schema, does not replace |
| Per-state staleness (`busy`/`idle` 30 m, `attention` 12 h) | `agents.ts:31`                         | done — Phase B makes it writer-controllable         |
| `liveAgentsIn` / `agentSummary`                            | `useAgents.ts:36,60`                   | done                                                |
| Registry read/write, `~`-collapsed, watcher-broadcast      | `registry.ts:47,96,114`                | done — Phase A calls these directly                 |
| `workflow:create` / `promote` / `demote` / `prune`         | `workflow.ts:341,398,484,596`          | done — Phase A extracts the bodies, does not fork   |
| Non-IPC path into a config mutation (the precedent)        | `snowconfig.ts:361` (`presetForDir`)   | done — copy this shape                              |
| Non-IPC path into theme activation (second precedent)      | `snowconfig.ts:347` (`setActiveTheme`) | done                                                |
| Verb dispatch that will not shadow a real directory        | `cli.ts:49-70` (`runArgs`)             | done — Phase A adds one branch                      |
| Headless-node shim pattern (`ELECTRON_RUN_AS_NODE`)        | `hooks.ts:98-124` (`shim()`)           | done — Phase A reuses this exact trick              |
| Cross-process stash lock                                   | `stashLock.ts:113`                     | done — a CLI process can take it                    |
| Review counts per workspace                                | `workflow.ts:44,168` (`reviewOf`)      | done — Phase C returns paths it already has in hand |
| Inbox tiering + `needsOperator`                            | `workflowText.ts:98,121`               | done — Phase C consumes the ordering                |

**The registry watcher is the integration bus and it already works.** `initRegistry()`
(`registry.ts:136`) `fs.watch`es `.snowworkflows` and broadcasts `workflow:changed`; `addRecord` and
`setWorktree` only write and let the watcher notify. So **any** process that writes that file — a
running snow, a CLI invocation, an orchestrator — updates every open window with no IPC. Phase A is
mostly discovering that this already exists rather than building anything.

---

## 3. Verified facts — do not re-derive

| Fact                                                                                                                                                           | Evidence                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **The `snow` shim detaches and therefore cannot print.** Windows `start "" …`; POSIX `nohup … &`. Both discard stdout and return immediately.                  | `cli.ts:107-110` (`shim()`)                                                         |
| A packaged Electron app on Windows has no console attached even without the detach.                                                                            | `CLAUDE.md` § _The `snow` command_                                                  |
| **`--help` / `--version` do not exist.** `CLAUDE.md` claims they "print and leave"; `grep -rn -- "--help\|--version" src/main/` returns nothing.               | Verified on this tree. Correct `CLAUDE.md` when Phase A lands.                      |
| The single-instance lock is taken only when packaged, and returning `false` from `startCli()` is what makes `index.ts:21` call `app.exit(0)`.                  | `cli.ts:83`, `index.ts:21`                                                          |
| `second-instance` hands the running app an argv but has **no channel back**; the second process has already lost the lock and exits.                           | `cli.ts:86-90`. This is why a mutating verb must not route through the running app. |
| `git worktree add` and a `.snowworkflows` write are both things a standalone process can do. Neither needs the running app.                                    | `workflow.ts:398` is ordinary `simple-git` + `registry.ts` calls                    |
| `withRepoLock` is a module-level `Map` in main — **in-process only**. It never constrained anything outside the running app, including agent-run git in a PTY. | `git.ts:1074`, and `docs/agent-integration-plan.md` §10 says so explicitly          |
| `withSharedStashLock` **is** cross-process (a `mkdir` lock in `--git-common-dir`), and the hook already takes it from a separate node process.                 | `stashLock.ts:113`, `snow-agent-hook.mjs` `acquireSharedStashLock`                  |
| `reviewOf` calls `gitFor(directory).status()` and then throws the paths away, keeping only `.length`.                                                          | `workflow.ts:168-176`                                                               |
| A record is skipped, never deleted, when malformed; only staleness deletes.                                                                                    | `agents.ts:107-116`                                                                 |

---

## 4. Phase A — `snow workspace`, a headless machine surface

**Goal:** an orchestrator can create, list, and tear down workspaces without a human touching the UI.
Independently shippable; nothing else here depends on it.

### 4a. The detach problem, and why the answer is a second shim branch

The blocker is not argument parsing — it is that `snow`'s shim throws stdout away (§3), so
`snow workspace list --json` could never answer. Three options were considered:

- **Route through the running app** via `second-instance`. Rejected: no channel back (§3), so the CLI
  would have to write a request file and poll for a response file. That is a worse IPC than the one
  we already have and it makes the CLI useless when snow is not running.
- **A response-file protocol.** Same objection, plus it invents a second registry.
- **Run the verb headlessly, in the CLI process, and let the registry watcher notify the app.**
  Chosen. It works whether or not snow is running, it exits with a real code, and the running window
  updates through the mechanism that already exists (§2).

The mechanism for the third is **already in this repo**: `hooks.ts:98-124` writes a shim that prefers
`node` on `PATH` and falls back to `ELECTRON_RUN_AS_NODE=1 "<binary>"`. Apply the same trick to
`snow`'s own shim, branching on the verb so the GUI path is untouched:

```
@echo off
if /I "%~1"=="workspace" (
  <headless invocation> %*
  exit /b %errorlevel%
)
start "" <launcher> %*
```

POSIX equivalent: `exec` the headless invocation instead of `nohup … &` when `$1` is `workspace`.
Keep the `where node` / `command -v node` preference — booting Chromium to answer a list query costs
~60 ms more and buys nothing.

**This means the workspace verbs must not import Electron.** `workflow.ts` imports `ipcMain`;
`registry.ts` and `git.ts` do not import Electron directly but reach it through `config.ts`'s
`broadcast`. Phase A therefore needs a small extraction, §4c.

### 4b. Surface

Every verb takes `--json` and prints one object; without it, human-readable lines. Exit non-zero on
failure. `--repo <path>` defaults to `process.cwd()`.

| Command                                     | Does                                                              | Prints                                             |
| ------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `snow workspace list [--repo P] [--json]`   | `workflow:overview`'s data, optionally `--detail`                 | repos → workspaces, with `review` when `--detail`  |
| `snow workspace create <branch> [--repo P]` | `workflow:create` — branch cut straight into a worktree           | `{ branch, worktree }` — **the path to launch in** |
| `snow workspace open <branch> [--repo P]`   | `workflow:promote` for a parked branch; no-op if already promoted | `{ branch, worktree }`                             |
| `snow workspace close <branch> [--repo P]`  | `workflow:demote` — park and remove the worktree                  | `{ branch, parked }`                               |
| `snow workspace register [<branch>]`        | `workflow:register`                                               | `{ branch }`                                       |
| `snow workspace remove <branch>`            | `workflow:unregister` — registry only, parked work stays          | `{ branch }`                                       |

`create` returning `worktree` is the load-bearing one: it is the whole reason an orchestrator calls
this at all. It plans a task, asks snow for an isolated directory, and launches its own agent there.
Snow never learns what the task is, never chooses the agent, never decides what runs next.

`close` **must not** kill PTYs from a CLI process. `workflow:demote`'s `closePtysInDirectory` only
knows about PTYs the running app owns (`pty.ts:66`), and a headless invocation owns none. Attempt the
removal; on failure, report that terminals are holding the directory and exit non-zero rather than
pretending. The running app's demote path is unchanged.

### 4c. The extraction

Each `workflow:*` handler is currently an arrow function inside `registerWorkflowHandlers()`
(`workflow.ts:266-620`). Lift each body to a named exported function taking plain arguments, and let
the `ipcMain.handle` call be a one-line wrapper. This is the same shape `presetForDir`
(`snowconfig.ts:361`) and `setActiveTheme` (`snowconfig.ts:347`) already have — a function main calls
directly, with the IPC handler as one of two callers, not the only one.

```
export async function createWorkspace(cwd: string | undefined, branch: string): Promise<WorkflowResult>
ipcMain.handle('workflow:create', (_e, cwd, branch) => createWorkspace(cwd, branch))
```

Do **not** fork the logic. A second implementation of promote is exactly the drift `describeWorkflows`
exists to prevent (`CLAUDE.md` § _The workflow manager_).

`config.ts`'s `broadcast` reaches `BrowserWindow`. In a headless process there are no windows, so it
must degrade to a no-op rather than throw. Guard it at the source; do not make every caller check.

### 4d. Concurrency

Two processes can now mutate one repo. Three cases, in decreasing order of risk:

- **Stash operations** (`demote`'s park). Already covered — `withSharedStashLock` is a cross-process
  `mkdir` lock and the hook already takes it from a separate process (§3). Nothing to do.
- **`.snowworkflows` writes.** `addRecord`/`removeRecord` re-read before writing and bail on a read
  error (`registry.ts:96`), so a corrupt file is never replaced. But two processes can still
  read-modify-write over each other. Give the registry the same `mkdir` lock discipline
  `stashLock.ts` uses, keyed on the config directory. Cheap and it removes the last lost-update path.
- **`git worktree add`/`remove`.** Git takes its own locks and fails loudly. Leave it.

`withRepoLock` stays in-process and unchanged. It was never a cross-process guarantee (§3) and
pretending otherwise would be worse than the current honest scoping.

---

## 5. Phase B — make the observation contract keepable

**Goal:** a third-party writer can hold a record open for a long task and know what schema it is
writing. Pure schema and expiry work; no UI.

### 5a. Writer-controlled expiry

Add optional `ttlMs` to the record. `readAgents()` expires against `record.ttlMs ?? staleMs[state]`,
clamped to a ceiling (24 h) so a bad writer cannot pin a record forever. The hook keeps writing no
`ttlMs` and keeps today's behaviour exactly.

This is the minimum that makes the invitation in `CLAUDE.md` ("Other dispatchers may write the same
record") truthful. Today that invitation comes with an undocumented "…and you must rewrite it every
30 minutes or it vanishes", which is a requirement a writer cannot discover except by watching its
own rows disappear.

Document the alternative in the same breath: a writer that _can_ heartbeat should, because a TTL is a
promise about the future and a heartbeat is evidence about the present. `attention` keeps its 12 h
default for the reason already documented — nothing refreshes it because nothing happens until a human
acts.

### 5b. `version`

Add `version: 1`. `parseSession` accepts a missing version as 1 (every record written before this
change), and skips — does not delete — a record whose version it does not know. That matches how a
malformed record is already treated (`agents.ts:107`) and how `snowignore.ts` degrades.

### 5c. Optional dispatcher fields, rendered only when present

`CLAUDE.md` records that `parentSessionId`, `task`, and `result` were **removed** because Claude
Code's payloads carry none of them and all three rendered into a permanently blank tooltip. That
reasoning is correct and must not be reversed. The distinction that makes it safe to reopen a narrow
version of it:

> A field a hook _cannot_ populate and the schema _declares_ is a lie. A field an orchestrator _can_
> populate, that is optional, and that the UI renders **only when non-empty**, is not.

So: allow optional `task` (short label) and `taskUrl`. The hook never writes them. `WorkflowManager`
shows the label in the row's title only when present, and `agentSummary` ignores it entirely. If no
writer ever sets them, nothing on screen changes — which is the test the removed fields failed.

Nothing else from the removed set comes back. `parentSessionId` implies a dispatch tree snow would be
tempted to render and cannot verify; `result` implies snow knows why a session stopped, which is the
orchestrator's knowledge, not a hook's.

### 5d. Provenance

Add `source: 'hook' | 'inferred'` alongside the merged status in `App.tsx:294-315` (the merge already
knows which branch it took — `agent?.state ?? statuses[tab.id]`). Surface it as a modifier class on
the dot and one line in the tooltip. This is what lets a fleet view be _trusted_ rather than merely
read: a workspace with no hooks installed currently looks identical to a healthy quiet one, and the
person relying on "nothing needs me" has no way to tell those apart.

### 5e. Write the contract down

`docs/agent-record-contract.md`: the field table, the TTL rule, the version rule, the atomic
write-then-rename requirement (`snow-agent-hook.mjs` `writeRecord`), the filename sanitisation rule,
and an explicit **non**-contract section — snow reads this directory and groups it for a human; it
never creates tasks, never selects a next agent, never treats a stopped session as a completed one.
Link it from `CLAUDE.md`. A contract that lives only as prose inside a hook implementation is one
nobody outside this repo can write against.

---

## 6. Phase C — fan-in

**Goal:** act on the ordering `inboxSignal` already computes. This is the highest-leverage work in
the document and the least like anything else in the space; Phases A and B are plumbing by comparison.

### 6a. Return the paths `reviewOf` already has

`reviewOf` calls `status()` and keeps only counts (§3). Add `paths: string[]` (capped, ~50, with a
`truncated` flag). Costs zero additional git processes — the data is in hand and discarded.

That one field unlocks the thing that actually makes landing order matter:

### 6b. Collision detection

With paths per workspace, the manager can compute which files more than one workspace has touched and
render, per row, `2 files also changed in feature-b`. Fanning five agents at one codebase and
discovering the overlap at merge time is the characteristic failure of this whole workflow, and it is
computable from data already gathered.

Cheap first version: intersect within a repo, show a count and a tooltip listing the paths and the
other branches. No merge simulation — that is a different and much larger feature, and the count is
most of the value.

### 6c. Review queue

A `Review next` action that walks tier-3+ rows in `inboxSignal` order, opening each workspace's
`WorkingDiffView` in turn through the existing `onOpenDiff` (`WorkflowManager.tsx`), with
`next`/`previous` in the diff pane's tools row so a reviewer never returns to the manager between
branches. State is a cursor over the sorted rows, held in the manager; the diff view already takes a
`cwd` + `branch` and already dedupes tabs by cwd (`App.tsx:504`).

This is the smallest change that converts the manager from a _dashboard_ into a _queue_, which is the
distinction the thesis rests on. Ship it before 6b if time is short — collision counts make review
better, but the queue is what makes fan-in a workflow instead of a list.

---

## 7. Non-goals — do not build these

- **Task planning, agent selection, retry policy, task graphs.** Not snow's. The refusal is the
  product; see §5c for the one narrow exception and why it is not a wedge.
- **Snow spawning agents.** `startupCommand` already runs whatever the preset says. Snow launching
  `claude` with a task prompt would make it the dispatcher.
- **A `prompt` field on a workspace record.** Deferred in `docs/agent-integration-plan.md` §11 and
  still deferred; §5c's `task` is a _label for display_, not an instruction snow executes. Keep that
  line bright.
- **Cross-process `withRepoLock`.** §3, §4d.
- **Merge conflict prediction.** §6b's intersection is a count, not a simulation.
- **A `snow agents` CLI verb.** The record directory is the contract (§5e); a CLI over it would be a
  second interface to the same files and would drift.

---

## 8. Sequencing

Phases are independent and each ships alone. Recommended order:

1. **B (5a, 5b, 5e)** first — smallest, unblocks any third party, and makes A's audience real.
2. **A** next — the extraction in §4c is the largest mechanical change and everything else is easier
   once workspace operations are callable outside Electron.
3. **C (6a, 6c)** — the queue.
4. **B (5c, 5d)** and **C (6b)** — refinements, in any order.

---

## 9. Conventions

- `CLAUDE.md` says "Do not write comments." The agent and workflow modules do not follow that; they
  carry block comments explaining _why_ a non-obvious choice was made, and they are better for it.
  Match the code you are editing: explain a decision, never narrate the code. (Worth resolving that
  contradiction in `CLAUDE.md` itself — the convention as written no longer describes the codebase.)
- New privileged capability → `ipcMain` handler in main, wrapper in preload's `api`, never direct Node
  in the renderer. Phase A adds a _non_-IPC caller, not a new privilege.
- `npm run typecheck` and `npm run lint` before calling a phase done. There is no test runner; the
  hook's pure functions (`takesSharedStash`, `ownedWorkspace`, `stateFor`) are extractable and worth a
  scratch harness when touched.
- **Update `CLAUDE.md`.** A new CLI verb family, a schema version, and a changed expiry rule are all
  things it documents. Also correct the `--help`/`--version` claim (§3).

---

## 10. Open questions for the implementer

- Should `snow workspace create` accept `--from <ref>`? `workflow:create` currently branches from
  `<remote>/<default>` with `--no-track` (`workflow.ts:398`), which is right for the fan-out case. An
  orchestrator stacking dependent tasks would want a base. Cheap, but it widens what "workspace" means
  from "parallel to main" to "arbitrary point in the graph" — decide deliberately.
- Should `list --json` include agent records (joined by directory), or stay registry+git only and let
  the caller read `~/.config/snow/agents/` itself? Joining is convenient; keeping them separate keeps
  the record directory the single contract (§5e). Leaning separate.
- Does `close` need a `--force` that reports which PIDs hold the directory, given it cannot close
  PTYs (§4b)? Probably, on Windows.
- `hooks.ts` currently registers `StopFailure` in `hookEvents`, but `snow-agent-hook.mjs`'s
  `stateByEvent` has no entry for it, so the event is received and ignored. Decide what it means
  (`idle`? `attention`?) or drop it — an event registered and unmapped is a silent no-op.
