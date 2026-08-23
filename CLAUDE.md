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

#### Staging from the diff (working tree only)

Each file header in `DiffBody` carries **Stage/Unstage** and **Revert** buttons, driven by an optional
`staging` prop. `CommitView` never passes it, so a historical commit's headers stay plain — the
buttons exist only where there is a worktree to act on, which is `WorkingDiffView`.

`WorkingDiffView` owns **both** the actions and the confirm dialog, because it is the action owner —
the same shape `BranchSelect` and `WorkflowSelect` use for their dialogs. It runs the actions through
the shared `useGitAction` (so a failure surfaces in a `FailureDialog` like every other git action) and
passes that hook's `pending` straight through as `staging.busy`, which disables every file's buttons
while one is in flight; there is deliberately no second `pending` state, since `useGitAction.run`
already no-ops a re-entrant call. `onRevert` therefore only ever means "ask" — it opens the confirm
dialog, and the Discard button is what calls `git:revertFile`. Routing the dialog through `DiffBody`
instead would give the one prop two meanings and put modal state in the component whose job is
rendering a parsed patch (and which `CommitView` shares). Nothing refreshes the view by hand: staging
writes `.git/index`, which the `git:watch` watcher already reports, so the reload is the same
`git:changed` path an outside `git add` takes.

The three handlers (`git:stageFile`, `git:unstageFile`, `git:revertFile`) each take the file's `path`
**and `oldPath`**, because a rename is one diff entry over two worktree paths and staging or
reverting only half of it leaves the tree in a state the diff can't express. `fileTargets` resolves
both against the worktree root, refuses anything that escapes it, and returns `{ rel, full }` pairs —
`rel` to compare against git's own root-relative output, `full` because the pane's cwd may be a
subdirectory. They share one `fileHandler` registrar holding the whole common shell (`withRepoLock`,
the targets resolution, `.catch(fail)`), so each handler is just its git command; none carries an
inner `try/catch`, since `fail` produces exactly the same result the outer `.catch` already does.
Unstage is a bare `git reset -q --` with no `HEAD` argument, which is the unborn-HEAD-safe form and so
needs no `rev-parse` probe first. Revert resolves **all** its paths against HEAD in one
`ls-tree -r -z --full-name --name-only`, then batches: `checkout HEAD --` for the paths HEAD has,
`rm --cached` plus deleting the file for the ones it doesn't (`checkout` has nothing to restore for a
path the last commit never had). Probing per path with `cat-file -e` instead would be two sequential
git processes per side of a rename.

The header is `position: sticky`, and `DiffScroll`'s tools row (close, find bar, `↑ Top`) is pinned to
the same top-right corner, so a header at the top of the pane puts its buttons underneath them. The
fix is unconditional, not scroll-dependent: `.commit-file-actions` takes `margin-right: auto`, which
parks the buttons immediately right of the filename instead of at the far edge, and
`.commit-file-title-staging` (a class `DiffBody` adds only when `staging` is passed, so `CommitView`'s
headers are untouched) reserves `--diff-tools-inset` of right padding for the long-filename case where
the name shrinks and pushes the buttons back out.

Making that reserve **conditional on being stuck was tried and does not work**. A
`container-type: scroll-state` header with `@container scroll-state(stuck: top)` reads as _not_ stuck
at exactly the scroll offset where a sticky element sits at its natural position — which is precisely
where clicking a row in the file list lands it, since `scrollIntoView({ block: 'start' })` aligns the
section top to the pane top. So the one case that most needs the reserve is the one case the query
misses. An `IntersectionObserver` sentinel has the same boundary problem plus a re-render per header
crossing the top edge, during scroll, for every file on screen.

`--diff-tools-inset` is measured by `DiffScroll` with a `ResizeObserver` on the tools row rather than
hardcoded, because that row's width changes as the find bar opens and as `↑ Top` appears past the
scroll threshold — a fixed padding would be wrong in both directions.

The same three actions hang off `GitPanel`'s changed-file list (the one the `n changed` badge
toggles open), as hover-revealed icon buttons per row. `RepoSection` owns them directly rather than
taking callbacks from `App`: it already holds the repo's `cwd` and its `git:status`, and it already
reloads on `git:changed`, so a stage from there refreshes by the same watcher path everything else
uses. Staged-ness is `file.index` (anything but ` `, `?`, `!`) — deliberately not the
`fileCategory`/`git-file-staged` grouping, which reads a partially staged file as unstaged because it
keys off `working_dir`. The row was a bare `<button>`, so the actions forced a wrapping
`.git-file-row` div; buttons cannot nest, the same constraint the home page's hidden-preset rows hit.

Both surfaces share `DiscardDialog`, which is a **specific** component rather than a generic
`ConfirmDialog` — the copy (what revert does to a path HEAD doesn't have) is the part worth writing
once, and a dialog that only took `{ title, body, confirmLabel }` would push that wording back onto
every caller. It focuses Keep and closes on Escape; it deliberately does not confirm on Enter, since
the action is unrecoverable.

What the three dialogs **do** share is their shell. `GitDialog` owns the backdrop (dismiss on
pointer-down outside, `stopPropagation` inside), the Escape listener, and focusing the first button
in the actions row; `DiscardDialog`, `FailureDialog`, and `BlockedCommitDialog` are thin wrappers
supplying a title, a `detail` string, and their own buttons. Splitting it this way is the point of
the paragraph above: the _mechanics_ were three byte-identical copies and belong in one place, while
the _semantics_ — the wording, which button leads, whether Enter confirms — stay per-dialog.
`dismissOnEnter` is the one behavioral knob, and only `FailureDialog` sets it, because dismissing an
error is the only one of the three that is recoverable.

Staged state comes back on the diff itself: `git:diff` marks each file `staged` from
`git diff --cached --name-only` against the same `base` it already resolved, rather than the renderer
running a second status call. That is deliberately not `git status`, which would walk the whole
worktree and enumerate untracked files to yield one bit per path; the query is index-vs-base only and
starts before the scratch-index build so it overlaps it. A partially staged file reads as staged, so
its button offers Unstage and unstages the whole file.

#### Find (Ctrl+F)

`useFind` (`src/renderer/src/useFind.ts`) gives every `DiffScroll` pane a find bar, so both
`CommitView` and `WorkingDiffView` get it. It never touches the DOM: matches are `Range`s handed to
the CSS Custom Highlight API (`CSS.highlights`), styled by the `::highlight(snow-find)` /
`::highlight(snow-find-current)` rules in `main.css`. Mutating the tree instead would fight
react-diff-view's rendering and invalidate on every tokenize pass.

The scan concatenates the pane's text nodes into one string and remembers each node's offset, so a
match may span the token `<span>`s syntax highlighting produces — searching `const x` works even
though `const` and `x` are separate elements. A `\n` is inserted between block ancestors, which is
what keeps a match from running across two diff lines. Text directly inside a `td.diff-gutter` is
skipped so line numbers are not matched; blame text sits in spans, so it still is.

Because the highlight registry is global while several diff panes stay mounted at once, the module
tracks which pane owns the two highlight names and an inactive pane only clears highlights it owns.
Results are recomputed on a debounced `MutationObserver` (lazy blame and worker tokens rewrite the
tree under the search), which ignores mutations inside `.commit-tools` — the sticky row holding the
find bar and the top button — since rendering the match count would otherwise retrigger the search.

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

Themes live in `~/.config/snow/themes/` as a library of named files (`theme.json`, `theme_light.json`,
…). Which one is **active** is chosen by the `.snowconfig` `theme` field (the base filename, default
`"theme"`); `themePath()` resolves `themes/<name>.json` off `activeThemeName()` and is the single place
that does — `themeFile()` sanitizes the name to `[A-Za-z0-9_-]` so a hand-edited value can't escape the
directory. `theme:get` reads the active file; `theme:list` enumerates the base names for the home-page
picker; `writeDefaultTheme` only ever seeds `theme.json`. The watcher watches the whole `themes/`
directory (any `.json` write re-reads the active theme and broadcasts `theme:changed`), so editing the
active file hot-reloads it. A **switch** writes `.snowconfig`, not `themes/`, so the theme watcher
doesn't fire — instead the renderer's shared theme store (`themeStore.ts`) re-fetches `theme:get` on
`snowconfig:changed`, which is why it subscribes to both events. `theme.ts` importing
`activeThemeName` from `snowconfig.ts` is the one cross-config dependency and stays acyclic
(`snowconfig.ts` imports nothing back). Files land in that directory by hand or through
`snow theme <url>` (see _The `snow` command_).

The picker is `ThemeSelect` (bottom-left of the home page): it lists `theme:list`, shows the active
name, and writes the choice through `snowconfig:setTheme`. It is styled with the `--ui-*` vars, so the
dropdown itself recolors with the theme it selects.

Three sections: `ui` (the app chrome outside the git view — action bar, tab bar, tabs, buttons,
dropdowns, dialogs, home page, terminal backgrounds), `git` (git-view chrome and diff backgrounds),
and `syntax` (diff highlight token colors). `src/main/theme.ts` owns it: it writes the defaults on
first launch, reads and validates on `theme:get`, and `fs.watch`es the directory to broadcast
`theme:changed` on edit. Unknown or malformed values fall back to the defaults per key, so a bad edit
degrades instead of breaking — `mergeColors` drives that off the keys of `defaultTheme`, so the
defaults are the only key list. Because the default file is written with `flag: 'wx'`, an existing
`theme.json` never grows a newly-added block (e.g. `ui`) on disk; the keys are whatever the matching
`defaultTheme` section lists, and a missing section merges wholesale to defaults.

`themeStore.ts` is the single renderer theme subscription: it fetches `theme:get` once, listens on
`theme:changed`/`snowconfig:changed`, and fans the result out to every consumer through
`useSyncExternalStore` — so opening N terminals no longer means N `theme:get` calls. It pushes each
color onto `document.documentElement` as a custom property that `main.css` consumes with the default
as its fallback: `git` through the explicit `cssVars` map (`--git-*`, since those names are not
mechanical), `ui` as `--ui-` and `syntax` as `--syntax-`, both plus the kebab-cased key. `useGitColors`
is a thin wrapper returning `theme.git`; `lanes` off it reaches `GitPanel` since SVG strokes need the
value in JS.

The `--ui-*` properties replaced the Catppuccin hexes the chrome CSS used to hardcode. The
replacement was scoped to skip the git-view block (`.git-panel` … `.commit-truncated`), which stays
on `--git-*`/`--syntax-*` — several `--ui-*` defaults (`accent`, `placeholder`, `borderHover`) share a
hex with a `git`/`syntax` fallback, so a blind swap would have nested `--ui-*` inside those fallbacks.
`ui.terminalBackground` is deliberately its own key (not `surface`) so the terminal panes theme
independently: it drives both `.terminal-host`/`.xterm-viewport` in CSS **and** the xterm.js
`theme.background`. `Terminal.tsx` reads the shared `themeStore` and writes `term.options.theme` so
panes recolor live (foreground follows `ui.text`; cursor stays hardcoded).

`lanes` is the whole per-column palette: edge strokes take `lanes[parentCol]`, and each commit node
gets its own gradient from the adjacent pair — `--grad-top: lanes[col]`, `--grad-bottom: lanes[col+1]`
(both set inline per node), so every column animates through its own color range rather than sharing
one gradient. When the `.snowconfig` `gradients` toggle is off, `GitPanel` sets `--grad-bottom` equal
to `--grad-top` and adds `git-graph-flat` (which kills the wave animation), so nodes are the solid lane
color — still distinct per column. There is deliberately no `nodeGradientTop`/`nodeGradientBottom`
theme key: node color is derived entirely from `lanes`.

The `--syntax-*` properties are consumed by `.commit-file-section .token.*` rules — scoped to the
element `DiffBody` itself renders, not to the surrounding scroll container, so highlighting follows
`DiffBody` wherever it is mounted.

`strongText`, `accent`, `buttonBorder`, and `buttonBorderHover` model the button palette the git view
shares (`.commit-toggle-button`, `.commit-totop-button`, `.commit-subject`, `.commit-file-title`). The
action bar and the `picker-*` dropdowns are the git view's near-neighbours but are chrome, so they
theme through the `ui` section (`--ui-*`), not these `git` keys.

#### `.snowignore`

Paths the action bar must never touch, in `.gitignore` syntax, applied to every repo.
`src/main/snowignore.ts` mirrors `theme.ts`'s lifecycle (default written with `flag: 'wx'` on first
launch, directory `fs.watch` broadcasting `snowignore:changed`, `snowignore:get` handler) and matches
with the `ignore` package. Its `filterPaths()` expects repo-root-relative forward-slash paths — what
`git status --porcelain` emits, even when run from a subdirectory.

The compiled matcher is cached, and the cache is validated against the file's own `mtimeMs:size`
stamp on every call — **not** left to the watcher to invalidate. The watcher is the wrong sole
authority for this one because it can die silently: `fs.watch` throws on some filesystems (the
`catch` leaves `watcher` null) and its `'error'` handler closes the watcher without ever
re-attaching. Either way the patterns read at startup would be pinned for the life of the process,
and a `.snowignore` the user has since edited — or deleted — would go on filtering by its old
contents, which is precisely the failure that lets an ignored file into a commit. The stamp also
covers a truncate-then-write save landing between the watcher's event and its 120 ms debounce, where
the read would otherwise cache an empty pattern list. `statSync` per call is far cheaper than the
`readFileSync` it usually avoids, and the stamp is taken **before** the read: sampling it after
would let a write that lands mid-read be cached under a stamp that already looks current. The
watcher stays, because broadcasting `snowignore:changed` to the renderers is a job the stamp cannot
do.

`git.ts` consults it in two places: `git:commit` stages an explicit filtered file list instead of
`git add -A`, and `git:status` reports `stageable` (the filtered count) alongside the unfiltered
`changed`. `ActionBar` gates its button on `stageable` and re-checks on `snowignore:changed`;
`GitPanel` still uses `changed`, so the dirty indicator reflects real repo state.

That add happens **only when nothing is staged yet**. Once anything is in the index — from the diff
view's Stage buttons or from `git add` in a shell — `git:commit` skips staging entirely and commits
the index as it stands, so a deliberate partial stage is never widened into "everything". The
button's gate widens to match (`stagedCount > 0 || stageable > 0`, both from `git:status`), since a
repo whose only staged file is `.snowignore`d still has something to commit.

**The filter therefore has to run over the index too, not just over what snow adds.** Filtering only
the add is what let ignored files reach a commit: anything that stages outside snow — a Claude
session in a pane running `git add`, `git add -p` in the bottom shell, a merge — flips `git:commit`
onto its index path, where `.snowignore` used to go unconsulted. It looked intermittent because it
depended entirely on whether something happened to be staged when the button was clicked.
`resolveCommitTargets` now filters whichever set it is about to commit (the staged files when there
are any, the worktree otherwise) and returns the matches it found staged as `blocked`. `git:commit`
refuses on a non-empty `blocked`, returning the paths on `GitCommitResult.blocked`; `ActionBar`
renders those in `BlockedCommitDialog`.

Main returns only the paths and a one-line `error`, and the **renderer owns the prose**. `ActionBar`
builds its commit action with no `onFailure`, so a `detail` composed in `git.ts` would reach nothing
but the button's tooltip — the dialog is the surface, so the explanation is written there once
instead of on both sides of the IPC boundary.

The dialog's two actions are the two ways out, and each is one re-invocation of `git:commit` with a
different `ignored: CommitIgnored` — `'block'` (the default, what the button sends), `'unstage'`, or
`'include'`. `'unstage'` reruns `git reset -q --` over just those paths and re-resolves from a fresh
`git status`, so unstaging the last staged file falls through to the normal add path rather than
committing nothing, and a partial stage of an allowed file keeps the index content it had.
`'include'` skips the whole gate and commits the index as it stands — the escape hatch for a path
that is `.snowignore`d but wanted in this one commit, which is otherwise only reachable by editing
the file or committing from a shell. One three-state parameter rather than two booleans, since the
states are exclusive and a `{ unstage: true, include: true }` call has no meaning.

Refusing rather than silently unstaging (or silently committing) is the point: the index is the
user's, and a dialog that names the paths is what makes the choice legible. It focuses Cancel and
closes on Escape; like `DiscardDialog` it deliberately does not confirm on Enter, since neither
other button is recoverable.

A **rename is blocked when either side matches**, not just the new path. `git status` reports one
staged rename as a single entry whose `path` is the destination, so matching that alone let
`environment.ts -> env.ts` carry an ignored file's contents into a commit under a name the pattern
does not cover. Both sides also go into the reset, since resetting half a rename leaves a state the
index can't express — the same reason `fileTargets` resolves both. Only `git:commit` looks at both
sides; `git:status`'s per-file `ignored` flag stays keyed on `path`, because an _unstaged_ rename is
two separate entries (a delete and an untracked file) that each match on their own.

`git:generateCommitMessage` shares the gate for the same reason. Its staged branch used to diff
`--cached` with no pathspec, which piped an ignored file's contents to the `claude` CLI — the exact
disclosure `.snowignore` exists to prevent. It now scopes that diff to `resolved.targets` whenever
`blocked` is non-empty, and bails as "Nothing to commit" when nothing is left, rather than blocking
outright: generating a message is not the destructive half, and the commit itself still raises the
dialog.

The button's face says which of those two it will do. `glyphs.add` and `glyphs.commit` are separate
entries rather than one two-glyph string, so `commitGlyph` can drop the add glyph when `stagedCount`
is non-zero and leave just the commit one — the icon then matches the tooltip, which likewise switches
from `Add, Commit` to `Commit N staged files`.

#### `.snowconfig`

Session presets for the home tab, as JSON. `src/main/snowconfig.ts` mirrors `theme.ts`'s lifecycle
(default written with `flag: 'wx'` on first launch, directory `fs.watch` broadcasting
`snowconfig:changed`). Shape is
`{ presets: { name, cwd, default?, commands?, startupCommand?, splits?, paneRatios?, hidden? }[], name?, startupCommand?, commitAgent?, gradients?, theme?, tourSeen?, keybinds?, layout? }` (`splits` are other presets' names); entries
missing a string `name`/`cwd` are dropped, and a leading `~` in `cwd` is expanded to the home dir **only on
read**, so the renderer gets absolute paths while the file keeps the raw `~`. The top-level `name`
drives the home tab's `Hello {name}` greeting (falling back to `snow`); `seedName()` on registration
fills it in **once** when absent by resolving the GitHub name (`gh api user`, then
`git config user.name`) and rewriting the file, so a user-set `name` is never overwritten and every
write path preserves it. `startupCommand` is the command each session's main terminal(s) run
(default `claude` in the renderer when absent); a preset may carry its **own** `startupCommand` that
overrides the top-level one for sessions opened from that preset. The chosen command is captured on
the shell tab at open time (`addSession(preset)`), **not** re-derived from `cwd` — two
presets can share a directory, so a `cwd` match would pick the wrong one. `Session` renders
`tab.startupCommand ?? startupCommand ?? 'claude'`. The home-page add-preset form takes it as an
optional field. `gradients` is a boolean (default `true` when absent)
that `useSnowconfig` exposes and `App` passes to `GitPanel` to toggle the animated per-column node
gradients on or off. `theme` is the active theme's base filename under `themes/` (see `theme.json`
above); the home-page `ThemeSelect` picker writes it through `snowconfig:setTheme`, and `theme.ts`
reads it back via `activeThemeName()` to pick which file to load.

`commitAgent` picks which CLI writes the AI commit message — `"claude"` (the default when absent or
unrecognized) or `"codex"`. It is hand-edited only, and validated as an enum rather than a free
string: a typo falls back to Claude instead of spawning a command that does not exist. `git.ts` reads
it through `activeCommitAgent()`, the second cross-config dependency on `snowconfig.ts` after
`theme.ts`'s `activeThemeName()`, and it stays acyclic for the same reason (`snowconfig.ts` imports
nothing back). It is read **per invocation**, not cached, so an edit takes effect on the next click
without a restart. See _AI commit messages_ below for what each agent is spawned as.

`layout` is an optional `{ gitWidth?, gitCollapsed?, bottomHeight?, bottomCollapsed? }` object that
persists the resizable-pane sizes across sessions (deliberately in the config, not renderer
`localStorage`, for the same reason as `tourSeen`). The renderer never mirrors it into state with an
effect: both the git panel (in `App`) and the bottom terminal (in `Session`) drive their size through
the shared `useCollapsiblePane` hook (`src/renderer/src/useCollapsiblePane.ts`), which derives
`size`/`collapsed` as `override ?? saved ?? default` — a live drag override that falls back to the
persisted config value, then a hardcoded default — so neither pane keeps a `useState` mirror seeded
from props. The hook is parameterized by `min`/`collapseAt`/`defaultSize`/`maxSize`/`persist`, which is
the only thing that differs between the two edge panes; the split-grow logic in `Session`
(`resizeSplit`, redistributing `flex-grow` between two sibling panes) is a genuinely different
mechanism and stays separate. Writes are debounced to drag **end**, not every mouse-move: `ResizeHandle`
gained an `onEnd` (fired on `pointerup`, reading the latest callbacks through an effect-updated ref, and
coalescing `onResize` to one call per animation frame) that calls `snowconfig:setLayout` with the final
size; the shared `PanelRestore` button persists its un-collapse the same way through the hook's
`restore`. Bottom-terminal layout is global (a new session adopts the last-saved size), so `App` passes
one stable `onBottomLayout` down to every `Session`. `Session` and `Terminal` are wrapped in
`React.memo` and `App` hands `Session` only stable (`useCallback`) callbacks keyed by session `id`, so a
drag on one pane doesn't reconcile the whole terminal tree.

`commands` is **per preset** — the shell-command buttons the tab bar shows to the right of its `+`.
Which buttons appear is a **union of two sources**, resolved once as `commandPresets` in `App` — the
ordered, deduped list of preset indices in scope, which everything else falls out of:

- the **session** presets — every distinct preset across `activeEntries` (the base pane plus each
  split pane, each already tagged with the `presetName` captured at open time), pushed first;
- the **adopted** preset — the one matching whichever repo the action bar currently targets
  (`activeRepo`), appended last.

`commandItems` is that list flat-mapped through each preset's `commands`, and `managePresetIndex` is
just `commandPresets[0]` — deriving both from one scan is what keeps the "session first, adopted last"
ordering from being stated twice. It cannot be read back off `commandItems`, because a preset with no
commands contributes no items but is still a valid `+` target.

Both sources resolve through `presetIndexFor`, the single preset-identity helper: it matches the `presetName`
captured at open time when there is one, and only falls back to a `presets[].cwd` match for entries
that never came from a preset (a commit or diff tab, whose `presetCwd` is just the repo). Matching on
**name, not cwd**, is what lets two presets share a directory and still get their own command buttons
— the same reason `startupCommand` and `paneRatios` are captured rather than re-derived.

The union exists because the two sources answer different questions and neither subsumes the other.
Deriving visibility from `activeRepo` **alone** silently drops a preset's commands whenever its own
cwd is not inside a discovered repo — a pane sitting in a non-git `~/projects` parent gets expanded
into its child repos, none of which contains the parent's cwd, so `presetIndexFor` returned `-1` and
the button row went empty (and `canManageCommands` went false, so the `+` could not even add one).
Keeping the adopted source is what still surfaces a child repo's **own** preset commands as you cycle
`⇄`. Session commands come first so the `runCommand` keybind (`commandItems[0]`) stays pinned to the
same command as the switcher moves; a preset appearing in both sources is deduped by `uniqueBy` and
keeps its session position. Only the **selected** repo's preset is adopted, not every discovered one,
or a `~/projects` with a dozen child repos would grow an unbounded row.

`TabBar` renders a `.tab-command-divider` wherever `presetIndex` changes between adjacent items —
buttons are 24×24 glyph-only with the command in the `title`, so without it two presets' buttons are
indistinguishable; the tooltip and the right-click Remove label are both prefixed with the owning
preset's name for the same reason. Keying the divider off the grouping already in the data (rather
than a render-only "is this the adopted one" flag) is what also separates two **session** presets, which
a session with splits from different presets puts side by side. Each item carries its own
`presetIndex` and its `index` **within that preset**, because
`snowconfig:removeCommand` is positional and a position in the union array would address the wrong
entry — the same two-index-spaces trap as `HomePage`'s `visibleEntries`. Both index spaces stay inside
`App`: `TabBar` hands the whole `CommandItem` back through `onToggleCommand`/`onRemoveCommand` and
never touches the config layout itself. Every rendered item therefore
has a resolved preset and is always toggleable; only the `+` is gated, and it is gated by
**`onAddCommand` being `undefined`** rather than a separate `canManageCommands` boolean — one prop
that both disables the button and hides the form, so the two can't disagree. `App` passes the
callback only when `managePresetIndex >= 0` — the first **session** preset, falling back to the
adopted one — so adding a command in a parent-folder pane lands on the preset you actually opened.

`TabBar` is wrapped in `React.memo`, so it re-renders only when something it shows actually changes.
That means `App` must hand it stable props: `visiblePresets` and `commandItems` are `useMemo`d and
every callback is `useCallback`d. Three of them are wrappers (`addDefaultSession`,
`openBlankBrowser`, `splitActiveBlank`) that exist because their targets take an optional first
argument and the buttons wire `onClick` straight through — passing `splitActive` as `onSplit` would
hand the `MouseEvent` to the `preset` parameter. `closeSession` reads `tabsRef`/`activeIdRef` instead
of closing over `tabs`/`activeId`, which is what lets it be `useCallback([])`; `splitActive` does the
same for the active tab. `toggleCommand` deliberately keeps `running` in its deps rather than moving
the spawn/kill into a `setRunning` updater — updaters are double-invoked in StrictMode, and that
would spawn two PTYs per click. Its identity therefore changes exactly when the `running` prop does,
so the memo is not weakened.

Each button is a **toggle**: clicking
spawns a hidden background PTY (no xterm attached) running the command in **its own item's** cwd, and
clicking again kills it — so a long-running command like `npm run dev` starts and stops from the one
button. Because the item carries the cwd, a command always runs in its own preset's directory no
matter which repo the action bar is pointed at. The command is spawned as `<command>; exit` so the
shell (and the PTY) dies when the command
finishes — both PowerShell (`-NoExit`) and the interactive POSIX shell otherwise outlive their
command, which would leave the button stuck green when the process ends on its own or is killed
externally. `App` holds the `running` map keyed by the item's `runKey`, `` `${presetName}\n${command}` `` → terminal id (so
the same command under different presets tracks independently — keyed by cwd it would collide for two
presets sharing a directory, the same trap `presetIndexFor` avoids) and passes that map straight to
`TabBar`, which reads `running[item.runKey] != null` per button — a derived array of in-scope keys
would be a fresh identity every render and an O(n·m) scan to read. A self-terminating process clears
its own button via the shared `pty:exit` listener. A command whose preset leaves scope keeps running and stays in `running`,
so its button comes back green when the preset returns. Background PTY ids come from the shared `nextTerminalId()`
(`src/renderer/src/terminalId.ts`), the same allocator `Terminal` uses, so they never collide with
pane ids.

`splits` is a **per-preset** `string[]` of **other presets' names**: opening a preset seeds one extra
top pane _beyond_ the base pane for each entry, and that pane opens in the referenced preset's own
`cwd` running the referenced preset's **own** `startupCommand` (mirroring `splitActive(preset)`).
Crucially the split pane's command resolves against the _referenced_ preset —
`p.startupCommand ?? <top-level startupCommand> ?? 'claude'` — and is set explicitly on the pane so it
never falls through to the _opening_ preset's command, which is what lets two presets with different
startup commands sit side by side. `addSession` resolves each name against the live `presets` list and
silently skips any that no longer exist, so a stale reference just drops its pane. Both open paths (`HomePage`'s preset button and the tab strip's
`+` for the default preset) pass `preset.splits` through. The home page shows a `⊞ N` badge per preset
and its right-click `ContextMenu` lists the **other** presets under an "Add split" label plus a
**Remove last split** item, backed by the `snowconfig:addSplit(presetIndex, name)` (appends the name)
and `snowconfig:removeSplit(presetIndex)` (pops the last) handlers; the file is otherwise
hand-editable like every other field.

`hidden` marks a preset that exists **only to be split into another one**: it is dropped from the home
page's preset list and from the tab bar's split menu, and survives in exactly one place — the "Add
split" list in the home page's right-click menu, which is deliberately the unfiltered `presets`. The
home-page add form sets it with an eye toggle beside the folder button.

That one list is therefore also the only place a hidden preset can be **deleted**. Every row in it is
a `.context-menu-row` wrapping the name button; a hidden preset's row also gets a close-glyph button
calling the same `removePreset(i)` the visible presets' menu uses. Nesting that button inside the name
button is not an option, hence the wrapper div rather than a modifier class. Only hidden rows get it:
a visible preset already has its own right-click menu.

Two different index spaces fall out of that, and they must not be confused. `HomePage` renders
`visibleEntries` as `{ preset, index }` **pairs** filtered on `hidden`, so every `snowconfig:*` write
still carries the **config** index — the position in the rendered list would address the wrong entry.
The positional `openPreset`/`splitPreset` digit keybinds are the opposite case: they index `App`'s
`visiblePresets` (a plain filtered array, which `App` also hands to `TabBar` so the split menu needs
no filter of its own), so the digits keep matching what the home page and the
split menu show rather than silently skipping a number over a hidden preset. Nothing else consults `hidden`: a hidden preset opened as
a split behaves exactly like any other, and its name still resolves through `presetIndexFor`, so it
keeps its own command buttons and `paneRatios`. There is no unhide handler — clearing the flag on an
existing preset is a config edit.

`paneRatios` remembers how wide those split panes were dragged, as one fraction per top pane summing
to 1. It is written on **drag end** by `Session`'s horizontal `ResizeHandle`s (the same `onEnd` the
edge panes use) from the measured pane widths, and read back by `Session` as the `flexGrow` fallback
when no live drag override exists — scaled by the pane count (`ratio / sum * panes.length`) so each
pane averages a grow of 1 and a diff split opening beside them still takes an equal share. It is
**per preset, not global** like `layout`: the ratios are a property of that preset's split
arrangement, so `App` resolves them through the `presetName` captured on the shell tab at open time
(a `cwd` match would pick the wrong preset when two share a directory, the same reason
`startupCommand` is captured rather than re-derived).

The array is only meaningful for one pane count, so both ends gate on it: `Session` ignores a saved
array whose length ≠ `panes.length`, and `App`'s `handlePaneRatios` refuses to write one whose length
≠ `1 + splits.length`. That is what keeps an ad-hoc `newSplit` pane, or a split whose referenced
preset has since been deleted, from persisting ratios the preset can never reproduce. `addSplit` and
`removeSplit` drop `paneRatios` outright, since a changed pane count invalidates it anyway.
`setPaneRatios` returns `false` when the ratios already match what is on disk, so the click-without-drag
that `ResizeHandle`'s `onEnd` also fires never writes the file — and therefore never triggers the watcher
broadcast that would re-render every window.

`tourSeen` is a boolean set once the first-run guided `Tour` is dismissed. It lives here **deliberately
instead of renderer `localStorage`**: a synchronous `localStorage.getItem` on the startup path was
observed blocking the renderer's main thread for ~5s while Chromium's DOM-Storage backend opened,
freezing first paint and interactivity. Reading it from the already-loaded snowconfig (async IPC) keeps
that off the main thread entirely — no renderer code touches `localStorage`.

Whether the tour is **showing** is derived in `App`, not stored: `showTour` is
`!tourSeen && !tourDismissed && activeTab.kind === 'shell' && repos.length > 0`, where `tourDismissed`
is the local state `closeTour` sets alongside the `snowconfig:setTourSeen` write (the config round-trip
lands a beat later). Gating on the discovered `repos` list — the same one the git view renders — rather
than on a `git:isRepo` probe of the active tab's cwd is what makes the tour appear for a pane sitting in
a **parent folder** of some repos, since discovery expands that into its children and the parent itself
is not a repo. It also means the tour appears on a `git init` under the pane, because
`git:reposChanged` refreshes `repos`. Most of the tour's spotlight targets are git-view elements, so
there is nothing to latch: with no repos in view (or on the home page) it has nothing to point at.

`keybinds` is an optional top-level `{ action: combo }` map that rebinds the app's keyboard shortcuts.
It is **hand-edited only** — a pure passthrough field like `gradients`, with no `snowconfig:*` write
handler — and any action absent from the map falls back to `defaultKeybinds`. The action set and its
defaults live in the renderer (`src/renderer/src/keybinds.ts`), not main, since main never dispatches
them: `newTab`, `closeTab` (close the active tab), `nextTab`/`prevTab` (cycle the tab strip),
`newSplit`, and `diffSplit` (open the working-tree
diff as a split beside the active session). Combo strings are `+`-joined modifier tokens plus one key — `Ctrl`/`Cmd`/`Meta`/`Alt`/`Shift`
and `Mod` (= `Cmd` on macOS, `Ctrl` elsewhere, the default in every shipped binding). A matched bind
runs on a **single, module-level capture-phase** `keydown` listener on `window`: `useCaptureKeydown` (the
shared primitive) adds each hook's handler ref to a module `registry` and attaches that one listener the
first time any hook mounts, and `dispatch` walks the registry, stopping at the first handler that reports
it handled the event (returns `true`). Capturing lets a matched handler `stopPropagation` before the
event reaches an xterm textarea, so shortcuts fire even while a terminal is focused; each handler is read
through a ref refreshed every render so the listener sees live state without re-subscribing. Handlers are
disjoint, so registry order never decides between two binds. `useKeybinds(binds, handlers)` dispatches the named
actions; only actions with a **defined** handler match, so a bind whose action is currently unavailable
(e.g. `diffSplit` on a non-shell tab) falls through to the terminal untouched. `runCommand` (default
`Mod+Shift+Q`) toggles the active preset's **first** command button (`presetCommands[0]`) through the
same `toggleCommand` path the tab-bar button uses — starting the background PTY, or killing it if that
command is already running — and its handler is `undefined` when the preset has no commands. `closeTab`
(default `Mod+Shift+W`) closes the active tab through the same `closeSession` path the tab's × uses, and
its handler is `undefined` on the home page (which has no closeable tab). `nextTab`/`prevTab` (defaults
`Mod+Shift+}`/`Mod+Shift+{` — the **shifted** characters, since `e.key` reports `}` not `]`) step
`activeId` through `['home', ...tabs]`, the tab strip's own order, wrapping at both ends; their handlers
are `undefined` when no session tabs exist, so the keys fall through to the terminal on a bare home page. `switchRepo` (default
`Mod+Shift+?`) cycles the action bar's `activeRepo` through the same `switchRepo`/`⇄` path, and its
handler is `undefined` unless more than one repo is in view. `openWorkflows` (default `Mod+Shift+O`)
opens (or focuses) the workflow manager tab; it is always available, since the screen is global rather
than scoped to whatever the active tab points at. `focusCommit` (default `Mod+Shift+M`)
focuses the action bar's commit-message `<input>`, resolved by its `.actionbar-input` class (the same
DOM-query approach the focus binds use) rather than a threaded ref; its handler is `undefined` when no
repo is in view (`actionCwd` absent). `pushRemote` (default `Mod+Shift+P`) runs the sync button's
`git:sync` (push) action, but only when there is something to push up — its handler is `undefined`
unless `ahead > 0` (local commits to push) **or** `!tracking` (an unpublished branch to publish), and
the sync action is otherwise runnable, mirroring when the sync button pushes rather than
fetches/pulls. It is registered inside **`ActionBar`**, not `App` (which is why `App` passes
`keybinds` down to it), because the `ahead` count and `sync` action live there — `App` only has the
DOM-query binds and never sees git status.

`focusLeft`/`focusDown`/`focusUp`/`focusRight` (default `Mod+Shift+H`/`J`/`K`/`L`, vim directions) move
keyboard focus between a session's terminals. They are owned by **`Session`**, not `App`, because the
geometry lives there: a session is a row of top split panes (`.terminal-main > .terminal-split`) above a
single bottom shell (`.terminal-secondary`). `H`/`L` step left/right through the top panes, `J` drops
from a top pane to the bottom shell, and `K` returns from the bottom shell to the last top pane it left
(tracked in `lastTopRef`, defaulting to the first). It resolves the focused pane by walking up from
`document.activeElement` and focuses the target by its xterm `.xterm-helper-textarea`, so no imperative
handle has to be threaded through `Terminal`. `Session` registers these only while `active` (passing
`{}` otherwise), so exactly one mounted session responds even though all stay mounted.

`splitPreset` and `openPreset` are the odd ones out — **positional** families rather than single combos.
Each config value is a modifier prefix (defaults `Mod+Shift` and `Mod+Alt`, resolved inside the hook off
`defaultDigitModifiers`); `usePresetDigitKeybind(binds, action, onPreset)` matches `<modifier>+<1-9>` and
calls `onPreset(n-1)` (one-based key → zero-based preset index),
no-opping when that index is empty. The digit is read from `e.code` (`Digit1`/`Numpad1`), not `e.key`,
because `Shift+1` reports a punctuation `key` on most layouts. Each reuses `useCaptureKeydown` (joining the
same shared registry) rather than the named-action map, since the digit is derived from the event, not
looked up per action; `modifiersMatch` is exact, so `Mod+Shift+1` and `Mod+Alt+1` never collide. `App` owns both:
`openPreset` always **opens** the nth preset as a new session (`addSession(preset)`),
from any tab. `splitPreset`'s target depends on the active tab — **on the home page** it opens the nth
preset (same as `openPreset`); on a **shell** tab it _splits_ the active session with that preset; on any
other tab its handler is `undefined`, so those keys fall through. The named binds `newSplit`/`diffSplit`
likewise gate on `activeTab.kind === 'shell'`. All handler sets are disjoint, so the capture listeners
coexist harmlessly.

Every write handler goes through `mutateConfig`, which owns the read → error-bail → write sequence and
hands the callback the whole parsed config (`{ presets, name, startupCommand, gradients, theme, tourSeen, keybinds, layout }`), so
passthrough fields are structural — no write path can drop a top-level field. The callback returns
`false` to abort without writing (bad index, missing preset). Beyond `snowconfig:get` it exposes write
handlers — `snowconfig:addPreset`, `snowconfig:setDefault(index)` (index `-1` clears the default),
`snowconfig:removePreset(index)`, `snowconfig:addCommand(presetIndex, command)`,
`snowconfig:removeCommand(presetIndex, index)`, `snowconfig:addSplit(presetIndex, name)`,
`snowconfig:removeSplit(presetIndex)`, `snowconfig:setPaneRatios(presetIndex, ratios)`,
`snowconfig:setTheme(name)` (empty clears it back
to the default `theme`), `snowconfig:setTourSeen()` (marks the tour dismissed), and
`snowconfig:setLayout(patch)` (merges the given keys into `layout`) — that mutate the parsed config and rewrite the file;
the fs.watch broadcast then keeps every window in sync. `presetForDir` (see _The `snow` command_)
is the one write path that is not an IPC handler: main calls it directly for a folder passed on the
command line. `useSnowconfig` (`src/renderer/src/useSnowconfig.ts`) is the single subscription;
`App` reads it so the tab strip's `+` button opens the `default` preset's cwd (home dir if none), and
`HomePage` renders each preset with a default checkbox (radio-like via `setDefault`) plus an add
form. Both `HomePage` and `TabBar` delete entries through the shared `ContextMenu` component
(right-click → Remove). Opening a preset calls `App`'s `addSession(preset)` — the whole `Preset` is the
unit, so every open path (`HomePage`, the tab strip `+`, the `newTab`/`openPreset`/`splitPreset`
keybinds) shares one signature — which seeds the session's cwd (so git/tab-label are correct before the
shell's first OSC 7) and passes it to both terminals' spawn.

## Agents (Claude and Codex)

Both agent-facing features — the AI commit message and the usage meter — support **Claude Code and
Codex**. They are separate mechanisms and do not share a selector: the commit message runs whichever
one `.snowconfig`'s `commitAgent` names, while the usage meter always reports both, because cost is
observed after the fact rather than chosen.

### AI commit messages

`git:generateCommitMessage` builds the prompt and diff exactly as before, then hands them to
`runCommitAgent(agent, input)`. The per-agent differences live in one `commitAgentSpecs` table
(`command`, `timeoutMs`, `args`, `read`) so the spawn/timeout/stdin plumbing in `spawnCommitAgent` is
written once; the error strings interpolate `spec.command`, so a failure names the CLI that actually
ran rather than always saying "claude".

- **claude** — `claude -p --disallowedTools …`, message read from **stdout**.
- **codex** — `codex exec … -` , message read from the file passed to `--output-last-message`.
  Reading stdout would not work: `codex exec` prints a session banner, the turn log, and a token
  count around the message, so the file is the only clean channel. A missing file reads as empty,
  which surfaces as the ordinary "returned an empty commit message" error instead of an ENOENT.

Three codex flags are load-bearing. `--skip-git-repo-check` is required because the child runs in
`os.tmpdir()`, which is not a repo (the diff arrives on stdin, so it never needs the worktree).
`--sandbox read-only` matches the intent of Claude's `--disallowedTools` list — writing a commit
message needs no tools. `-c model_reasoning_effort=low` overrides the user's `config.toml` **for this
one invocation**: the task is mechanical, and at the default effort a large diff costs seconds and
cents per click. Codex still gets `timeoutMs * 2`, since its floor is a full agent turn rather than a
single completion.

On Windows both CLIs are `.cmd` shims, so the child is spawned with `shell: true` — and Node does not
quote arguments in shell mode, so `spawnCommitAgent` quotes any argument containing whitespace. That
is not hypothetical: the `--output-last-message` path goes through `os.tmpdir()`, which sits under the
user's profile and contains a space whenever their account name does.

### Usage cost

`src/main/usage.ts` estimates spend **since snow started** (`sessionStart`) by reading each CLI's own
session logs — nothing is ever sent anywhere to price it. One `sources` table drives everything: an
agent name, a directory, and a parser.

- **claude** — `~/.claude/projects/**/*.jsonl`, priced from `message.usage` at Anthropic rates
  (separate 5m/1h cache-write tiers, cache reads at 0.1×).
- **codex** — `~/.codex/sessions/**/*.jsonl` (rollout files, nested by date), priced from
  `payload.info.last_token_usage` at OpenAI rates (cached input at 0.1×).

Codex needs two things Claude does not. Its events carry no model, so the parser tracks the most
recent `payload.model` — emitted by `turn_context`, which always precedes that turn's `token_count`
events — and an unresolved model prices at zero rather than guessing. And `last_token_usage` is a
**per-turn delta** while the sibling `total_token_usage` is cumulative, so summing the deltas is what
avoids counting every turn again on each subsequent event. Codex entries therefore carry the `':'`
key, the existing "never dedup" sentinel, since a rollout file has no request id and each event is
already counted once; Claude entries keep their `id:requestId` dedup, which is scoped per source.

Files are cached on `mtimeMs:size` and skipped entirely when older than `sessionStart`. Directory
listing is one recursive `readdirSync`, which handles Claude's one-level and Codex's date-nested
layouts without encoding either depth. A missing root is not an error — the common case is simply not
having one of the two CLIs installed — so only a non-`ENOENT` failure sets `error`.

`UsageResult` reports `agents` (per-agent cost) alongside `session` (their total), so the meter stays
one number and the tooltip names the split only when both are non-zero. The watcher is per source and
**never creates a root whose parent is absent**: a machine without Codex does not get a `~/.codex`
directory conjured by snow, but one that has it gets the watcher attached so the meter comes alive
the first time Codex writes.

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

## The `snow` command

`src/main/cli.ts` owns both halves of it: what the app does with `process.argv`, and the shim that
puts `snow` on `PATH` in the first place.

`startCli()` is the **first** statement in `index.ts` — above `initLogging()`, since a process that
is about to exit should not open (and possibly roll) the shared log file. It returns `false` when
this process must not become an app, which `index.ts` turns into `app.exit(0)`: `--help`/`--version`
print and leave, and a packaged second instance hands its argv to the running one. The flags are
checked **before** the instance lock, so `snow --help` still answers while a window is open.

The single-instance lock is taken **only when packaged**. In dev it would mean `npm run dev`
silently handing off to an installed snow instead of opening a dev window — the two share a
userData path, which is what the lock is keyed on.

Argument parsing never slices argv by position: Electron hands `second-instance` a different shape
than the launching process (Chromium's own flags, `--original-process-start-time`, and in dev the
app path). So `folderArg` takes the first argument that is neither a flag nor `app.getAppPath()`,
and resolves it against the _reporting_ process's directory — `process.cwd()` at launch,
`workingDirectory` for a second instance, so `snow .` means the shell's directory either way.

A folder becomes a preset in `presetForDir` (`snowconfig.ts`, since it owns `mutateConfig`): an
existing preset whose `cwd` is `samePath` wins, otherwise a new one named after the basename
(`-2`, `-3` … on a name collision) is appended. It returns the whole `Preset`, not its name, and
that object is what both `cli:pending` (consumed once, so a renderer reload does not reopen it) and
the `cli:open` broadcast carry. **Load-bearing**: the config watcher's `snowconfig:changed` lands
~100 ms after `cli:open`, so a renderer looking a name up in its `presets` would miss a
just-created preset entirely. `App` still prefers its own copy when it has one
(`presets.find(…) ?? preset`), which is what keeps a `splits` preset opening its splits; the startup
pull is gated on `presets.length > 0` for the same reason (a corrupt config yields no preset to
lose, since `presetForDir` bails on a read error).

#### `snow theme <url> [name]`

The other verb. `runArgs` dispatches on the first positional being `theme` **with at least one more
argument**, so a bare `snow theme` still means "open the `./theme` directory" and the verb never
shadows a real folder of that name. Everything else falls through to the folder path unchanged, and
both entry points — startup argv and `second-instance` — go through the one `runArgs`, so the command
works whether or not a window is already open.

`themeInstall.ts` owns the download, keeping argv/PATH concerns in `cli.ts` and theme-file concerns in
`theme.ts`. Sources must be `https:`; a `github.com/<owner>/<repo>/blob/…` URL is rewritten to
`raw.githubusercontent.com`, since pasting the page URL is the obvious thing to do and it returns
HTML. The name comes from the URL's `.json` basename (sanitized to `[A-Za-z0-9_-]`) or from the
optional second argument, and a URL whose last segment is **not** a `.json` file refuses to guess
rather than naming the theme after a directory. An existing file of that name is never overwritten
without `--force`, which is what keeps two remote themes whose names sanitize to the same local one
from silently clobbering each other.

Downloaded JSON is checked by `validateTheme`, which is deliberately **stricter than `mergeColors`**.
`mergeColors` degrades per key so a hand-edit can never break the running app; a download has no
author present to notice, so a malformed value is a refusal instead. The split is between values and
keys: a missing **section** or a non-hex value is an error and nothing is written, while a missing
**key** installs and is reported as `Using defaults for: …`. That asymmetry is what keeps a theme
published against an older snow working the moment a new key is added, while still rejecting an
unrelated JSON file — which under a keys-optional rule would install happily as an all-defaults theme.

Install writes the file and then activates it through `setActiveTheme`, the non-IPC path into
`mutateConfig` (the same shape as `presetForDir`, and now also what the `snowconfig:setTheme` handler
calls). Write order does not matter: the `themes/` watcher re-reads the **active** theme, so the file
write is a no-op broadcast, and the `.snowconfig` write is what the renderer's `themeStore` picks up
on `snowconfig:changed`.

**The shim detaches, so the command cannot print.** Both `start ""` and `nohup … &` discard stdout,
and a packaged Electron app on Windows has no console attached in the first place — so results go to
`snow.log` and to the window. Success is self-evident (the app recolors); a failure broadcasts
`theme:installed` with an `error`, which `App` renders in the shared `FailureDialog`. That is why the
CLI surface is an action rather than a query: a `list` verb would have nowhere to print.

`installCommand()` is the PATH shim, and it runs itself — on every start, from `registerCliHandlers`,
with **no UI at all**. `commandState` decides: `install` and `update` (the shim points at a
different copy of the app, i.e. it moved or updated) write the file; `path` (written and current,
but its directory is not on `PATH`) only logs, since the fix is not snow's to make; `ready` returns
silently. `ready` is also what installs that already provide the command produce — scoop, the
`.deb`'s `/usr/bin/snow` symlink from electron-builder's after-install script, the snap — because
`alreadyOnPath()` finds a `snow` there and snow must never shadow it. (`linux.executableName: snow`
in `electron-builder.yml` is what makes that symlink's name match.) The whole thing is gated on
`app.isPackaged`, or a dev run would repoint the user's `snow` at a working tree.

The shim is `~/.local/bin/snow` (`nohup … &`, so a terminal launch returns the prompt and survives
the terminal closing) or, on Windows, `%LOCALAPPDATA%\Microsoft\WindowsApps\snow.cmd` (`start ""`) —
that directory is on the user `PATH` by default on Win10/11, which is what makes a zero-click
install actually reachable; `%LOCALAPPDATA%\snow\bin` is the fallback when it is not. The target is
`process.env.APPIMAGE ?? process.execPath` — an AppImage's `execPath` points inside a temporary
mount that is gone by the next boot — plus `app.getAppPath()` when unpackaged. snow never edits
`PATH` itself: mutating a user's environment behind their back is worse than a log line naming the
directory to add.

## Windows taskbar identity

snow deliberately **does not** call `electronApp.setAppUserModelId`. The electron-vite scaffold ships
that line (with `'com.electron'`) and it is tempting to restore with the real `appId` — don't, it is
what breaks the taskbar icon on scoop and `.zip` installs.

Setting an AUMID makes Windows resolve the taskbar button through that id instead of through the
process, and when **no shortcut** on the machine declares the same id there is nothing to resolve to,
so the button loses its icon. Only the NSIS installer stamps the id onto the shortcuts it writes;
scoop builds its shortcut with `WScript.Shell`, which cannot set the property at all, and a bare
`.zip` has no shortcut. The window icon and the icon embedded in the exe are both set in every case —
neither is what the taskbar reads.

With no AUMID set, Windows falls back to the implicit path-derived identity: the button resolves to
the exe and takes its embedded icon, which every distribution shape has (electron-builder generates
the `.ico` from `build/icon.png`, 256×256 being its threshold). Installed builds do not regress,
because the shell propagates a shortcut's `System.AppUserModel.ID` into the process it launches — an
NSIS install gets its identity from the shortcut electron-builder already stamps with `appId`, which
is what made those builds work all along. The runtime call was never load-bearing. Note that
`@electron-toolkit/utils` reaches the same conclusion in dev, where it passes `process.execPath`
instead of the id.

Nothing in snow consumes an AUMID — no `Notification`, no `setJumpList`, no `addRecentDocument`, no
`setUserTasks`. Windows toast notifications are the thing that would need one, plus a shortcut
declaring it; adding them means revisiting this, and on NSIS installs the propagated id would already
serve. The other cost is that a Start-Menu launch and a `snow` CLI-shim launch no longer share one
taskbar group, which is moot while packaged snow holds a single-instance lock.

## Windows long paths

Every git command snow runs carries `-c core.longpaths=true` on win32, via the `gitOptions` object
that both `gitFor` and the scratch-index `simpleGit` pass to their constructor. Without it Git for
Windows refuses any path over 260 characters, and what blows the budget is the repo's **own** deep or
long-named files — a `node_modules` chain, a generated fixture, any long filename. **Worktree
workflows are the case that hits it first** because promotion shifts every one of those paths
outward: `worktreeDirectory` puts the checkout at `<repo>-worktrees/<branch>` (plus a seven-character
digest when the branch name had to be sanitized — see _Workflows_), deeper than the repo's
own root by `len('-worktrees') + 1 + len(branch)`. That overhead is fixed and unavoidable (the branch
is never truncated, so a long branch name only makes it worse), so a repo sitting comfortably under
the limit at its own root can cross it purely by being promoted, with `unable to create file …:
Filename too long` followed by `Could not reset index file to revision 'HEAD'`. `git worktree add` is
atomic across that failure (git 2.50 leaves no directory and no `.git/worktrees` bookkeeping), so the
launch merely fails rather than stranding the workflow — but nothing short of the flag makes it
succeed.

The flag lifts the **total path** limit, not Windows' 255-character limit on a single path
_component_. The two are distinguishable by git's own wording and it is worth reading before
assuming this section applies: a total path over 260 fails with `Filename too long` and the flag
fixes it, while a single filename over 255 fails with `Invalid argument` and the flag does nothing.
Only a repo carrying such a name (committed on a filesystem that allowed it) can reach the second
case, and no snow-side change helps.

The flag belongs on `gitFor` rather than on the `worktree add` call, because the whole family of
write paths hits the same limit: the `stash pop` promotion runs right after, `parkOnLeave`'s
`stash push -u` and `restoreOnEnter`'s pop, and `worktree remove --force` on the way back out.
Removal is the one that punishes a partial fix — it deletes its bookkeeping even when it cannot
delete every file, so a failed remove leaves a directory that every retry answers with `is not a
working tree` (which is exactly why `demote` clears the registry entry in its `catch`).

snow does **not** write `core.longpaths` into the user's repo or global config. `-c` is per
invocation, so it changes what snow's own commands can do and nothing else — the same reason snow
never edits `PATH` itself. A shell in the promoted worktree still gets stock git behavior.

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

**A promoted worktree is the exception, and it refuses rather than parks.** Its directory is
recorded in the registry against one branch, so checking anything else out there would leave the
entry pointing at a directory that no longer holds its branch — which reads back as `worktreeLinked:
false`, renders as a **stale** row, and invites a prune that silently demotes a live session.
`registryFor` therefore returns the branch that **owns** the current worktree alongside the parkable
list (one registry read answers both), and `ownedElsewhere` turns a mismatch into an ordinary failed
switch naming the owner. It is checked in `switchBranch` before `parkOnLeave`, so every path that
routes through it inherits the guard, and again in `git:createBranch`'s `carry: true` branch, which
is the one switch that deliberately bypasses `switchBranch` entirely. Parking inside a worktree is
what the guard makes unnecessary: `parkableBranches` never listed worktree-mode records, so the
branch in a worktree was silently exempt from parking and its work rode along to whatever you
checked out next.

`git:createBranch` is the other exception, because `checkout -b` branches from HEAD and so **cannot**
fail on a dirty tree — parking there rescues nothing and only contradicts what git would do. It takes
a `carry` flag: `carry: false` routes through `switchBranch` (park on the branch you are leaving),
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
like `.snowconfig` does for `cwd`. Both directions go through `config.ts`'s `samePath` /
`collapseHome` (shared with `snowconfig.ts`'s CLI preset lookup, which is why they live beside
`expandHome` rather than in `registry.ts`): `samePath` resolves and slash-normalizes before
comparing, case-insensitively on win32 — necessary because `git rev-parse --show-toplevel` emits
forward slashes while `os.homedir()` and `path.resolve` use backslashes. `addRecord`/`removeRecord` re-read first and **bail if the read errored**, so a
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
branch tracks `origin/<default>`, and `git:sync` would take its `status.tracking` path and push
a feature branch at the default branch's upstream. `restoreOnEnter` is a no-op on the way in, since
the new name is not registered until `addRecord` runs after the checkout — except when the registry
still holds an entry for a branch of that name that was since deleted, where re-creating it recovers
the parked stash that `WorkflowSelect` was already showing as a missing-branch row.

`switchBranch` is the only park entry point `git.ts` exports; `parkOnLeave`, `restoreOnEnter`,
`rollbackPark`, `parkPlan`, and `registryFor` are module-private so no caller can take half the
gate. The one other export is `unparkBranch`, which takes a branch's newest marker stash back out —
`workflow:demote` needs it to undo its own park when the worktree removal it parked for then fails.

**Every pop goes through `popStash`, which pops `--index` first.** A plain `git stash pop` restores
everything as unstaged work, so a deliberately staged subset — the whole point of the diff view's
Stage buttons — silently loses its staging across a park and restore. `--index` keeps it. The one
failure it adds is recoverable and is the only one retried: when the index cannot be reinstated git
prints `conflicts in index. Try without --index.` and bails **before touching the working tree**,
leaving the stash listed, so a plain pop can safely follow. Any other failure falls through to the
existing classification (conflicted paths, untracked collision, or the raw error) untouched, because
those leave state a blind retry would double-apply.

Every path rolls the park back through `rollbackPark()` if the checkout fails, so a failed call
leaves the tree exactly where it started. A conflicting pop is reported like `git:updateFromDefault`
does — conflicted paths in `detail`, stash kept. When `rollbackPark` _cannot_ put the work back —
either the pop failed or the marker stash is no longer listed — it appends recovery instructions to
`detail` rather than returning the bare checkout error, since otherwise the tree would come back
empty with nothing on screen explaining where the changes went.

Snow never drops a stash. `workflow:unregister` only removes the registry entry; any parked work
stays in `git stash` and the dialog says so.

**`workflow:demote` pays its destructive costs only once it knows they are needed, and undoes them
when they were not enough.** Killing the user's shells is the irreversible half of stopping a
workflow — a pane may be running an agent session — and it is needed only on Windows, where an open
shell holds the directory against `worktree remove`. So the removal is attempted **first**, with the
session still running; only if that fails and `stillLinked` confirms nothing was removed does it
call `closePtysInDirectory` and retry. If the retry also fails, the park is rolled back through
`unparkBranch`, because leaving the work in the stash would empty a worktree that is still very much
alive. The result carries `worktree` — which is what makes the renderer close the tab — only when
terminals were actually closed, so a first-attempt failure leaves the session untouched entirely.

`closePtysInDirectory` matches on each PTY's **live** directory, not its spawn cwd. `pty.ts` tracks
it by scanning the same OSC 7 reports `shellSpec` emits every prompt (the renderer parses them too,
for tab labels, but main cannot reach that). Matching the spawn cwd alone missed the exact case the
function exists for: a shell started elsewhere that `cd`s into the worktree holds it just as firmly.
A report split across two PTY chunks is simply skipped, since the next prompt re-sends it.

`.snowignore` is deliberately not consulted: it is a commit filter, not a worktree filter, so a
matched-but-modified file parks and restores unchanged.

Parked file counts are `git stash show --name-only` plus `git ls-tree -r --name-only <sel>^3` (the
untracked parent, absent when nothing untracked was parked) rather than `git stash show -u`, which
needs git ≥ 2.32. The missing `^3` is the expected case and counts as zero, but a failed _tracked_
listing yields `null`, not `0` — a marker stash always has content, so "0 files parked" would be a
lie. `WorkflowSelect` renders `null` as `● ?`. `WorkflowParked.count` carries how many marker
stashes the branch has, so the duplicates a conflicting pop leaves behind are visible as `● N ×2`
rather than being true-but-invisible; the tooltip explains that snow restores the newest and the
rest are still in `git stash list`. No git watcher is added: stash writes touch `.git/refs/stash` and
`.git/logs/refs/stash`, already covered by `git:watch`.

Both `WorkflowSelect` and `WorkflowManager` reload on `workflow:changed` unconditionally, but filter
`git:changed` by **`repoScope`** — the repo root plus every worktree path in the list. Describing a
workflow list costs two git processes per entry (`stash show` and `ls-tree`) on top of four fixed
ones, and `withRepoLock` broadcasts on every mutating handler in every open repo, so an unfiltered
subscription turns a commit in an unrelated repo into a process storm. The worktree paths are part
of the scope because a repo's linked worktrees live outside its root yet share its stash — filtering
on the root alone would miss every change made in a parallel session. `WorkflowList` carries `repo`
(the main worktree root) purely so the renderer can compute that scope without a second IPC.

`WorkflowSelect` sits beside `BranchSelect` in `.actionbar-right`. The two share one dropdown
vocabulary — the chrome classes in `main.css` are named `picker-*`, not `branch-*` — and
`WorkflowSelect` adds only `workflow-*` rules for the parked badge, the missing-branch row, the
register button, and the remove button. Its button reads the branch name when that branch is a
registered workflow and a neutral "Workflows" when it is not.

#### The workflow manager

`WorkflowManager` is a **tab kind** (`{ kind: 'workflows' }`), opened from the tab-bar button, the
`openWorkflows` keybind, or the dropdown's "Manage workflows…" row — all three route through `App`'s
one `openWorkflows`, which focuses the existing tab instead of minting a second. It is the only
surface that is not scoped to a cwd, which is exactly why it exists: `workflow:list` needs an open
repo, so a repo with no tab open is invisible everywhere else.

`workflow:overview` is that unscoped read. It groups `readRecords()` by `samePath`'d repo and
describes each through the **same** `describeWorkflows` the cwd-scoped `workflow:list` uses — one
enrichment path, so a row cannot read differently in the two places. A repo whose directory has
moved or been deleted comes back `unreachable: true` with its branches listed as non-existent rather
than being dropped, since the registry entry is still there and removing it is the only fix. Repos
listed are **exactly** the registry's, never presets or discovery: a repo appears once you register
a workflow in it, which keeps the screen's contents equal to what parking and restoring actually
act on.

`worktreeDirectory` replaces the characters a path cannot carry, which collapses distinct branches
onto one directory — `feature/login` and `feature-login` both want `feature-login`. It appends a
seven-character SHA-1 of the original name **only when sanitizing actually changed something**, so
path-safe branches keep reading plainly and the two cases stay apart. Promoting onto a non-empty
directory is still refused rather than checked out over, and the message now names the branch and
says what to do, since the path alone reads as unrelated to the workflow that produced it.

**Launch** is the screen's verb, and it resolves per row: a usable worktree opens (or focuses) its
tab, the branch checked out in the main worktree opens a tab on the repo root, and a park-mode
workflow is **promoted first** — `git worktree add`, then the tab. Launching is the one place that
creates a worktree implicitly, because "run these three branches at once" has no other meaning in
park mode. A launched tab inherits the preset whose `cwd` lives inside that repo (shortest match, so
a preset on the root wins), which is what carries `startupCommand` and `presetName` over so the tab
keeps its command buttons; `openWorktree` takes that repo as an optional second argument and falls
back to inheriting from the active tab when it is absent, since a launch from the manager has no
meaningful active session to inherit from.

**Launch all** is that loop, sequentially and to the end. It never stops at the first failure and
never rolls back: promotions are serialized by `withRepoLock` anyway, and a branch that cannot start
(directory already there, branch checked out elsewhere) says nothing about the others. Failures are
collected and reported **once**, as a single `FailureDialog` titled "Launched N of M workflows"
listing each branch and its reason, rather than one dialog per branch.

Every mutating action runs through the shared `useGitAction`, whose single `pending` disables every
button on the screen — the same "one git action at a time" shape `WorkingDiffView` uses — and whose
`onSettled` bumps the reload key. `RemoveWorkflowDialog` and `StopWorkflowDialog` are shared with
`WorkflowSelect` rather than reimplemented: the copy is the load-bearing part (what stays in the
stash, what gets deleted), and two surfaces wording it separately is how they drift. Extracting them
also moved both onto `GitDialog`, so they now close on Escape like every other dialog. The
vocabulary they share with `WorkflowSelect` — `usable`, `staleTitle`, `parkedTitle`, `parkedStay`,
`stateSlug`, `parkedBadge`, `repoScope` — lives in `workflowText.ts` for the same reason.

`RemoveWorkflowDialog` renders a **second, buttonless form** when `usable(entry)`, because
`workflow:unregister` refuses outright while the branch's worktree is still linked. Promising a
removal in the dialog and answering with a failure dialog is the drift the shared component exists
to prevent, so the refusal is stated where the user is deciding, pointing at the pause button that
actually unblocks it.

`stateLabel` returns prose, so `WorkflowManager` slugs it through `stateSlug` before interpolating a
class name — `checked out` would otherwise emit `wfm-state-checked` plus a stray global `out`, and
the badge would go unstyled because no rule matches the half-name.

## Session tabs

`App.tsx` owns the tab model: `sessions` (each `{ id, cwd? }`), `activeId` (`number | 'home'`), and a
per-session `cwds` map fed by each session's bottom-terminal OSC 7. The active session's terminals
drive a **set** of repos that `ActionBar` and `GitPanel` share (see _Multi-repo git view_ below).
`Session` renders the Claude
(top) + shell (bottom) pair; all sessions stay mounted and inactive ones are hidden with
`display:none` so their PTYs survive tab switches (they die only on close/unmount). `Terminal` takes
an `active` prop and re-fits via `requestAnimationFrame` on activation; its fit/resize is guarded on a
non-zero container size so a hidden (0×0) pane is never shrunk to `FitAddon`'s minimum columns.

Tabs are **reorderable by dragging** one onto another. `TabBar` owns the drag (HTML5 `draggable` on
each tab), tracking `{ from, over }` where `over` is an insertion **slot** in `[0, n]` picked from
which half of the hovered tab the pointer is in; `insertAt` collapses the two no-op slots
(`from` and `from + 1`) to `null`, so both the drop indicator and the drop itself are gated on one
value and a drag that changes nothing never writes state. `App.reorderTab(from, to)` splices `tabs`,
converting the slot to an index (`to > from ? to - 1 : to`).

### Repo tab groups

Every tab that has a directory belongs to a **repo group**, keyed on that directory's
`mainWorktreeRoot` (the repo-wide identity behind the `withRepoLock` key and every registry lookup
too; it answers with the current worktree's own top level whenever the git dir _is_ the common dir,
falling back to `dirname(common)` only for a linked worktree — taking `dirname` unconditionally
names an unrelated directory under `--separate-git-dir`) — so a linked worktree's tab groups with
the repo it was cut from rather than
standing alone, which is the whole point of grouping a parallel session next to its parent. `App`
resolves the key per distinct tab cwd through `git:mainRoot` (a one-`rev-parse` handler) and caches it
by cwd, because discovery only ever runs for the **active** tab and grouping needs an answer for all
of them. The cache is dropped and re-resolved on `git:reposChanged`, so a `git init` or `rm -rf .git`
under a pane regroups it; the resolution effect keys on the joined cwd list plus that epoch, and reads
the cache through a ref so it never re-runs on its own writes. An unresolved (or non-repo) cwd is
simply ungrouped until the answer lands.

Grouping is **enforced, not merely drawn**: `regroupTabs` pulls every tab of one repo back next to the
first tab of that repo, so a group can never end up interleaved. It is a derived order
(`orderedTabs`), not a `setTabs` correction — deriving keeps a group from fighting a drag mid-gesture
and cannot loop. `tabs` stays the raw array; the tab strip, `cycleTab`, `closeSession`'s neighbor
pick, and `reorderTab` all work in the regrouped order, and `reorderTab` writes that order back so a
later regroup is a no-op. Tabs with **no** repo (browser tabs, the workflow manager, a shell outside
any repo) keep their place instead of being herded to one end, so they can sit between groups.

`TabBar` therefore constrains the drop rather than accepting any slot: a grouped tab may only land
within `[first, last + 1]` of its own group, and an ungrouped tab may land anywhere except strictly
inside a group's run. Both cases resolve to `insertAt === null`, which already suppresses the drop
indicator and the drop itself — a refused drop shows nothing rather than snapping back.

The color is `repoColor(key, lanes)` — an FNV hash of the normalized root into the theme's existing
`git.lanes` palette. Hashing (rather than handing colors out in open order) keeps a repo the same
color across restarts, at the cost of two repos occasionally sharing a lane; the divider between
groups is what keeps those legible. `TabBar` reads `lanes` from `useGitColors` itself, so `App` passes
only the group key and the whole strip recolors with the theme. `WorkflowManager` colors each repo
card off the same function, so a card and its tabs match.

The pane stack is deliberately rendered from **`mountedTabs`** — `tabs` sorted by `id`, an order
reordering can never disturb — not from `tabs`. Keyed reconciliation moves a reordered child with
`insertBefore`, which detaches and reattaches the node, and that resets `.xterm-viewport`'s
`scrollTop`: every open terminal would jump to the top of its scrollback on a drag. Since only the
active pane is visible, the stack's DOM order carries no meaning, so pinning it costs nothing.
Browser tabs are unaffected either way — their content is a main-process `WebContentsView` positioned
by bounds, not a DOM node.

### Multi-repo git view

The active tab can touch more than one repo — its base cwd plus each split pane's live cwd. `App`
builds `repoEntries` (`{ cwd, presetCwd, presetName }`, deduped by cwd via `uniqueBy`) from the active tab, joins
their cwds into a stable `discoverKey`, and runs **one** `git:discover` per cwd, merging the results
(deduped by `repo.path`) into a single `repos` list. Keying the effect on the serialized `discoverKey`
rather than the array identity is load-bearing: `repoEntries` gets a fresh identity whenever `cwds`
changes, so depending on it directly would re-discover on every shell prompt. `handleSessionCwd`
narrows that at the source — it returns the previous `cwds` unchanged when the reported directory
already matches, the same guard `handleSessionStatus` uses — so an OSC 7 report that says nothing new
(the common case, since the shell re-reports on every prompt) costs no render at all. `discover` returns
canonical worktree-root paths and expands a non-repo parent directory into its child repos, so a pane
sitting in a `~/projects` folder surfaces every repo under it.

#### Rediscovery (`git:watchRepos`)

Discovery is a snapshot, so a `git init`/`clone`/`rm -rf .git` under a pane's cwd would otherwise need
an app reload to show up. Alongside each `git:discover` the same effect registers a
`git:watchRepos(cwd)` and reloads on `git:reposChanged`. This is a **different watcher from
`git:watch`**: that one needs a `.git` to exist (it bails when `gitDir` is null) and reports content
changes _within_ a repo; this one watches the directory for the repo itself appearing or disappearing.

It watches `cwd` non-recursively, plus each immediate child directory (capped at
`maxDiscoveryChildren`) when `cwd` is **not** itself in a repo — the child watchers are what catch a
`git init` inside a `~/projects`-style parent, and they are dropped the moment `cwd` becomes a repo,
since discovery stops looking at children then. Only `rename` events are accepted: creating or
deleting `.git` is always a `rename`, while `change` on `.git` fires for every write _inside_ it (git
touches the directory constantly), so accepting `change` would mean re-running discovery throughout
any git operation. On a repo cwd the filter narrows further to `.git` itself; on a non-repo cwd any
`rename` is accepted, because a new child directory (a fresh clone) has an arbitrary name and needs a
watcher of its own — the rebuild is what attaches it.

Events are debounced, and the handler broadcasts only when the discovered root list actually
**changes**, so the noisy non-repo case costs a `discoveryState` call and nothing downstream.
`discoverRepos` is a thin wrapper over `discoveryState`, which returns `{ root, repos }` — the watcher
needs `root` to decide whether to watch children, and re-deriving it would mean a second
`git rev-parse` per check. Registrations are refcounted per `(webContents, cwd)` like `git:watch`, torn
down with it in `closeWatchersFor`/`disposeGitWatchers`, and the async setup re-checks that its record
is still the live one before attaching, so a fast unwatch/rewatch can't leak an orphaned watcher.

#### `git:changed` is not left to the filesystem alone

`fs.watch` is best-effort, so it is the **second** source of `git:changed`, not the only one.
`withRepoLock` fires the watcher's own `notify()` for the repo it just unlocked, which means every
mutating handler — every path that takes the lock — announces itself when it settles, whether or not
the OS reported the writes. Each watcher handle carries the `root` it covers (derived exactly like the
lock key, so a linked worktree and its main worktree notify each other) and its `notify`, and the
broadcast still goes out under that watcher's own `cwd` and its own debounce, so the payload the
renderer filters on is unchanged and the explicit call coalesces with whatever `fs.watch` did report.

Without it a switch is only as reliable as the watcher: a `git:changed` that lands mid-checkout reads
the pre-switch HEAD (reads deliberately don't take the repo lock), and the display is then correct only
because a **later** event arrives — `useLatestRun` orders reads by start, so it drops the stale one but
cannot conjure a fresh one. On a slow machine, where a park + checkout + pop is a seconds-long burst,
losing that trailing event left the branch name stale with nothing to correct it. An errored watcher is
re-armed (`maxWatchRetries` attempts, `watchRetryMs` apart) and notifies on the way down rather than
closing for good, since a watcher that dies silently is exactly that failure with no recovery.

That one `repos` list is the single source of truth for the whole git view. It is passed straight to
`GitPanel` — now a **pure renderer** that no longer discovers; it lists every repo as an accordion,
with `.git-repo-open` giving the expanded section the scroll space — **and** it drives `actionRepos`,
the action bar's repo set. `actionRepos` re-associates each discovered root with a preset by finding
the `repoEntries` entry whose cwd lives inside that root (slash-normalized prefix match) and carrying
its `presetCwd`/`presetName`, so preset command buttons still resolve for the repo you opened. A
parent-expanded child that no pane owns falls back to **adopting** a preset whose own `cwd` lives
inside that root, so switching the action bar to it surfaces that preset's command buttons — a pane
sitting in `~/projects` gets each child repo's commands as you cycle through them, appended after
its own preset's (see `commands` under `.snowconfig`). The
fallback runs only when the owner-based lookup fails, so a pane's captured `presetName` always wins
and two presets sharing a directory keep their own buttons. `presetName` rides all the way from the
shell tab and from each split `Pane` (both split-creation paths — `addSession`'s `splits` and
`splitActive(preset)` — tag the pane with the preset that produced it), which is what gives
`presetIndexFor` a name to match on for every pane a session owns. The action bar targets one repo at a time
(`activeRepo`, chosen by `pickedRepo`/`repoIndex` with a `⇄` switcher that cycles `actionRepos`); its
name and switch button render only when there is a repo / more than one.

Clicking any git-action button (commit, undo, sync-default, update, sync, PR — the `.actionbar-button`
elements, but **not** the `.actionbar-freeze` view toggle) hands focus back to the active session's
first terminal, via one delegated `onClick` on the bar (`focusFirstTerminal`) that resolves the visible
`.terminal-host` and focuses its first `.terminal-main .xterm-helper-textarea` — the same DOM-query
focus approach `Session`'s vim binds use, so no ref is threaded from `App` into `ActionBar`. Disabled
buttons never dispatch the click, so a greyed-out action can't steal focus.

There is deliberately **no** second worktree-root round-trip from the renderer. `discover` already
canonicalizes to roots in the main process, so the action bar reuses that result rather than resolving
roots again through a separate `git:worktreeRoot` IPC — one discovery feeds both surfaces, and the two
can never drift (which they did while the action bar ran its own resolution: a parent-dir pane showed
child repos in the panel but nothing in the action bar).

The **Freeze** checkbox pins the git view. `App` holds `frozen` as `{ entries } | null` — a snapshot of
`repoEntries` (the entries, not bare cwds, so preset association survives the freeze) — and everything
downstream reads `activeEntries = frozen ? frozen.entries : repoEntries`. Because **both** the
discovered `repos` and `actionRepos` derive from `activeEntries`, freezing pins the panel _and_ the
action bar together: branch/PR/commit actions keep targeting the pinned repo, not the live tab. It pins
the _directories_, not the content — git watchers keep running, so the pinned repos' log and status
stay live.

## node-pty (native module) constraints

`node-pty` is a native module and must **not** be bundled:

- `electron.vite.config.ts` externalizes it via `externalizeDepsPlugin` in the `main` config.
- `electron-builder.yml` lists `**/node_modules/node-pty/**` under `asarUnpack` so its `.node` binaries load from disk in packaged builds.
- It ships N-API prebuilds (ABI-stable), so no native rebuild is needed across Node/Electron versions.

The default shell is `powershell.exe` on Windows, `$SHELL` (or `/bin/bash`) elsewhere — set in `defaultShell()` in `pty.ts`.

## Conventions

- Do not write comments. Let the code speak for itself.
- Do not vertically align text with uneven spacing (no padding names/values with extra spaces to line up columns).
- Renderer terminal font is **Hack Nerd Font Mono**, bundled so Starship glyphs render aligned without a system install: the four Mono weights live in `src/renderer/src/assets/fonts/` (~2.7 MB each), are declared as `@font-face` (`font-display: block`) in `assets/fonts.css`. Because `block` hides glyphs until the weight loads, the home page — which uses only the **regular** weight for its nerd-glyph icons — would flash blank icons if mounted before that weight is ready. So `main.tsx` awaits **only the regular weight** before mounting `App` (correct icons, ~¼ the startup font cost of blocking on all four), then loads bold/italic/bold-italic in the background and dispatches a `snow:fonts-ready` window event; `Terminal.tsx` listens for it and refits so xterm's canvas re-measures against real glyph metrics once the terminal weights arrive. The stack still falls back to Menlo/Consolas/Cascadia/monospace.
- `@renderer` path alias maps to `src/renderer/src/` (see `electron.vite.config.ts` and `tsconfig.web.json`).
- New privileged capabilities follow the same pattern: add an `ipcMain` handler in main, expose a wrapper in preload's `api`, never give the renderer direct Node access.
