# Worktree-backed workflows — implementation plan

Self-contained. Read this plus `CLAUDE.md` (sections **Workflows**, **`.snowconfig`**,
**Multi-repo git view**) and you have everything needed to implement without prior conversation.

Every git behavior asserted here was verified in a scratch repo on this machine (Windows, Git Bash).
Every `file:line` was checked against the tree at commit `295a193` (v1.3.2). Do not re-derive them;
do re-check line numbers if the files have moved since.

---

## 1. The problem

snow's workflow model parks uncommitted work in the stash (`snow-wf:<branch>` marker) when leaving a
registered branch and restores it on return. That model **serializes branches**: one working
directory means one active branch, so two Claude agents cannot work on two branches of the same repo
at once. That is the app's core use case, so the model blocks its own premise.

`git worktree` is the missing primitive: one repository, several working directories, each with a
different branch checked out, all live simultaneously. Shared object store, shared refs, shared
stash; per-worktree `HEAD`, index, and files.

## 2. The design decision

**Do not add a second concept or a second dropdown.** A workflow remains "a branch I opted into". A
worktree is a second *storage mode* for the same thing:

| | park mode | worktree mode |
|---|---|---|
| branch checked out in | this directory, on switch | its own directory, always |
| uncommitted work lives | the stash, `snow-wf:<branch>` | on disk, live |
| parallel agents | no | yes |
| clicking its row | switches this repo | opens/focuses its session tab |

One registry, one list in `WorkflowSelect`, one verb ("take me to this workflow") realized two ways.
This survived independent review; do not restructure it into two pickers without new evidence.

## 3. Verified git facts — do not re-derive

| Fact | Status |
|---|---|
| Linked worktree `.git` is a **file** containing `gitdir: <main>/.git/worktrees/<name>` | verified |
| `rev-parse --show-toplevel` inside a linked worktree returns the **worktree's own** path | verified |
| `rev-parse --git-dir` inside a linked worktree returns `<main>/.git/worktrees/<name>` (absolute) | verified |
| `rev-parse --git-common-dir` returns **relative** (`.git`) in the main worktree, **absolute** in a linked one | verified — this is a trap |
| Per-worktree git dir holds `HEAD ORIG_HEAD commondir gitdir index logs refs`; its `refs/` is **empty (0 files)** | verified |
| Branch refs, `packed-refs`, `refs/stash`, `logs/refs/stash` live in the **common** dir | verified |
| A branch cannot be checked out in two worktrees: `fatal: 'x' is already used by worktree at ...` | verified |
| `git stash list` is identical from every worktree; a stash pushed in one pops cleanly in another | verified — this is what makes promotion work |
| `fetch <remote> <b>:<b>` refuses when `<b>` is checked out anywhere: `fatal: refusing to fetch into branch 'refs/heads/master' checked out at ...` | verified |
| `worktree remove` refuses on a dirty tree (`contains modified or untracked files, use --force`) | verified |
| `stash push -u` does **not** include `.gitignore`d paths, so it does not make a tree removable | git docs + CLAUDE.md |
| A hand-deleted worktree dir leaves the branch **un-checkoutable** until `git worktree prune`; the entry shows as `prunable` in `worktree list --porcelain` | verified |
| `worktree list --porcelain` emits forward-slashed absolute paths on Windows | verified |

`worktree list --porcelain` format:

```
worktree C:/path/to/main
HEAD dede8ace6b23b9dfaa42e815f9d1cd0299827eaa
branch refs/heads/master

worktree C:/path/to/linked
HEAD dede8ace6b23b9dfaa42e815f9d1cd0299827eaa
branch refs/heads/feat
```

## 4. Stage 0 — worktree-correctness fixes (no UI)

**These four are correct today, with zero worktrees anywhere, and load-bearing later.** Land them
first as their own PR. Until they exist, the registry change in Stage 1 is not additive.

### 0.1 `mainWorktreeRoot()` and re-pointed registry callers — BLOCKER

The registry is keyed by repo path, and every caller resolves it with `worktreeRoot()`
(`src/main/git.ts:444`, i.e. `rev-parse --show-toplevel`). Inside a linked worktree that returns the
*worktree's* path, so `workflow:list` finds **zero records** and `WorkflowSelect` renders "No
workflows registered" in exactly the tab this feature exists to create. Worse, its Register button
would call `addRecord(<worktree root>, branch)` and mint a **second record for the same branch** that
`validate()`'s dedupe cannot detect, because dedupe keys on `(repo, branch)` and the repo paths
differ.

Add to `git.ts`:

```ts
export async function mainWorktreeRoot(cwd?: string): Promise<string | null>
```

Implement as `rev-parse --git-common-dir` → resolve against `cwd` when relative → `path.dirname()`.
**`gitDir()` at `git.ts:438` already guards the relative/absolute split — copy that guard.** The
dirname of the common dir is the main worktree root in both the main and linked cases.

Re-point these to it:

- `src/main/workflow.ts:47` (`workflow:list`)
- `src/main/workflow.ts:80` (`workflow:register`)
- `src/main/workflow.ts:105` (`workflow:unregister`)
- `src/main/workflow.ts:131` (`workflow:create`)
- `src/main/git.ts:724` (`registeredBranches`)

Leave every other `worktreeRoot()` call alone — they are correct (diff, status, commit, discovery all
want the local worktree).

*Acceptance:* register a workflow in a repo, `git worktree add` a second dir by hand, open it as a
preset — `WorkflowSelect` lists the same workflows there.

### 0.2 Re-key `withRepoLock` on the common dir — SIGNIFICANT

`git.ts:830` keys the lock on `(await worktreeRoot(cwd)) ?? cwd ?? os.homedir()`. Two worktrees of one
repo therefore get **two different keys**, and snow's mutual exclusion evaporates the day worktrees
ship. Because the stash is shared, concurrent stash pushes shift `stash@{n}` selectors under a
concurrent pop — snow re-lists selectors before every apply (`restoreOnEnter` lists at `git.ts:759`,
pops at `:764`; `rollbackPark` at `:792`), but re-listing fixes *stale caches*, not *interleaving*:
the list→pop window is not atomic. Failure mode is silent — you pop another agent's parked work into
your tree.

Change the key to `mainWorktreeRoot(cwd) ?? worktreeRoot(cwd) ?? cwd ?? os.homedir()` so a repo and
all its worktrees share one lock. This also serializes promotion/demotion against ordinary park
switches for free.

### 0.3 `git:watch` must watch the common dir too — SIGNIFICANT

`gitDir()` (`git.ts:435`) returns the per-worktree dir, whose `refs/` is **empty**, so
`watch(path.join(dir, 'refs'), true, ...)` at `git.ts:1925` silently succeeds and watches nothing. No
error, no fallback.

Lost inside a worktree: `refs/heads/*`, `refs/remotes/*` (ahead/behind stops updating after a fetch),
`packed-refs`, and `refs/stash` + `logs/refs/stash`. That last one makes CLAUDE.md's claim — *"No git
watcher is added: stash writes touch `.git/refs/stash` … already covered by `git:watch`"* — **false in
a worktree**, so parked badges stop live-updating there.

In the `git:watch` handler (`git.ts:1863`), resolve the common dir alongside `dir` and, when it
differs, additionally watch `<common>/refs` and `<common>/logs` recursively with the same
`notLockFile` filter. Keep the existing per-worktree watches — `HEAD`, `index`, `ORIG_HEAD`, and
`logs/HEAD` are per-worktree and do fire.

Two consequences to accept and document: every worktree tab now fires `git:changed` for ref activity
in *every other* worktree of the repo (correct, but noisier), and N worktree tabs means N watchers on
the same common dir, since `watcherKey` is `(wcId, cwd)` (`git.ts:996`) and refcounting only collapses
identical cwds.

### 0.4 `git:syncDefault`'s refspec — SIGNIFICANT

`git.ts:1277` runs `fetch <remote> <branch>:<branch>`, which git refuses when `<branch>` is checked
out in **any** worktree. From a worktree tab the sync-default button therefore fails whenever the
default branch is checked out in the main repo — i.e. essentially always. It also breaks from the
main repo if the user promotes the default branch itself to a worktree.

Detect that the default branch is checked out elsewhere (Stage 1.6's map, or just catch the error) and
fall back to the fetch-then-`merge --ff-only` path the handler already uses at `git.ts:1273-1274` when
on the default branch. `git:updateFromDefault` (`:1328`) and `git:sync` use plain fetch/push/pull and
are **unaffected** — do not touch them.

---

## 5. Stage 1 — registry supports the mode

### 1.1 The record

```ts
export interface WorkflowRecord {
  repo: string        // always the MAIN worktree root (Stage 0.1 makes this resolvable)
  branch: string
  worktree?: string   // present = worktree mode; absolute path, collapseHome'd on write
}
```

### 1.2 `validate()` drops unknown fields — BLOCKER

`src/main/registry.ts:39` builds a fresh literal `result.push({ repo, branch })`, so **every read
strips `worktree`**. Add the field there, validating it as an optional non-empty string. The dedupe at
`:37` is fine as-is — `(repo, branch)` stays unique across modes.

### 1.3 `addRecord` cannot promote — BLOCKER

`registry.ts:77` early-returns `null` when the record exists, and `:78` writes a fixed
`{ repo, branch }` literal. Promotion mutates an existing record, so `addRecord` is unusable for it.
Add:

```ts
export function setWorktree(repo: string, branch: string, worktree: string | null): string | null
```

which re-reads, bails on read error (same contract as `addRecord`/`removeRecord` — a corrupted file is
never silently replaced), and sets or clears the field.

**Also make `addRecord` explicitly clear `worktree`.** Live bug otherwise: `workflow:create` calls
`addRecord` after checkout (`workflow.ts:150`); if a stale worktree-mode record for a recycled branch
name survives, `addRecord` no-ops and the fresh **park-mode** branch permanently inherits
`worktree: <dead path>`.

### 1.4 Two accessors, unmistakably named — BLOCKER

`registeredFor` returns `string[]` (`registry.ts:69` — it `.map(r => r.branch)`), threaded as
`Departure.registered: string[]` (`git.ts:673`) through `parkPlan` (`:732`) into
`restoreOnEnter(cwd, branch, registered)` (`:753`). You cannot "skip records with `worktree` set"
while filtering on branch names, so signatures must change.

Do **not** filter inside the existing `registeredFor` — `workflow:list` (`workflow.ts:47`) uses the
same accessor and must *show* worktree workflows. Split into two, named so they cannot be confused,
since the park gate hangs off one of them:

- `parkableBranches(repo)` — park-mode records only (`!r.worktree`). Consumed by
  `registeredBranches` (`git.ts:724`) → `Departure.registered` → the park gate.
- `recordsFor(repo)` — all records with their mode. Consumed by `workflow:list`.

### 1.5 `restoreOnEnter` skip

With 1.4 done, `restoreOnEnter` (`git.ts:753`) inherits the right list and needs no change: a
worktree-mode branch is simply absent from `registered`, so `:757` returns `null` and any stale
`snow-wf:` stash is left alone. That is consistent with snow's existing rule that it never drops a
stash.

`parkOnLeave` needs no guard at all: git forbids a worktree-mode branch from being the main
directory's current branch, so the gate can never fire for one. **Git enforces the exclusivity;
`registry.ts` does not have to.**

### 1.6 Branch → directory map

Add to `git.ts`, parsing `worktree list --porcelain`:

```ts
export async function worktreeMap(cwd?: string): Promise<Map<string, string>>  // branch -> dir
```

Strip the `refs/heads/` prefix. **Skip entries marked `prunable`** or you will disable BranchSelect
rows for worktrees that no longer exist. Compare paths through `samePath`/`collapseHome`
(`src/main/config.ts:22-35`) — never raw — since porcelain emits forward slashes on Windows.

*Acceptance for Stage 1:* hand-edit a `worktree` field into `.snowworkflows`; it survives a read/write
round-trip, and that branch no longer parks or restores.

---

## 6. Stage 2 — guards (prerequisite of promotion, not a follow-up)

`switchBranch` (`git.ts:841`) calls `parkOnLeave` at `:847` and only attempts the checkout at `:855`.
Target a worktree-mode branch and you get: stash push → checkout fails → `rollbackPark` (`:857`). Net
zero when everything works, but it is a pointless write cycle on the user's stash, and `rollbackPark`
has its own failure mode that emits the "could not be restored automatically" stranded-work message.

- **`switchBranch` pre-refusal:** before `parkOnLeave`, consult `worktreeMap` and return a clean
  failure when the target is checked out elsewhere, naming the directory. Covers `git:checkout`
  (`git.ts:1195`), `git:checkoutRemote` (`:1205`), and `workflow:create` (`workflow.ts:125`), which all
  route through it.
- **`BranchSelect` disabling:** surface the map (extend `git:branches` at `git.ts:1165`) and render
  those rows disabled with a hint pointing at the worktree's session, rather than letting the checkout
  fail into a `FailureDialog`.

Both must land **before** promotion exists, because promotion is what creates the condition.

---

## 7. Stage 3 — `WorkflowSelect`: one list, two verbs

`src/renderer/src/components/WorkflowSelect.tsx`. `workflow:list` gains `worktree?: string` per entry.

```
┌──────────────────────────────────┐
│ Search workflows…                │
├──────────────────────────────────┤
│ ▸ auth-refactor        ⊞ live   ✕│  worktree mode → open/focus its tab
│   payment-retry        ● 3      ✕│  park mode → workflow:switch (today's behavior)
│   flaky-test-fix       ● 1      ✕│
│ ✓ master                        ✕│
├──────────────────────────────────┤
│ Register master                  │
│ [ New workflow…              ] + │
│ Branches from origin/master      │
└──────────────────────────────────┘
```

- Keep the `● n` parked badge exactly as-is (`WorkflowSelect.tsx:16-28`, `:196`).
- Add `⊞ live` for worktree mode. The visual weight difference is the point: parked is inert,
  worktree is running.
- `▸` leading glyph on worktree rows (go there) vs. the existing blank/`✓` gutter (become that).
- Title text must telegraph the verb: `Open auth-refactor's session` vs
  `Switch to payment-retry (restores 3 parked files)`.
- `switchTo` (`WorkflowSelect.tsx:100`) branches on mode. The worktree branch does **not** call
  `workflow:switch`; it asks `App` to focus-or-open a session tab at that path.

This is the honest checkpoint for the whole design. If one list with two verbs feels muddled here,
find out now — before promotion is written against it, and while splitting into two pickers is cheap.

---

## 8. Stage 4 — promotion (park → worktree)

From the row's context menu ("Run in parallel"):

1. Refuse if the branch is currently checked out in the main directory — you would pull the floor out
   from under the active tab. Refuse and say why; do not silently move someone's HEAD.
2. `git worktree add <path> <branch>`.
3. Pop its parked stash **into the new directory**: `git -C <new-worktree> stash pop <selector>`,
   re-listing the selector immediately before the pop as the existing code does. This works because
   the stash list is shared (verified); `markerPattern` (`git.ts:665`) already tolerates git's
   `On <branch>: ` prefix.
4. `setWorktree(repo, branch, path)`.
5. Open the session tab.

All of it inside `withRepoLock`, which after Stage 0.2 correctly spans the repo and its worktrees.

**Path naming — decided.** One container directory beside the repo, one child per branch:
`<parent>/<repo>-worktrees/<branch>`, with separators in the branch sanitized to `-` so the common
`feature/x` form does not nest (`myrepo-worktrees/feature-x`). Git creates the leading directory
itself, and `workflow:demote` `rmdir`s the container after the last removal — non-empty is exactly
the case where it should fail, so the error is swallowed. Grouping under one container rather than
scattering `<repo>-<branch>` siblings also keeps a `~/projects`-style pane's discovery clean:
`discoveryState` only looks one level down, so the container is a non-repo child and its worktrees
stay out of the panel until a session tab opens in one.

**Session tab wiring — do not just reuse `presetForDir`.** Its signature is
`(dir: string, startupCommand?: string)` (`snowconfig.ts:263`) with no `hidden` parameter, and the
literal it builds at `:271` cannot carry one; `snowconfig:addPreset` (`:363`) does accept `hidden`.
Two further problems if you mint a hidden preset per worktree:

- *Accumulation is visible.* Hidden presets render in the "Add split" list of **every** preset's
  right-click menu (`HomePage.tsx`, unfiltered `presets` — deliberate, since that list is the only
  place a hidden preset can be deleted). One dead row per worktree ever created, forever.
- *Command buttons regress.* A minted preset has no `commands`, and `actionRepos` adoption
  (`App.tsx:154-161`) finds the preset whose cwd is inside the repo root — the empty minted one. So
  `commandItems` (`:194`) comes back empty and `managePresetIndex` points at a throwaway that demotion
  is supposed to delete. This is the parent-folder failure CLAUDE.md already documents, reappearing by
  another route.

Prefer resolving a worktree tab's preset to the **parent repo's** preset (so its commands survive),
and treat the worktree as a cwd rather than a new preset identity. If a minted preset is unavoidable,
demotion must delete it.

*No problem with:* `paneRatios` (gated on pane count, simply won't apply) and the positional digit
keybinds (they index `visiblePresets`, which filters `hidden`, so digits don't shift).

---

## 9. Stage 5 — demotion and prune

### Demotion (worktree → park) is not the mirror of promotion

`worktree remove` refuses on a dirty tree, and `stash push -u` **skips `.gitignore`d paths**, so
`node_modules/`, `.env`, `dist/`, `out/` all remain after the park. They do **not** block the removal
— verified on git 2.50: the clean check is a plain `status --porcelain` with no `--ignored`, so after
the stash an unforced `worktree remove` succeeds and deletes the whole directory, ignored tree
included. `--force` is still worth passing, for whatever the stash could not take (a failed push, a
path git refuses to stash), but it is not what deletes `node_modules/` — removal always does.

What that costs is real and needs saying out loud, so demotion confirms first (a `DiscardDialog`-shaped
confirm — specific copy, Escape closes, no Enter-to-confirm, per the existing dialog conventions) and
names the ignored files in its button label.

Sequence: `stash push -u` with the same `snow-wf:<branch>` marker → `worktree remove` (forced, after
confirm) → `setWorktree(..., null)` → close the tab → delete the minted preset if Stage 4 made one.

### Prune

A user who `rm -rf`s a worktree gets a branch git **refuses to check out** until `worktree prune`
runs, even though the entry is `prunable`. Snow's only response otherwise is a `FailureDialog`.
Provide a prune path — offer it from the failure, or run it when `worktreeMap` sees a prunable entry
for a registered branch.

**The mirror case is worse, and it is the one demotion actually hits.** `worktree remove` deletes
`.git/worktrees/<id>` **even when it could not delete every file** — git's own comment is "there's no
going back from here" — so a `Permission denied` on one locked file (an editor, a running dev server,
`node_modules`) leaves: work parked in the stash, the tree gutted, the admin entry gone, and the
directory still on disk. Verified on git 2.50: the removal exits 255, and a retry can only ever say
`is not a working tree`.

That stranded the workflow in every direction, because all three exits read the wrong signal. The
stop button gated on `worktreeExists`, a bare `fs.access` — true, because the leftover directory is
still there — so it offered a retry that could not succeed; the prune button only appeared when that
same check was **false**; and unregister refused outright on `record.worktree` being set. So:
**`worktreeExists` is not the question — "does git still list this worktree at this path" is.**
`workflow:list` reports it as `worktreeLinked` (from the existing `worktreeMap`, which already drops
`prunable` entries, so a `rm -rf`'d worktree reads false too), demotion clears the registry itself
when the probe says git has let go, and unregister refuses only while git still lists it.

### Dead session tab

`pty:spawn` (`src/main/pty.ts`) passes `cwd` straight to `node-pty` with **no try/catch**; a
nonexistent directory throws and is caught only by the `uncaughtException` logger in
`src/main/log.ts`, so the terminal is silently dead rather than loudly broken. This hazard pre-exists
(a preset pointing at a deleted dir does the same), but this feature manufactures directories whose
removal is a normal user operation. Wrap the spawn and surface the failure in the pane.

---

## 10. Stage 6 — GitPanel grouping

Linked worktrees already appear as separate repos: `isRepoDir` does `fs.access(<child>/.git)`
(`git.ts:873`) and a worktree's `.git` is a file, so access succeeds; `worktreeRoot(child)` then
returns the worktree's own root. **But note the scope** — `discoveryState` (`git.ts:891`)
short-circuits when the cwd is itself in a repo, so a sibling worktree appears only because this
feature opens a session tab there and `App` discovers per-entry. It never appears "for free" from the
main repo.

To group: add a `common` field to `GitRepo` (`git.ts:27`) from `mainWorktreeRoot`, and group in
`GitPanel`. Costs one extra `rev-parse` per repo per `recheck()` (the debounced watcher path). The type
propagates to the renderer automatically, since `GitPanel` derives it from the preload return.
`GitPanel`'s render is a flat `repos.map`, so indentation is a real restructure, not a class name.

---

## 11. Confirmed non-issues — do not "fix" these

- **`.snowignore` and the commit flows are correct from a worktree.** Every path is cwd-relative and
  `.snowignore` is global, so `git:commit`, `git:status` (`git.ts:1131`), and `resolveCommitTargets`
  all behave. `git:diff`'s scratch index goes to `os.tmpdir()`, not the git dir, so it is
  worktree-safe.
- **`parkedFiles` (`git.ts:713`)** runs `stash show` / `ls-tree` against shared refs — identical from
  any worktree.
- **Windows paths** are fine *if* compared through `samePath`/`collapseHome` (`config.ts:22-35`).
  Never compare raw.
- **The worktree recursive watch** (`git.ts:1929`) is unaffected — `.git` is a file in a worktree, so
  `ignoredWorktreeEntry` still does the right thing.

## 12. Open questions

- Worktree directory naming scheme and location (Stage 4).
- Whether worktree tabs get a minted preset or borrow the parent repo's (Stage 4) — affects demotion
  cleanup.
- Whether demotion force-deletes ignored files or refuses (Stage 5).
- Whether `git:changed` cross-worktree noise (Stage 0.3) needs filtering in practice.

## 13. Order summary

```
Stage 0  mainWorktreeRoot + callers | withRepoLock rekey | git:watch common dir | syncDefault refspec
Stage 1  registry: field, validate, setWorktree, two accessors, worktreeMap
Stage 2  switchBranch pre-refusal + BranchSelect disabling      <- before promotion
Stage 3  WorkflowSelect two verbs                                <- design checkpoint
Stage 4  promotion
Stage 5  demotion + prune + pty spawn guard
Stage 6  GitPanel grouping
```

Stage 0 ships alone and is worth landing regardless of whether the rest proceeds.
