# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`snow` is a terminal emulator and AI workflow helper built with Electron + React + TypeScript
(scaffolded with electron-vite). The goal is a workspace of terminal panes hosting Claude
sessions and git windows. Currently it renders a single working terminal pane.

## Commands

- `npm run dev` — launch the app with hot-reloading renderer (Vite dev server + Electron).
- `npm run build` — typecheck then compile all three processes into `out/`.
- `npm run typecheck` — runs both `typecheck:node` (main/preload) and `typecheck:web` (renderer) via separate tsconfigs.
- `npm run lint` / `npm run format` — ESLint (cached) / Prettier.
- `npm run start` — preview the last production build (`electron-vite preview`).
- `npm run build:win` / `build:mac` / `build:linux` — package installers via electron-builder.

There is no test runner configured.

## Architecture

Electron's three-process split is the core structure; each has its own tsconfig and build target:

- **Main** (`src/main/`, Node.js) — creates the window and owns all OS access.
- **Preload** (`src/preload/`) — the only bridge; exposes a narrow, typed API to the renderer via `contextBridge`.
- **Renderer** (`src/renderer/src/`, Chromium/React) — sandboxed UI, no direct Node access. Note the nested `src/renderer/src/` is intentional (Vite web-root convention: `index.html` at `src/renderer/`, app code under its `src/`).

### Terminal data flow (the central feature)

A terminal is an [xterm.js](https://xtermjs.org/) instance in the renderer wired to a real
[node-pty](https://github.com/microsoft/node-pty) shell process in main, over IPC. Everything is keyed by a
numeric terminal `id` that the renderer generates (`nextTerminalId` in `Terminal.tsx`).

```
xterm.js (Terminal.tsx)  →  window.api.terminal.*  (preload)  →  ipcMain (pty.ts)  →  node-pty shell
        ▲                                                                                    │
        └──────────────  term.write(data)  ←  'pty:data'  ←  webContents.send  ←────────────┘
```

IPC channels (all defined in `src/main/pty.ts` and mirrored in `src/preload/index.ts`):
`pty:spawn`, `pty:write`, `pty:resize`, `pty:kill` (renderer→main) and `pty:data`, `pty:exit` (main→renderer).

Key files:

- `src/main/pty.ts` — `PtySession` map keyed by id; spawns/writes/resizes/kills PTYs and bridges I/O. Sends to the renderer are guarded (`safeSend`) and each PTY is killed on `webContents 'destroyed'` and on app `will-quit`, so reloads/crashes/quit don't leak shells.
- `src/preload/index.ts` — defines `window.api.terminal`; its `onData`/`onExit` return unsubscribe functions. `export type Api` is consumed by `src/preload/index.d.ts` to type `window.api`.
- `src/renderer/src/components/Terminal.tsx` — one xterm pane per component; a `ResizeObserver` refits and resizes the PTY.

### Diff rendering

`DiffBody` renders one `DiffFile` per changed file, each gated on an `IntersectionObserver` so nothing
loads until it scrolls into view. On becoming visible a file makes **one** IPC call, `git:blame`, which
returns `{ lines, source }`: `git blame --line-porcelain` already emits every source line, so
`parseBlame` keeps them instead of throwing them away, and the file content at that rev comes free with
the blame. There is deliberately no second "read this file" channel — adding one would spawn a second
`git` process for bytes the first already produced. `source` is `null` past `maxSourceChars`.

Syntax highlighting runs in a **web worker** (`src/renderer/src/tokenize.worker.ts`), driven by
react-diff-view's `useTokenizeWorker`. This is load-bearing, not a nicety: passing `oldSource` to
`tokenize` makes it highlight both entire file versions (not just the hunk text) so a hunk inside a
block comment or template literal colors correctly, and that is far too much synchronous work for the
thread that also hosts the xterm panes. The worker is a lazily-created module singleton shared by every
`DiffFile`; `useTokenizeWorker` tags each job with an id and ignores replies for other files.

The 22 refractor grammars live **only** in the worker, which is why `syntax.ts` imports nothing — it is
just the extension→language map plus `languageFor`. That keeps ~340 kB of grammars out of the main
renderer bundle and off the startup path. Because the map and the registration list are in different
bundles they can drift, so the worker checks `refractor.registered()` and reports an unknown grammar as
a tokenize failure rather than throwing; the guard belongs next to the registry, not next to the map.

Each visible file tokenizes twice: once from hunk text alone (fast, highlighting appears immediately)
and again once `git:blame` returns `source`. Files that are not visible pass empty hunks, so work stays
proportional to what is on screen.

### Pull requests

`git:openPullRequest` turns the remote URL into a web URL (`webUrl` normalizes scp-like and Azure SSH
forms) and then picks a URL shape from the `forges` table. Hosts are matched on **dot-delimited
labels**, not substrings: `github.mycompany.com` and `git.gitlab.example.com` match, while
`gitlab-mirror.github-cdn.example.com` and `notgithub.com` correctly do not.

An unrecognized host is a **failure**, not a fallback to the repo homepage — opening the wrong page and
reporting success is worse than saying so. The escape hatch is per-repo git config:
`git config snow.pullRequestUrl "https://host/...?from={branch}&to={base}"`, with `{branch}`, `{base}`,
and `{repo}` substituted. It is checked before the table, so it also overrides a known forge.

### User config

All config files live in `~/.config/snow/` (`$XDG_CONFIG_HOME/snow/` when set); `configDir()` in
`src/main/config.ts` is the single place that resolves the directory. The log (`snow.log`) is written
there too; each watcher filters `fs.watch` events by basename, so log writes never retrigger them.

#### `theme.json`

Two sections, both scoped to the git view: `git` (chrome and diff backgrounds) and `syntax` (diff
highlight token colors). `src/main/theme.ts` owns it: it writes the defaults on first launch, reads and
validates on `theme:get`, and `fs.watch`es the directory to broadcast `theme:changed` on edit. Unknown
or malformed values fall back to the defaults per key, so a bad edit degrades instead of breaking —
`mergeColors` drives that off the keys of `defaultTheme`, so the defaults are the only key list.
Because the default file is written with `flag: 'wx'`, an existing `theme.json` never grows the
`syntax` block on disk; the keys are whatever `defaultTheme.syntax` lists.

`useGitColors` (`src/renderer/src/useGitColors.ts`) pushes each color onto `document.documentElement`
as a custom property that `main.css` consumes with the default as its fallback: `git` through the
explicit `cssVars` map (`--git-*`, since those names are not mechanical), `syntax` as `--syntax-` plus
the kebab-cased key. `lanes` is returned to `GitPanel` since SVG strokes need the value in JS.

The `--syntax-*` properties are consumed by `.commit-file-section .token.*` rules — scoped to the
element `DiffBody` itself renders, not to the surrounding scroll container, so highlighting follows
`DiffBody` wherever it is mounted.

`strongText`, `accent`, `buttonBorder`, and `buttonBorderHover` model the button palette the git view
shares (`.commit-toggle-button`, `.commit-totop-button`, `.commit-subject`, `.commit-file-title`). The
action bar and the `picker-*` dropdowns still hardcode the same hexes — they predate the theme system
and are not part of the git view it covers.

#### `.snowignore`

Paths the action bar must never touch, in `.gitignore` syntax, applied to every repo.
`src/main/snowignore.ts` mirrors `theme.ts`'s lifecycle (default written with `flag: 'wx'` on first
launch, directory `fs.watch` broadcasting `snowignore:changed`, `snowignore:get` handler) and matches
with the `ignore` package. Its `filterPaths()` expects repo-root-relative forward-slash paths — what
`git status --porcelain` emits, even when run from a subdirectory.

`git.ts` consults it in two places: `git:commitPush` stages an explicit filtered file list instead of
`git add -A`, and `git:status` reports `stageable` (the filtered count) alongside the unfiltered
`changed`. `ActionBar` gates its button on `stageable` and re-checks on `snowignore:changed`;
`GitPanel` still uses `changed`, so the dirty indicator reflects real repo state. A matched file that
is already staged is left alone — snow only filters what it adds.

#### `.snowconfig`

Session presets for the home tab, as JSON. `src/main/snowconfig.ts` mirrors `theme.ts`'s lifecycle
(default written with `flag: 'wx'` on first launch, directory `fs.watch` broadcasting
`snowconfig:changed`). Shape is `{ presets: { name, cwd, default? }[] }`; entries missing a string
`name`/`cwd` are dropped, and a leading `~` in `cwd` is expanded to the home dir **only on read**, so
the renderer gets absolute paths while the file keeps the raw `~`. Beyond `snowconfig:get` it exposes
two write handlers — `snowconfig:addPreset` and `snowconfig:setDefault(index)` (index `-1` clears the
default) — that mutate the raw parsed presets and rewrite the file; the fs.watch broadcast then keeps
every window in sync. `useSnowconfig` (`src/renderer/src/useSnowconfig.ts`) is the single subscription;
`App` reads it so the tab strip's `+` button opens the `default` preset's cwd (home dir if none), and
`HomePage` renders each preset with a default checkbox (radio-like via `setDefault`) plus an add form.
Opening a preset calls `App`'s `addSession(cwd)`, which seeds the session's cwd (so git/tab-label are
correct before the shell's first OSC 7) and passes it to both terminals' spawn.

#### `snow.log`

`src/main/log.ts` owns it. `initLogging()` runs at the top of `src/main/index.ts` — before
`app.whenReady()`, so nothing registered later escapes it — and does three things: opens an append
stream to `snow.log` (deleted and recreated past 100k), tees main-process `console.*` into it, and
monkey-patches `ipcMain.handle`/`ipcMain.on` so **every** IPC call is logged with its args, result or
thrown error, and duration. That wrapper is why `git.ts` needs no logging code of its own. Lines are
`ISO-timestamp LEVEL [scope] message`, and values are JSON-serialized then truncated at 400 chars.

Two sets of exclusions. Terminal content: `pty:write` and `pty:resize` are in `quietChannels`
(logging keystrokes would make this a keylogger and swamp the file), and `pty:data` flows
main→renderer so it is never seen by the wrapper. PTY _lifecycle_ is still logged explicitly in
`pty.ts` (`spawn` with pid/shell/cwd, `exit` with code). Presets: the `snowconfig:*` channels are in
`redactedChannels`, so the call and its duration are logged but the args/result payload is not.

Renderer output reaches the file through `watchRenderer(webContents)` in `createWindow`, which
forwards `console-message`, `render-process-gone`, `did-fail-load`, and `preload-error` — so the
renderer needs no logging API and gets no new privilege. `closeLogging()` on `will-quit` flushes.

## Workflows

A **workflow** is a branch you have explicitly registered, plus the uncommitted work parked on it.
Three modules, in a strict one-way dependency chain — `registry.ts` ← `git.ts` ← `workflow.ts`:

- `src/main/registry.ts` — the `.snowworkflows` file. Imports nothing from git, which is what keeps
  the chain acyclic.
- `src/main/git.ts` — the park machinery (`parkOnLeave`, `restoreOnEnter`, `rollbackPark`,
  `switchBranch`) on top of the git primitives, consulting the registry.
- `src/main/workflow.ts` — the `workflow:*` handlers, composed from the other two.

**Registration is the opt-in, and it is the whole point.** The dropdown never enumerates branches —
it lists only registered ones. A branch becomes a workflow via `workflow:register` (registers the
current branch) or `workflow:create` (which registers what it creates).

Parking is a property of the _branch_, not of which dropdown you used. `git:checkout`,
`git:checkoutRemote`, and `git:syncDefault` all route through `switchBranch`, so leaving a registered
workflow parks its changes even when you switch from the branch dropdown, and arriving at one
restores them. On a branch that is _not_ registered, snow does nothing special: the park is skipped
and a plain `git checkout` runs, so the changes ride along, or git refuses the switch exactly as it
always would. Nothing is ever stashed on a branch you did not opt in to.

`git:createBranch` is the exception, because `checkout -b` branches from HEAD and so **cannot** fail
on a dirty tree — parking there rescues nothing and only contradicts what git would do. It takes a
`carry` flag: `carry: false` routes through `switchBranch` (park on the branch you are leaving),
`carry: true` runs a plain `checkoutLocalBranch` so the changes come with you. `BranchSelect` never
guesses. Its create form first calls `git:parkPreview`, which reports the branch and dirty-file count
when a park _would_ happen and `null` otherwise; on `null` it creates straight away, and on a hit it
opens a two-button dialog and passes the answer as `carry`. The preview is advisory only — it
swallows its own errors, and the authoritative failure still comes from the real call.

#### `.snowworkflows`

The registry, in `~/.config/snow/`, with the same lifecycle as the other config files (default
`{"workflows": []}` written with `flag: 'wx'` on first launch, directory `fs.watch` filtered by
basename broadcasting `workflow:changed`) — but built from the shared `writeDefaultConfig`,
`watchConfigFile`, and `broadcast` helpers in `config.ts` rather than pasting the block a fourth
time. Like `theme.ts` and `snowconfig.ts`, only the watcher broadcasts; `addRecord`/`removeRecord`
write and let the debounced watch event notify every window, so one registration is one reload.
`initRegistry()` runs _before_ `registerGitHandlers()` in `index.ts`, since the
git handlers read it. Shape is `{ workflows: { repo, branch }[] }` — flat, because branch names
collide across repos. `repo` is the worktree root with `~` collapsed on write and expanded on read,
like `.snowconfig` does for `cwd`. Paths are compared with `samePath`, which resolves and
slash-normalizes before comparing, case-insensitively on win32 — necessary because
`git rev-parse --show-toplevel` emits forward slashes while `os.homedir()` and `path.resolve` use
backslashes. `addRecord`/`removeRecord` re-read first and **bail if the read errored**, so a
hand-corrupted file is never silently replaced with a one-entry registry.

A read error is never treated as "nothing is registered" — that would silently disable both parking
_and_ restoring, so a branch with work already in the stash would come up empty with no explanation.
`registeredBranches()` throws instead, which `switchBranch` turns into an ordinary failed-switch
dialog and leaves the tree untouched until the file is fixed. `workflow:list` is the one reader that
returns the error rather than throwing (it has no tree to protect), and `WorkflowSelect` renders it
in the dropdown and the button tooltip.

#### Parked work

Parked work lives in git's own stash list under the message `snow-wf:<branch>`, so it survives use
of git outside snow and is recoverable by hand. Entries are read back with
`git stash list --format=%gd%x1f%gs%x1f%aI` and matched on that marker. Stash selectors (`stash@{n}`)
shift on every push and drop, so they are always re-listed immediately before an apply and never
cached. When a branch has more than one marker stash (a previous pop conflicted and git kept it),
the newest wins and the rest stay listed as parked — lossless.

`parkOnLeave()` is the single gate: it parks with `git stash push -u` (untracked included, so nothing
leaks between branches; `.gitignore`d paths are still skipped) **only when the current branch is
registered and dirty**, and refuses to park a tree with conflicts in it. `restoreOnEnter()` is its
mirror and is likewise gated on registration — a marker stash left on a branch you have since
unregistered is never silently popped, which is what makes the "your parked changes stay in the
stash" line in the unregister dialog true. `switchBranch()` composes the two around an arbitrary
checkout closure, which is why every switch path shares the exact same semantics.

`workflow:create` routes through `switchBranch` too — branching from the remote's default rather
than an existing ref is just what its closure does:
`checkout -b <name> --no-track <remote>/<default>`. **`--no-track` is load-bearing**: without it the
branch tracks `origin/<default>`, and `git:commitPush` would take its `status.tracking` path and push
a feature branch at the default branch's upstream. `restoreOnEnter` is a no-op on the way in, since
the new name is not registered until `addRecord` runs after the checkout — except when the registry
still holds an entry for a branch of that name that was since deleted, where re-creating it recovers
the parked stash that `WorkflowSelect` was already showing as a missing-branch row.

`switchBranch` is the only park entry point `git.ts` exports; `parkOnLeave`, `restoreOnEnter`,
`rollbackPark`, and `registeredBranches` are module-private so no caller can take half the gate.

Every path rolls the park back through `rollbackPark()` if the checkout fails, so a failed call
leaves the tree exactly where it started. A conflicting pop is reported like `git:updateFromDefault`
does — conflicted paths in `detail`, stash kept. When `rollbackPark` _cannot_ put the work back —
either the pop failed or the marker stash is no longer listed — it appends recovery instructions to
`detail` rather than returning the bare checkout error, since otherwise the tree would come back
empty with nothing on screen explaining where the changes went.

Snow never drops a stash. `workflow:unregister` only removes the registry entry; any parked work
stays in `git stash` and the dialog says so.

`.snowignore` is deliberately not consulted: it is a commit filter, not a worktree filter, so a
matched-but-modified file parks and restores unchanged.

Parked file counts are `git stash show --name-only` plus `git ls-tree -r --name-only <sel>^3` (the
untracked parent, absent when nothing untracked was parked) rather than `git stash show -u`, which
needs git ≥ 2.32. The missing `^3` is the expected case and counts as zero, but a failed _tracked_
listing yields `null`, not `0` — a marker stash always has content, so "0 files parked" would be a
lie. `WorkflowSelect` renders `null` as `● ?`. No git watcher is added: stash writes touch `.git/refs/stash` and
`.git/logs/refs/stash`, already covered by `git:watch`. `WorkflowSelect` reloads on both
`git:changed` and `workflow:changed`.

`WorkflowSelect` sits beside `BranchSelect` in `.actionbar-right`. The two share one dropdown
vocabulary — the chrome classes in `main.css` are named `picker-*`, not `branch-*` — and
`WorkflowSelect` adds only `workflow-*` rules for the parked badge, the missing-branch row, the
register button, and the remove button. Its button reads the branch name when that branch is a
registered workflow and a neutral "Workflows" when it is not.

## Session tabs

`App.tsx` owns the tab model: `sessions` (each `{ id, cwd? }`), `activeId` (`number | 'home'`), and a
per-session `cwds` map fed by each session's bottom-terminal OSC 7. The active session's cwd drives
`ActionBar` and `GitPanel` exactly as a single `cwd` prop did before. `Session` renders the Claude
(top) + shell (bottom) pair; all sessions stay mounted and inactive ones are hidden with
`display:none` so their PTYs survive tab switches (they die only on close/unmount). `Terminal` takes
an `active` prop and re-fits via `requestAnimationFrame` on activation; its fit/resize is guarded on a
non-zero container size so a hidden (0×0) pane is never shrunk to `FitAddon`'s minimum columns.

## node-pty (native module) constraints

`node-pty` is a native module and must **not** be bundled:

- `electron.vite.config.ts` externalizes it via `externalizeDepsPlugin` in the `main` config.
- `electron-builder.yml` lists `**/node_modules/node-pty/**` under `asarUnpack` so its `.node` binaries load from disk in packaged builds.
- It ships N-API prebuilds (ABI-stable), so no native rebuild is needed across Node/Electron versions.

The default shell is `powershell.exe` on Windows, `$SHELL` (or `/bin/bash`) elsewhere — set in `defaultShell()` in `pty.ts`.

## Conventions

- Do not write comments. Let the code speak for itself.
- Do not vertically align text with uneven spacing (no padding names/values with extra spaces to line up columns).
- Renderer terminal font is **Hack Nerd Font Mono**, bundled so Starship glyphs render aligned without a system install: the four Mono weights live in `src/renderer/src/assets/fonts/`, are declared as `@font-face` in `assets/fonts.css`, and `main.tsx` awaits `document.fonts.load` for each weight before mounting `App` so xterm's canvas measures real glyph metrics. The stack still falls back to Menlo/Consolas/Cascadia/monospace.
- `@renderer` path alias maps to `src/renderer/src/` (see `electron.vite.config.ts` and `tsconfig.web.json`).
- New privileged capabilities follow the same pattern: add an `ipcMain` handler in main, expose a wrapper in preload's `api`, never give the renderer direct Node access.
