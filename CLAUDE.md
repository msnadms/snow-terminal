# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this is

`snow` is a terminal emulator and AI workflow helper built with Electron + React + TypeScript
(scaffolded with electron-vite): a workspace of terminal panes hosting Claude/Codex sessions
alongside a git view.

## Commands

- `npm run dev` — hot-reloading renderer (Vite dev server + Electron).
- `npm run build` — typecheck then compile all three processes into `out/`.
- `npm run typecheck` — `typecheck:node` (main/preload) + `typecheck:web` (renderer).
- `npm run lint` / `npm run format` — ESLint (cached) / Prettier.
- `npm run start` — preview the last production build.
- `npm run build:win` / `build:mac` / `build:linux` — package via electron-builder.

There is no test runner configured.

## Architecture

Electron's three-process split, each with its own tsconfig and build target:

- **Main** (`src/main/`, Node.js) — window creation and all OS access.
- **Preload** (`src/preload/`) — the only bridge; a narrow typed API via `contextBridge`.
- **Renderer** (`src/renderer/src/`, React) — sandboxed UI, no direct Node access. The nested
  `src/renderer/src/` is intentional (Vite web-root convention).

New privileged capabilities follow the same pattern: `ipcMain` handler in main, wrapper in preload's
`api`, never direct Node access in the renderer.

### Terminal data flow

An xterm.js instance in the renderer wired to a real node-pty process in main over IPC, keyed by a
numeric terminal `id` the renderer allocates (`src/renderer/src/terminalId.ts`).

```
xterm.js (Terminal.tsx) → window.api.terminal.* (preload) → ipcMain (pty.ts) → node-pty shell
        ▲                                                                            │
        └─────────── term.write(data) ← 'pty:data' ← webContents.send ←──────────────┘
```

Channels (`src/main/pty.ts`, mirrored in `src/preload/index.ts`): `pty:spawn`, `pty:write`,
`pty:resize`, `pty:kill` (renderer→main); `pty:data`, `pty:exit` (main→renderer). Sends are guarded
(`safeSend`); each PTY is killed on `webContents 'destroyed'` and app `will-quit`. `pty.ts` also
tracks each PTY's **live** cwd by parsing the OSC 7 reports the shell emits each prompt.

### Diff rendering

`DiffBody` renders one `DiffFile` per changed file, gated on an `IntersectionObserver`. On becoming
visible a file makes **one** IPC call, `git:blame`, returning `{ lines, source }` —
`git blame --line-porcelain` already emits every source line, so the file content comes free with the
blame. There is deliberately no second "read this file" channel. `source` is `null` past
`maxSourceChars`.

Syntax highlighting runs in a **web worker** (`src/renderer/src/tokenize.worker.ts`) via
react-diff-view's `useTokenizeWorker`; passing `oldSource` highlights both whole file versions so a
hunk inside a block comment colors correctly — far too much sync work for the thread hosting xterm.
The 22 refractor grammars live **only** in the worker (~340 kB kept off the startup path), which is
why `syntax.ts` imports nothing and is just the extension→language map. The worker checks
`refractor.registered()` and reports an unknown grammar as a tokenize failure rather than throwing.

#### Staging from the diff (working tree only)

File headers carry Stage/Unstage and Revert buttons, driven by an optional `staging` prop.
`CommitView` never passes it; only `WorkingDiffView` does, and it owns both the actions and the
confirm dialog. Actions run through the shared `useGitAction` (failures surface in `FailureDialog`),
whose `pending` is passed through as `staging.busy`. Nothing refreshes by hand — staging writes
`.git/index`, which the `git:watch` watcher already reports.

`git:stageFile` / `git:unstageFile` / `git:revertFile` each take the file's `path` **and `oldPath`**,
because a rename is one diff entry over two worktree paths. `fileTargets` resolves both against the
worktree root and refuses anything escaping it. They share one `fileHandler` registrar holding the
common shell (`withRepoLock`, targets resolution, `.catch(fail)`). Unstage is a bare `git reset -q --`
(the unborn-HEAD-safe form). Revert resolves all paths against HEAD in one `ls-tree`, then batches
`checkout HEAD --` for paths HEAD has and `rm --cached` + unlink for those it doesn't.

The same three actions hang off `GitPanel`'s changed-file list, owned directly by `RepoSection`.
Staged-ness there is `file.index` (anything but ` `, `?`, `!`) — not the `fileCategory` grouping,
which misreads a partially staged file.

Staged state on the diff comes from `git:diff` marking each file `staged` via
`git diff --cached --name-only` against the same `base` it already resolved — deliberately not
`git status`. A partially staged file reads as staged.

Dialogs share `GitDialog` (backdrop, Escape, focus of the first action button); `DiscardDialog`,
`FailureDialog`, and `BlockedCommitDialog` are thin wrappers supplying title, `detail`, and buttons.
`dismissOnEnter` is the one behavioral knob and only `FailureDialog` sets it — the other two are
unrecoverable actions.

Layout: file headers are `position: sticky` and `DiffScroll`'s tools row is pinned to the same corner,
so `.commit-file-actions` takes `margin-right: auto` and `.commit-file-title-staging` reserves
`--diff-tools-inset` of right padding. This is unconditional on purpose — a
`scroll-state(stuck: top)` container query reads as _not_ stuck at exactly the offset
`scrollIntoView({ block: 'start' })` lands on. `--diff-tools-inset` is measured by a `ResizeObserver`
because the tools row's width changes with the find bar and `↑ Top`.

#### Find (Ctrl+F)

`useFind` (`src/renderer/src/useFind.ts`) gives every `DiffScroll` pane a find bar. It never touches
the DOM: matches are `Range`s handed to the CSS Custom Highlight API, styled by
`::highlight(snow-find)` / `::highlight(snow-find-current)` in `main.css`. The scan concatenates the
pane's text nodes into one string with a `\n` between block ancestors, so a match may span
syntax-highlight `<span>`s but never two diff lines. Text directly inside `td.diff-gutter` is skipped.
Because the highlight registry is global, the module tracks which pane owns the two names. Results
recompute on a debounced `MutationObserver` that ignores mutations inside `.commit-tools`.

### Pull requests

`git:openPullRequest` normalizes the remote URL (`webUrl` handles scp-like and Azure SSH forms) and
picks a URL shape from the `forges` table. Hosts match on **dot-delimited labels**, not substrings.
An unrecognized host is a **failure**, not a fallback to the repo homepage. The escape hatch is
per-repo git config: `git config snow.pullRequestUrl "https://host/...?from={branch}&to={base}"`
(`{branch}`, `{base}`, `{repo}` substituted), checked before the table.

## User config

All config lives in `~/.config/snow/` (`$XDG_CONFIG_HOME/snow/` when set); `configDir()` in
`src/main/config.ts` is the single resolver. Each config module shares the same lifecycle: default
written with `flag: 'wx'` on first launch, `fs.watch` on the directory filtered by basename,
broadcasting a `*:changed` event. Only the watcher broadcasts — write handlers mutate and let the
debounced event notify every window. `config.ts` provides `writeDefaultConfig`, `watchConfigFile`,
`broadcast`, `samePath`, `collapseHome`, `expandHome`.

### `theme.json`

Themes live in `~/.config/snow/themes/` as named files; the active one is the `.snowconfig` `theme`
field (base filename, default `"theme"`). `themePath()` resolves it and `themeFile()` sanitizes the
name to `[A-Za-z0-9_-]`. `theme:get` reads the active file, `theme:list` enumerates names for
`ThemeSelect`. The watcher covers the whole `themes/` directory. A **switch** writes `.snowconfig`, so
the renderer's `themeStore.ts` subscribes to both `theme:changed` and `snowconfig:changed`.

Three sections: `ui` (app chrome), `git` (git-view chrome and diff backgrounds), `syntax` (token
colors). `mergeColors` falls back per key off the keys of `defaultTheme`, so a bad edit degrades
rather than breaks. Because defaults are written `wx`, an existing file never grows a newly added
block on disk.

`themeStore.ts` is the single renderer subscription (`useSyncExternalStore`), pushing colors onto
`document.documentElement`: `git` through the explicit `cssVars` map (`--git-*`), `ui` as `--ui-*` and
`syntax` as `--syntax-*` plus the kebab-cased key.

**A `var(--ui-*)` fallback is a hardcoded dark color, so a name no section defines never themes at
all** — a silent failure only a light theme reveals. `--ui-warning` is therefore **derived** by
`applyCssVars`: `warningFor` keeps the amber's hue and walks OKLab lightness away from `ui.background`
until WCAG contrast hits 4.5, gaining chroma as it goes. OKLab conversions live in `color.ts`, shared
with `repoColor.ts`.

`ui.terminalBackground` is its own key so terminal panes theme independently; `Terminal.tsx` reads
`themeStore` and writes `term.options.theme`. `lanes` is the per-column git-graph palette: edge
strokes take `lanes[parentCol]` and each node gets a gradient from the adjacent pair
(`--grad-top`/`--grad-bottom`, set inline). With `.snowconfig`'s `gradients` off, both are equal and
`git-graph-flat` kills the animation. Node color derives entirely from `lanes`.

### `.snowignore`

Paths the action bar must never touch, in `.gitignore` syntax, applied to every repo.
`src/main/snowignore.ts` matches with the `ignore` package; `filterPaths()` expects
repo-root-relative forward-slash paths (what `git status --porcelain` emits).

The compiled matcher is cached and validated against the file's own `mtimeMs:size` stamp **on every
call** — not left to the watcher, which can die silently (`fs.watch` throws on some filesystems, and
its `'error'` handler closes without re-attaching), pinning stale patterns for the process lifetime.
The stamp is taken **before** the read.

`git.ts` consults it in two places: `git:commit` stages an explicit filtered list instead of
`git add -A`, and `git:status` reports `stageable` alongside the unfiltered `changed`.

That add happens **only when nothing is staged yet** — once anything is in the index, `git:commit`
commits the index as it stands, so a deliberate partial stage is never widened.
**The filter therefore runs over the index too.** `resolveCommitTargets` filters whichever set it is
about to commit and returns matches found staged as `blocked`; `git:commit` refuses on a non-empty
`blocked`, and `ActionBar` renders the paths in `BlockedCommitDialog`. Main returns only paths and a
one-line `error` — the **renderer owns the prose**.

The dialog's two ways out are re-invocations of `git:commit` with a different
`ignored: CommitIgnored`: `'block'` (default), `'unstage'` (reset those paths, re-resolve from a fresh
status), or `'include'` (skip the gate). One three-state parameter, since the states are exclusive.

A **rename is blocked when either side matches**, and both sides go into the reset. Only `git:commit`
looks at both sides; `git:status`'s per-file `ignored` flag stays keyed on `path`, because an unstaged
rename is two separate entries.

`git:generateCommitMessage` shares the gate — its staged diff is scoped to `resolved.targets`
whenever `blocked` is non-empty (piping an ignored file to the CLI is the exact disclosure
`.snowignore` prevents), and bails as "Nothing to commit" when nothing is left.

### `.snowconfig`

Session presets and app settings, as JSON:
`{ presets: { name, cwd, default?, commands?, startupCommand?, splits?, paneRatios?, hidden? }[],
name?, startupCommand?, commitAgent?, gradients?, theme?, tourSeen?, hooksPrompted?,
workflowStashProtection?, keybinds?, layout? }`.

Entries missing a string `name`/`cwd` are dropped; a leading `~` in `cwd` expands **only on read**.

- `name` — the home tab's greeting. `seedName()` fills it **once** when absent (`gh api user`, then
  `git config user.name`); a user-set name is never overwritten.
- `startupCommand` — what each session's main terminal runs (default `claude`). A preset may carry its
  own, overriding the top level. The chosen command is **captured on the tab at open time**, not
  re-derived from `cwd`, since two presets can share a directory.
- `commitAgent` — `"claude"` (default) or `"codex"`. Hand-edited, validated as an enum, read per
  invocation via `activeCommitAgent()`.
- `gradients` — boolean (default true), passed to `GitPanel`.
- `theme` — active theme base filename, read back by `theme.ts` via `activeThemeName()`.
- `layout` — `{ gitWidth?, gitCollapsed?, bottomHeight?, bottomCollapsed? }`, persisted pane sizes.
- `tourSeen` / `hooksPrompted` — one-time flags. They live here **deliberately instead of renderer
  `localStorage`**: a sync `localStorage.getItem` on the startup path was observed blocking the
  renderer for ~5 s while Chromium's DOM-Storage backend opened. No renderer code touches
  `localStorage`. `hooksPrompted` records that snow **asked**, so `snow hooks remove` does not bring
  the offer back.

`theme.ts`'s `activeThemeName()` and `git.ts`'s `activeCommitAgent()` are the two cross-config
dependencies on `snowconfig.ts`; they stay acyclic because `snowconfig.ts` imports nothing back.

Pane sizing never mirrors config into state with an effect: the shared `useCollapsiblePane`
(`src/renderer/src/useCollapsiblePane.ts`) derives `size`/`collapsed` as `override ?? saved ?? default`.
Writes are debounced to drag **end** via `ResizeHandle`'s `onEnd`. `Session` and `Terminal` are
`React.memo`'d and `App` hands `Session` only `useCallback` callbacks.

**`commands`** — per-preset shell-command buttons right of the tab bar's `+`. Visible buttons are a
**union of two sources**, resolved once as `commandPresets` in `App`: the **session** presets (every
distinct preset across `activeEntries`) first, then the **adopted** preset (matching `activeRepo`)
last. `commandItems` flat-maps that through each preset's `commands`; `managePresetIndex` is
`commandPresets[0]`. Both sources resolve through `presetIndexFor`, which matches the `presetName`
captured at open time and only falls back to a `cwd` match for entries that never came from a preset.

The union exists because neither source subsumes the other: `activeRepo` alone drops a preset whose
cwd is not inside a discovered repo (a pane in a non-git parent folder), while the adopted source is
what surfaces a child repo's own commands as you cycle `⇄`. Deduped by `uniqueBy`.

`TabBar` renders a `.tab-command-divider` wherever `presetIndex` changes between adjacent items. Each
item carries its own `presetIndex` and its `index` **within that preset**, because
`snowconfig:removeCommand` is positional. Both index spaces stay inside `App`. The `+` is gated by
**`onAddCommand` being `undefined`**, so the button and the form can't disagree.

Each button is a **toggle**: it spawns a hidden background PTY (no xterm) in **its own item's** cwd and
kills it on the second click. The command is spawned as `<command>; exit` so the shell dies with it —
both PowerShell (`-NoExit`) and interactive POSIX shells otherwise outlive their command, leaving the
button stuck green. `App` holds `running` keyed by `runKey` (`` `${presetName}\n${command}` ``) →
terminal id, passed straight to `TabBar`. `toggleCommand` keeps `running` in its deps rather than
using a `setRunning` updater — updaters double-invoke in StrictMode and would spawn two PTYs.

**`splits`** — a per-preset `string[]` of **other presets' names**. Each seeds one extra top pane in
the referenced preset's own `cwd` running the referenced preset's **own** `startupCommand`, set
explicitly on the pane so it never falls through to the opening preset's. Names are resolved against
the live `presets` list; stale ones are silently skipped.

**`hidden`** — a preset that exists only to be split into another. Dropped from the home page and the
split menu; survives only in the home page's right-click "Add split" list, which is therefore also the
only place it can be deleted. `HomePage` renders `visibleEntries` as `{ preset, index }` pairs so every
`snowconfig:*` write carries the **config** index; the positional digit keybinds instead index `App`'s
`visiblePresets` so digits match what's on screen.

**`paneRatios`** — one fraction per top pane summing to 1, written on drag end from measured widths,
read back as the `flexGrow` fallback scaled by pane count. Per preset, resolved through the captured
`presetName`. Both ends gate on length (`Session` ignores a saved array whose length ≠ `panes.length`;
`handlePaneRatios` refuses to write one whose length ≠ `1 + splits.length`). `addSplit`/`removeSplit`
drop it. `setPaneRatios` returns `false` when unchanged, so a click without a drag never writes.

Every write handler goes through `mutateConfig`, which owns read → error-bail → write and hands the
callback the whole parsed config, so passthrough fields are structural and no write path can drop one.
The callback returns `false` to abort. Handlers: `snowconfig:get`, `addPreset`, `setDefault(index)`
(`-1` clears), `removePreset`, `addCommand`, `removeCommand`, `addSplit`, `removeSplit`,
`setPaneRatios`, `setTheme`, `setTourSeen`, `setLayout(patch)`. `presetForDir` is the one non-IPC write
path (used by the CLI). `useSnowconfig` is the single renderer subscription.

Whether the first-run `Tour` shows is **derived** in `App`, not stored:
`!tourSeen && !tourDismissed && activeTab.kind === 'shell' && repos.length > 0` — gating on the
discovered `repos` list rather than a `git:isRepo` probe is what makes it appear for a pane in a
**parent folder** of some repos.

#### Keybinds

`keybinds` is an optional `{ action: combo }` map, **hand-edited only**. The action set and defaults
live in the renderer (`src/renderer/src/keybinds.ts`) since main never dispatches them. Combos are
`+`-joined modifiers plus one key, including `Mod` (Cmd on macOS, Ctrl elsewhere).

All binds run on a **single module-level capture-phase** `keydown` listener on `window`:
`useCaptureKeydown` adds each hook's handler ref to a module registry; `dispatch` walks it, stopping at
the first handler returning `true`. Capturing lets a matched handler `stopPropagation` before the event
reaches an xterm textarea. Only actions with a **defined** handler match, so an unavailable action
falls through to the terminal untouched.

Named actions: `newTab`, `closeTab`, `nextTab`/`prevTab` (defaults `Mod+Shift+}`/`{` — the _shifted_
characters, since `e.key` reports `}`), `newSplit`, `diffSplit`, `runCommand` (toggles
`commandItems[0]`), `switchRepo`, `openWorkflows`, `focusCommit` (resolved by `.actionbar-input`),
`pushRemote` (registered inside **`ActionBar`**, since `ahead`/`sync` live there; handler undefined
unless `ahead > 0` or `!tracking`).

`focusLeft`/`focusDown`/`focusUp`/`focusRight` (`Mod+Shift+H/J/K/L`) are owned by **`Session`**, where
the geometry lives: `H`/`L` step through top panes, `J` drops to the bottom shell, `K` returns to the
last top pane (`lastTopRef`). It resolves panes from `document.activeElement` and focuses the xterm
`.xterm-helper-textarea`, so no imperative handle is threaded through `Terminal`. Registered only while
`active`.

`splitPreset` and `openPreset` are **positional families**: the config value is a modifier prefix, and
`usePresetDigitKeybind` matches `<modifier>+<1-9>`. The digit is read from `e.code`
(`Digit1`/`Numpad1`), not `e.key`, because `Shift+1` reports punctuation on most layouts.
`modifiersMatch` is exact, so the two families never collide.

### `snow.log`

`src/main/log.ts`; `initLogging()` runs at the top of `index.ts` (before `app.whenReady()`). It opens
an append stream to `snow.log` (recreated past 100k lines), tees main-process `console.*`, and
monkey-patches `ipcMain.handle`/`ipcMain.on` so **every** IPC call is logged with args, result or
error, and duration — which is why `git.ts` has no logging code. Lines are
`ISO-timestamp LEVEL [scope] message`; values are JSON-serialized then truncated at 400 chars.

Exclusions: `pty:write`/`pty:resize` are in `quietChannels` (logging keystrokes would make this a
keylogger); `pty:data` flows main→renderer and is never seen. PTY _lifecycle_ is logged explicitly in
`pty.ts`. `snowconfig:*` are in `redactedChannels` — call and duration logged, payload not.

Renderer output reaches the file through `watchRenderer(webContents)` in `createWindow`
(`console-message`, `render-process-gone`, `did-fail-load`, `preload-error`), so the renderer needs no
logging API and gets no new privilege.

## Agents (Claude and Codex)

The commit message runs whichever CLI `commitAgent` names; the usage meter always reports both,
because cost is observed after the fact. Agent status is hook-fed.

### AI commit messages

`git:generateCommitMessage` builds prompt and diff, then hands them to `runCommitAgent(agent, input)`.
Per-agent differences live in one `commitAgentSpecs` table (`command`, `timeoutMs`, `args`, `read`);
error strings interpolate `spec.command`.

- **claude** — `claude -p --disallowedTools …`, message read from **stdout**.
- **codex** — `codex exec … -`, message read from the file passed to `--output-last-message`; stdout
  carries a banner and turn log around the message. A missing file reads as empty.

Three codex flags are load-bearing: `--skip-git-repo-check` (the child runs in `os.tmpdir()`),
`--sandbox read-only`, and `-c model_reasoning_effort=low` (mechanical task; default effort costs
seconds and cents per click). Codex gets `timeoutMs * 2`.

On Windows both CLIs are `.cmd` shims, so the child spawns with `shell: true` — and Node does not quote
arguments in shell mode, so `spawnCommitAgent` quotes any argument containing whitespace
(`os.tmpdir()` sits under a profile path that may contain a space).

### Agent status

Status is fed by hook events, not inferred from PTY bytes — a byte heuristic cannot tell "finished"
from "blocked on a permission prompt", cannot see thinking, and pins `busy` on an animated spinner.

The channel is a **directory of files, not IPC**: the hook is a short-lived child of the user's agent
process and cannot talk to a running snow. It writes `~/.config/snow/agents/<session_id>.json`
(`{ sessionId, terminalBinding?, terminalOwner?, cwd, state, detail, promptId?, turnEnded?, agent,
updated }`; legacy `terminal` accepted), and `src/main/agents.ts` reads and watches that directory.
Snow only reads; only the hook writes.

This is an **observation contract, not an agent-control API**. Other dispatchers may write the same
records with their own `agent` name. Snow groups records for the human operator; it never creates
tasks or chooses a next agent. The record carries only what a hook can assert — earlier
`parentSessionId`/`task`/`result` fields were always empty and were removed.

| Event                            | State                                                            |
| -------------------------------- | ---------------------------------------------------------------- |
| `SessionStart`                   | `idle`; `source: compact` changes nothing                        |
| `UserPromptSubmit`               | `busy`                                                           |
| `PreToolUse`                     | `busy`, except Claude's `AskUserQuestion` → `attention`          |
| `PermissionRequest`              | `attention` (Codex about to ask)                                 |
| `PostToolUse`                    | `busy`; ordered before turn-end hooks; also discovers worktrees  |
| `Notification`                   | Claude attention/idle classification; idle reminders stay `idle` |
| `SubagentStart` / `SubagentStop` | `busy`                                                           |
| `Stop` / `StopFailure`           | `idle`                                                           |
| `SessionEnd`                     | record deleted                                                   |

Claude's away-recap generator runs an internal fork minutes after `Stop`, retaining the completed
turn's `prompt_id`. The hook guards **the transition, not the event names**: any event that would raise
an already-`idle` record to `busy` is ignored when it carries that record's `promptId`. The guard
applies only to an `idle` **the turn's own end wrote**, marked by `turnEnded` (set by `Stop` and
`StopFailure`, cleared by everything else) — otherwise an `idle_prompt` notification during an
unanswered permission prompt would pin `idle` over an agent that is visibly working. Compaction is no
state change at all.

`Notification` classification is an **allowlist over a field another product owns**, and fails _loud_:
a notification with no `notification_type` reads as `attention`. A type Claude did report but this list
doesn't name is believed. `attention` is the one state nothing refreshes, so misreading a renamed field
would silently retire the signal fleet-wide.

`resources/hooks/snow-agent-hook.mjs` is the whole hook. It **exits 0 unconditionally, prints only a
deliberate stash decision/warning, and carries its own 5 s watchdog** — a hook that fails or hangs
degrades the user's session and a status badge is not worth that. Records are written to a temp file
and renamed; `session_id` is sanitized before becoming a filename.

`readAgents()` expires records **per state** and deletes their files: 30 min for `busy`/`idle`, 12 h for
`attention`. Records self-heal (every event rewrites them), so retiring early costs a missing badge
while retiring late invents a fleet of finished agents. A malformed file is skipped, not deleted.

**Terminal tokens.** Every PTY inherits a unique token, and one map in `agents.ts` (`live`) holds, per
token, the moment that terminal last became an agent's. A record carrying a token is valid only while
its token is live and newer than that moment; `readAgents()` deletes the rest. `pty.ts` states only
facts it owns: `retainTerminal` on spawn, `releaseTerminal` when the PTY dies, `retireTerminal` when
the terminal outlives the agent inside it (the renderer's Ctrl+C/Escape decision, and every
shell-prompt OSC 7 after the initial one). Expressed as one invariant, the awkward cases fall out —
startup needs no special case, since nothing is retained yet. A retire/release only broadcasts when the
last read reported that token, so a bottom shell costs nothing.

Bindings carry a per-process **owner** (`terminalBinding`/`terminalOwner`), so a packaged snow and
`npm run dev` open together leave each other's records alive without attaching them to their own tabs.

**Externally-created worktrees** ride the same observation. Every `readAgents()` queues a serialized
reconciliation for repos named by live session cwds: `worktreeMap` enumerates linked branches and
`addRecord(repo, branch, directory)` adopts every secondary checkout into `.snowworkflows`. The primary
checkout is deliberately skipped. Reconciliation runs one pass at a time and keeps only the latest
trailing snapshot.

**The byte heuristic stays as the floor.** `Session` keeps byte-burst status per terminal and reports
both per-terminal values and the tab aggregate to `App`. `agentDirs` is per normalized cwd from
`agents:get` + `agents:changed`; a hook state always wins for its directory, and the heuristic answers
only where no agent reports (an `npm run dev` split, or a session with no hooks installed).

**A tab's own dot is session-specific.** `tabStatusIn` overlays hook state on the byte heuristic per
terminal the tab owns and takes the loudest; cwd is never a tab-ownership fallback, so two tabs in one
folder stay independent and an external agent can't light an arbitrary tab. Interrupts are timestamped
by terminal id.

Directory identity belongs exclusively to the workflow rollup. `sessionDirStatuses` maps each
terminal's heuristic to that terminal's own cwd, then overlays `agentDirs`. `WorkflowManager` folds
every live record below a workflow root using `attention > busy > idle` and exposes the composition
(e.g. `needs input · 1 working`). `workflowSessionsOf` synthesizes one `busy` rollup record for a
working terminal with no hook record (a real record suppresses its synthetic fallback), but
deliberately never synthesizes `attention` — only a hook record can claim an agent asked for input.
Persistent unread terminal state renders as `finished` (or `ready to review`), cleared by opening the
terminal.

**`idle` never counts as a live agent in a rollup.** `liveAgentsIn` (`useAgents.ts`) drops it, and `App`
folds a tab-less agent directory in only while working or waiting — `idle` is indistinguishable from a
session killed without firing `SessionEnd`. A tab's **own** dot still shows `idle`.

Where two agents share a directory the **loudest state wins, not the newest**.

#### Blocking shared-stash commands

Because `refs/stash` is repo-wide (see _Parked work_), a stash restore an agent runs in a promoted
worktree can consume a **different** workspace's parked changes. `snow-agent-hook.mjs` answers
`PreToolUse` on `Bash`/`PowerShell` with `permissionDecision: "deny"` — no extra settings entry needed,
since the installed `PreToolUse` group already matches every tool.

**Only the consuming half is refused**: `pop`, `apply`, `drop`, `clear`, `branch`, `create`, `store`.
`list`/`show` pass. **Creating a stash passes** — it only appends, and snow re-lists under the shared
lock before every apply. The one thing push _is_ checked for is a message carrying the `snow-wf:`
prefix, and **any** argument mentioning it refuses (parsing out `-m` vs `--message=` would only
re-derive the same answer). `--help`/`-h` passes.

The installed `snow-workspace-stash restore` helper is the only permitted restore path. Commands are
split on shell operators and tokenized with quotes honoured (a chained `cd src && …` is caught, an
`echo "…"` is not); git's value-taking global flags are skipped to find the subcommand; segments split
on `(`/`)` and leading shell keywords are skipped; a recognized **command wrapper** (`nohup`,
`timeout`, `sudo`, `env`, …) is followed by scanning forward for the `git` token.

**Scope is every registered directory, not only linked worktrees** — park-mode markers are created by
`parkOnLeave` in the repo's **own** checkout. Two functions over one registry read: `guardedScope(cwd)`
asks only whether anything snow parks is reachable (a pure path comparison, no git process, since it
runs on every tool call mentioning the marker); `ownedBranch(cwd)` asks _whose_ parked work it is and
pays for a `rev-parse` only on the explicit `restore` command.

Two things bound the blast radius: the scope is read from `.snowworkflows` by the hook process itself,
so a repo with no registered workflows is untouched; and every failure **fails open**.

`workflowStashProtection` in `.snowconfig` selects `deny` (default), `warn`, or `off`. Claude supports
an interactive `"ask"` for warn mode; Codex gets a non-blocking `systemMessage` instead. Change it with
`snow hooks protection <warn|deny|off>`.

### Usage cost

`src/main/usage.ts` estimates spend **since snow started** by reading each CLI's own session logs —
nothing is sent anywhere to price it. One `sources` table drives everything (agent name, directory,
parser).

- **claude** — `~/.claude/projects/**/*.jsonl`, priced from `message.usage` (separate 5m/1h cache-write
  tiers, cache reads at 0.1×).
- **codex** — `~/.codex/sessions/**/*.jsonl`, priced from `payload.info.last_token_usage`.

Codex needs two things Claude doesn't: its events carry no model, so the parser tracks the most recent
`payload.model` (emitted by `turn_context`, always preceding that turn's `token_count`) and prices an
unresolved model at zero; and `last_token_usage` is a **per-turn delta** while `total_token_usage` is
cumulative, so summing deltas avoids recounting. Codex entries carry the `':'` never-dedup sentinel;
Claude entries keep `id:requestId` dedup, scoped per source.

Files are cached on `mtimeMs:size` and skipped when older than `sessionStart`. Listing is one recursive
`readdirSync`, handling both layouts without encoding either depth. A missing root is not an error —
only non-`ENOENT` failures set `error`.

`UsageResult` reports `agents` (per-agent), `session` (total), and `byDirectory`. Attribution costs no
extra filesystem work: Claude puts `cwd` on every usage line, Codex in the `session_meta` record.
`~/.claude/projects/<dashed-cwd>/` is deliberately **not** decoded — that encoding maps separators,
dots, and underscores all onto `-`. Note the asymmetry: a rollout marks its opening record on the
**envelope** (`entry.type === 'session_meta'`) while events mark themselves on the **payload**.

Keys are resolved, slash-normalized absolute paths, and the renderer sums a **subtree** (an agent's cwd
is often a subdirectory of its worktree), case-insensitively. The watcher is per source and never
creates a root whose parent is absent.

## The `snow` command

`src/main/cli.ts` owns both what the app does with `process.argv` and the shim that puts `snow` on
`PATH`. `startCli()` is the **first** statement in `index.ts` (above `initLogging()`), returning `false`
when this process must not become an app, which `index.ts` turns into `app.exit(0)`. Flags are checked
**before** the instance lock, so `snow --help` answers while a window is open. The single-instance lock
is taken **only when packaged** — in dev it would hand `npm run dev` off to an installed snow.

Argument parsing never slices argv by position (Electron hands `second-instance` a different shape):
`folderArg` takes the first argument that is neither a flag nor `app.getAppPath()`, resolved against the
_reporting_ process's directory (`process.cwd()`, or `workingDirectory` for a second instance).

A folder becomes a preset in `presetForDir` (in `snowconfig.ts`, which owns `mutateConfig`). It returns
the whole `Preset`, not its name, and that object is what `cli:pending` (consumed once) and the
`cli:open` broadcast carry — **load-bearing**, since `snowconfig:changed` lands ~100 ms later and a
renderer looking the name up would miss a just-created preset. `App` still prefers its own copy
(`presets.find(…) ?? preset`) so a `splits` preset opens its splits.

`runArgs` dispatches on the first positional **with at least one more argument**, so a bare `snow theme`
/ `snow hooks` still opens a directory of that name. Both entry points (startup argv and
`second-instance`) go through the one `runArgs`.

### `snow theme <url> [name]`

`themeInstall.ts` owns the download. Sources must be `https:`; a `github.com/…/blob/…` URL is rewritten
to `raw.githubusercontent.com`. The name comes from the URL's `.json` basename (sanitized) or the
optional second argument; a URL whose last segment isn't a `.json` file refuses to guess. An existing
file is never overwritten without `--force`.

`validateTheme` is deliberately **stricter than `mergeColors`**: a missing **section** or non-hex value
is a refusal, while a missing **key** installs and reports `Using defaults for: …` — so a theme
published against an older snow keeps working while an unrelated JSON file is still rejected.

Install writes the file then activates it through `setActiveTheme` (the non-IPC path into
`mutateConfig`). Write order doesn't matter.

**The shim detaches, so the command cannot print** — results go to `snow.log` and the window. A failure
broadcasts `theme:installed` with an `error`, rendered in the shared `FailureDialog`.

### `snow hooks install` / `snow hooks remove`

Reading status needs hook blocks in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/`) and
`~/.codex/hooks.json` (or `$CODEX_HOME/`), and **those files are the user's** — so installing is an
explicit command, and it **merges**, preserving every key and existing hook. Removal is keyed on the
command string containing `snow-agent-hook`. A file that does not parse is a refusal, never an
overwrite. An unrecognized second positional is an error naming the two accepted, not a fall-through.

Two files land in `~/.config/snow/hooks/`: the script copied from `resources/`, and a shim
(`snow-agent-hook.cmd` / `snow-agent-hook`) which is what both hook configs name. The indirection is
load-bearing — a path into the app breaks on update, and an AppImage's `execPath` points inside a
temporary mount. `refreshHooks()` rewrites the shim **only when it already exists**; snow never creates
the directory or a settings entry on its own.

**Each config holds a quoted, forward-slash command plus `claude` or `codex`, not a bare path.** Claude
runs hook commands through a **shell — bash even on Windows** — so an unquoted `C:\Users\…` loses every
backslash and the hook dies on every event. Forward slashes make the quoting sufficient (bash still
unescapes `\$` and `\\` inside double quotes). Git Bash runs a `.cmd` addressed this way fine, so the
shim stays a `.cmd`.

`refreshHooks()` **repairs** already-installed entries, gated on a snow-marked handler still being
present (`snow hooks remove` leaves the runtime files behind, so the settings entry is what proves
intent). A Claude entry carries that intent forward to Codex, creating `$CODEX_HOME/hooks.json` even
when that directory doesn't exist yet. `repairSettings` reconciles through the **same** `withSnowHooks`
that `install` writes with, so "already installed" is the only thing repair decides; the write is
skipped when the result is identical.

The shim prefers `node` on `PATH` and falls back to the app binary with `ELECTRON_RUN_AS_NODE=1` (the
fallback costs ~60 ms per tool call, but a native-binary agent install implies no Node).

`HooksPrompt` offers the install **once** from the home page. `hooks:state` answers whether to show it
(`available`, `installed`, plus `hooksPrompted`). `hooks:run` is the same `runHooks` the verb calls and
broadcasts the same `hooks:changed`. Declining records the answer immediately; a **failed** install is
the one case that does not, since the offer is the only surface naming the feature. Unlike a theme
install, success is not self-evident, so `App` shows the result either way (a `notice` dialog).
`HooksResult` carries `message` and `detail` alongside `error` — the renderer composes prose.

### `installCommand()` (the PATH shim)

Runs on every start from `registerCliHandlers`, with **no UI**, gated on `app.isPackaged`.
`commandState` decides: `install`/`update` write the file; `path` (written and current, but its
directory isn't on `PATH`) only logs; `ready` returns silently — which is also what installs that
already provide the command produce (scoop, the `.deb` symlink, the snap), since snow must never shadow
one.

The shim is `~/.local/bin/snow` (`nohup … &`) or `%LOCALAPPDATA%\Microsoft\WindowsApps\snow.cmd`
(`start ""`) — that directory is on the user `PATH` by default on Win10/11; `%LOCALAPPDATA%\snow\bin`
is the fallback. The target is `process.env.APPIMAGE ?? process.execPath`. snow never edits `PATH`
itself.

## Workspaces (workflow internals)

A **workspace** is a branch you have explicitly registered, plus the uncommitted work parked on it. The
public UI says "workspace" to mark the boundary: Snow owns isolated Git context and human review, while
an agent dispatcher owns task planning and agent lifecycle. Internal file and IPC names remain
`workflow`.

Three modules in a strict one-way chain — `registry.ts` ← `git.ts` ← `workflow.ts`:

- `src/main/registry.ts` — the `.snowworkflows` file. Imports nothing from git.
- `src/main/git.ts` — park machinery (`parkOnLeave`, `restoreOnEnter`, `rollbackPark`, `switchBranch`)
  over the git primitives.
- `src/main/workflow.ts` — the `workflow:*` handlers.

**Registration is the opt-in.** The dropdown never enumerates branches — only registered ones, via
`workflow:register` or `workflow:create`.

Parking is a property of the _branch_, not the dropdown used. `git:checkout`, `git:checkoutRemote`, and
`git:syncDefault` all route through `switchBranch`. On an unregistered branch snow does nothing special
— the changes ride along, or git refuses exactly as it always would.

**A promoted worktree refuses rather than parks.** Its directory is recorded against one branch, so
checking anything else out there would leave the entry pointing at a directory that no longer holds its
branch (a **stale** row inviting a prune that silently demotes a live session). `registryFor` returns
the branch that **owns** the current worktree alongside the parkable list, and `ownedElsewhere` turns a
mismatch into an ordinary failed switch naming the owner — checked in `switchBranch` before
`parkOnLeave`, and again in `git:createBranch`'s `carry: true` branch.

`git:createBranch` is the other exception: `checkout -b` cannot fail on a dirty tree, so parking rescues
nothing. It takes a `carry` flag — `false` routes through `switchBranch`, `true` runs a plain
`checkoutLocalBranch`. `BranchSelect` never guesses: it calls `git:parkPreview` (advisory only,
swallowing its own errors) and opens a two-button dialog on a hit.

### `.snowworkflows`

The registry, in `~/.config/snow/`, same lifecycle as the other config files, built from `config.ts`'s
shared helpers. `initRegistry()` runs _before_ `registerGitHandlers()` in `index.ts`. Shape is
`{ workflows: { repo, branch }[] }` — flat, because branch names collide across repos. `repo` is the
worktree root with `~` collapsed on write and expanded on read; comparisons go through `samePath`
(resolve + slash-normalize, case-insensitive on win32 — necessary because
`git rev-parse --show-toplevel` emits forward slashes).

`addRecord`/`removeRecord` re-read first and **bail if the read errored**, so a hand-corrupted file is
never replaced with a one-entry registry. A read error is never treated as "nothing is registered" —
`registeredBranches()` throws instead, which `switchBranch` turns into a failed-switch dialog leaving
the tree untouched. `workflow:list` is the one reader that returns the error rather than throwing.

### Parked work

Parked work lives in git's own stash list under the message `snow-wf:<branch>`, so it survives use of
git outside snow. Entries are read with `git stash list --format=%gd%x1f%gs%x1f%aI` and matched on that
marker. Stash selectors shift on every push and drop, so they are **always re-listed immediately before
an apply and never cached**. When a branch has more than one marker stash, the newest wins and the rest
stay listed as parked — lossless.

**`refs/stash` is shared by every worktree of a repository** while `HEAD` and `index` are per-worktree,
so `stash@{0}` means "whatever was pushed last _anywhere_ in this repo". Snow's own machinery is safe by
construction; a bare restore typed by an agent is not, which is what the hook refuses (see _Blocking
shared-stash commands_).

`parkOnLeave()` is the single gate: `git stash push -u` **only when the current branch is registered and
dirty**, refusing a tree with conflicts. `restoreOnEnter()` is its mirror and is likewise gated on
registration — a marker stash on a since-unregistered branch is never silently restored. `switchBranch()`
composes the two around an arbitrary checkout closure, so every switch path shares the same semantics.
`switchBranch` is the only park entry point `git.ts` exports (plus `unparkBranch`, which
`workflow:demote` needs to undo its own park).

**Every restore goes through `popStash`, which uses `--index` first** — a plain restore reinstates
everything as unstaged, silently losing a deliberately staged subset. The one recoverable failure it
adds is retried: when the index cannot be reinstated git bails **before touching the working tree**, so
the plain form can safely follow. Any other failure falls through to the existing classification
untouched.

Every path rolls back through `rollbackPark()` if the checkout fails. When it **cannot** put the work
back (the restore failed, or the marker is no longer listed) it appends recovery instructions to
`detail` rather than returning the bare checkout error. Snow never discards a stash entry:
`workflow:unregister` only removes the registry entry.

`workflow:create` creates the branch in its own linked worktree rather than switching the active
checkout: `worktree add -b <name> --no-track <directory> <remote>/<default>`. **`--no-track` is
load-bearing** — without it the branch tracks `origin/<default>` and `git:sync` would push a feature
branch at the default branch's upstream.

**`workflow:demote` pays its destructive costs only once it knows they are needed.** Killing the user's
shells is irreversible and only needed on Windows, where an open shell holds the directory. Removal is
attempted **first** with the session still running (`--force` twice: dirty/ignored files, then an
explicit worktree lock as used by Claude Code); only if that fails and `stillLinked` confirms nothing was
removed does it call `closePtysInDirectory` and retry. If the retry also fails the park is rolled back
through `unparkBranch`. The result carries `worktree` (what makes the renderer close the tab) only when
terminals were actually closed.

`closePtysInDirectory` matches each PTY's **live** directory, not its spawn cwd — a shell started
elsewhere that `cd`s into the worktree holds it just as firmly.

Parked file counts are `git stash show --name-only` plus `git ls-tree -r --name-only <sel>^3` rather
than `git stash show -u` (which needs git ≥ 2.32). A missing `^3` counts as zero, but a failed _tracked_
listing yields `null`, not `0`. `WorkflowParked.count` carries how many marker stashes the branch has,
rendered as `● N ×2`. No git watcher is added — stash writes touch `.git/refs/stash`, already covered by
`git:watch`.

`.snowignore` is deliberately not consulted: it is a commit filter, not a worktree filter.

Both `WorkflowSelect` and `WorkflowManager` reload on `workflow:changed` unconditionally but filter
`git:changed` by **`repoScope`** (the repo root plus every worktree path in the list) — describing a
workflow costs two git processes per entry, and `withRepoLock` broadcasts on every mutating handler in
every open repo. Worktree paths are in scope because they live outside the root yet share the stash.
`WorkflowList` carries `repo` purely so the renderer can compute that scope.

### The workflow manager

`WorkflowManager` is a **tab kind** (`{ kind: 'workflows' }`), opened from the tab-bar button, the
`openWorkflows` keybind, or the dropdown — all three route through `App`'s one `openWorkflows`, which
focuses the existing tab. It is the only surface not scoped to a cwd, which is why it exists:
`workflow:list` needs an open repo, so a repo with no tab open is invisible everywhere else.

`workflow:overview` groups `readRecords()` by `samePath`'d repo and describes each through the **same**
`describeWorkflows` the cwd-scoped `workflow:list` uses — one enrichment path, so a row cannot read
differently in the two places. A repo whose directory has moved comes back `unreachable: true` rather
than being dropped. Repos listed are **exactly** the registry's, never presets or discovery.

Both handlers take a `detail` flag adding a `review` (changed files, staged files, commits ahead of the
default branch) to every entry with a working tree: its own worktree when promoted, the repo root when
the branch is checked out there, nothing for a parked branch. The manager passes `true`, the dropdown
does not. It is a **flag, not a second handler**, for the same anti-drift reason.

Distance is measured against the **default branch, not the upstream**, since `workflow:create` sets no
tracking ref: `aheadOf` tries `<remote>/<default>` then the local default, reporting `null` rather than
0 when neither resolves. A failed `status` drops `review` entirely — "no changes" and "could not look"
are not the same row.

#### Overlap and conflict detection

Detailed reads retain each workflow's changed paths long enough to compare them within the repo, and
each path carries **where the claim came from** — `committed` (the `base...HEAD` diff), `working`
(status entries, both sides of a rename), or `parked` (the newest marker stash). Committed and dirty
provenance are retained separately per (path, workflow): the committed fact makes the branch tips
testable, while the dirty fact prevents that test from proving the worktree or stash clean.

`git merge-tree` merges **commits**; it cannot see a dirty worktree or a stash. That constraint is the
seam the three verdicts fall out of, not a limitation to work around:

| Every claim on the path                  | Verdict                | Decided by                                  |
| ---------------------------------------- | ---------------------- | ------------------------------------------- |
| all committed                            | `conflict` or `clean`  | a real `merge-tree` between the branch tips |
| anything touching working tree or parked | `overlap` ("unproven") | path intersection                           |

`overlap` renders as **"unproven"**, and every claimant carries its own `source` so the row can say
_why_. Without that a path this workflow committed reads as a flat contradiction — `unproven
(committed)` — when the thing blocking the merge is somebody else's dirty tree. Only a `committed`
claim goes unlabelled, so `unproven · pop-swagga (uncommitted)` names the blocker. When **every**
claim was committed and the verdict is still unproven, the merge itself failed to evaluate, and the
renderer says `could not evaluate` instead — a different statement, derived rather than stored.

`overlap` is **unknown, not benign** — it is what a path gets when nothing could evaluate it. The
distinction from `clean` is why `provenClean` demands that _every_ claimant committed the path and that
each pair actually evaluated: one untested claimant leaves the whole path unproven, since "we checked
and it is fine" is a far stronger statement than "we could not check". A path both sides committed that
merges cleanly still **stays listed** — textual auto-merge says nothing about whether two edits make
sense together — it just stops being alarming.

Path intersection is therefore **the prefilter deciding which pairs are worth a subprocess**, not the
answer. Only pairs sharing a path both sides _committed_ are merge-tested, so the cost is bounded by
real collisions rather than by workflow count. Conflicted paths come back from `merge-tree` verbatim
and are unioned in, so a rename/delete conflict intersection never saw is still reported. Every
workflow tip is also merge-tested against the **default branch** (O(n), not O(n²)) — the branch that
is far behind and will explode on merge is otherwise invisible.

Those base conflicts are recorded through the **same `noteConflict`** a sibling's are, so drift lands
in `overlaps` as ordinary `conflict` rows naming the default branch as the claimant. It is
deliberately **not** a claim-bearing participant: it contributes nothing to path intersection, so it
can never manufacture an unproven overlap — only a real merge failure puts it on a row. Keeping it on
the one pipeline is what makes it sort, cap, count and render with everything else; as a parallel
`string[]` every consumer special-cased it, and anything added later (a filter, a new verdict) would
silently have skipped it.

Uncommitted work in the repo's **own** checkout on an unregistered branch joins the comparison as a
participant and appears in other rows' `branches`, but never becomes a row — the manager lists what has
been registered.

`src/main/mergeCheck.ts` owns the subprocess. It uses `execFile`, **not** simple-git, because `.raw()`
rejects on any non-zero exit and `GitError` carries no code — "1 means conflicts" and "128 means the
command failed" would arrive as the same rejection. It therefore re-supplies `core.longpaths` (win32)
and `GIT_OPTIONAL_LOCKS=0` by hand; those live on `gitFor`, not centrally. Exit `>1` yields `null`
("could not look"), deliberately not `[]` ("merges clean").

Support is probed **functionally** — one `merge-tree --write-tree --name-only -z HEAD HEAD` per repo —
rather than by parsing `git --version`, covering `--write-tree` (2.38) and `--name-only` (2.40) at once.
An older git degrades the whole feature to path overlap; nothing errors. Session comparisons derive
that fallback by intersecting the paths committed on the session and default branch since their
merge base, so committed overlaps remain visible as unproven when the merge itself cannot run.

Every subprocess passes a **module-wide semaphore** (`maxInFlight`, 6). Path intersection bounds the
pair count by real collisions, but one commonly-committed path — a lockfile, `package.json` — is
claimed by every workspace that committed it, and that single file yields the full C(n, 2); a cold
overview across several repos would spawn them all at once, each writing loose objects. The freed
slot is handed **straight to the next waiter** rather than released and re-taken, so the count is
conserved exactly and a burst cannot briefly exceed the limit. `runGit` is never nested inside
another `runGit` (the support probe completes before the merge it gates begins), so the gate cannot
deadlock.

Results cache on the **pair of commit SHAs**, which is what makes this affordable: a detailed overview
re-fires through a 100 ms debounce on every mutation in any open repo, and a workflow that has not
committed since the last read costs zero subprocesses. The cache is `boundedCache` (`src/main/cache.ts`,
shared with `mergedInto`) — oldest evicted, since SHA pairs never self-invalidate. Note `--write-tree` writes loose objects, so this is **not a pure read** —
they are unreferenced and collected by `git gc`, one write per never-before-seen pair.

`-z` output is sectioned: tree OID, then the conflicted names, then an **empty NUL entry**, then
informational messages. Parsing must stop at that separator or the message text reads as paths.

Paths are capped at `overlapCap` (20, conflicts first then untested then clean) with `overlapTotals`
carrying the true count **per verdict** — a breakdown rather than one number, because the capped
array cannot be counted for them: the cap slices off the tail, which is exactly where the least
alarming ones sort to.

`overlapCounts` in the renderer folds that into what the badge draws, taking its totals from the
**pre-cap** `overlapTotals` so the badge reports the workspace rather than however much the panel can
show. It needs no case for base drift — main has already reported it as ordinary `conflict` rows. The
badge is one segmented pill, a unit per non-zero verdict (conflict, unproven, clean), each carrying
its own nerd-font glyph and count; every tint is mixed from `currentColor`, so the three verdict
rules only ever set `color`. `overlapHidden` is the one place the `+N more` count is derived.

The review badge is a **button** opening that worktree's `WorkingDiffView` through the same `openDiff`
the git panel uses (which is why `App` reads `tabsRef` there and wraps it in `useCallback` —
`WorkflowManager` is memoized). Disabled, not hidden, when there is nothing to open.

**Review all** snapshots every row whose inbox signal is `review` with a dirty tree and opens it as a
review-mode diff tab, distinct from an ordinary cwd-deduplicated diff tab; opening it again refreshes
and focuses the existing tab. Previous/next in `DiffScroll` update the review tab's cwd and branch in
place, and the keyed `WorkingDiffView` remount resets scroll and watchers while the tab stays put.

#### Clean up

Workspaces accumulate, so **Clean up** proposes the ones whose work has landed and retires them in one
sweep. It removes the worktree directory and the registry entry; the local branch and anything in the
stash are never touched, so nothing it does is unrecoverable.

`merged` on a `WorkflowEntry` is the whole gate, computed on `detail` reads by `mergedInto` against
**refs from the repo root**, so a parked branch with no working tree answers too. Two tests, because a
squash or rebase merge leaves no ancestry at all: `rev-list --count <base>..<branch>` is `0` for an
ordinary merge, and otherwise the paths the branch committed (`rangePaths`, already used by
`committedPaths`) are diffed `<base> <branch>` — an empty diff means the default branch already reads
identically on every file the branch touched. The **count** is read rather than
`merge-base --is-ancestor`'s exit code, for the reason `mergeCheck.ts` reaches for `execFile`:
simple-git rejects on any non-zero exit and `GitError` carries no code, so "not an ancestor" and "the
command failed" would arrive as the same rejection.

The answer is a pure function of the base and branch commits, so it caches on that **pair of SHAs**
exactly as `mergeCheck.ts` does — a detailed overview re-fires on every mutation in any open repo, and
a branch that has not committed since the last read costs no subprocesses. The base is resolved **once
per `describeWorkflows`** and threaded into `mergedInto`, `orphansOf`, and `resolveOverlaps`, rather
than re-resolved per workflow.

`null` is "could not tell" and is **never** offered; a later unrelated edit to a shared path reports
`false`, which is the safe direction. Beyond `merged`, candidacy is about what would be destroyed —
nothing parked, nothing uncommitted, no agent in the directory, and never the branch checked out in the
main worktree.

`WorkflowList.orphans` carries linked worktrees **no record claims** (`git worktree add` by hand, an
agent harness cutting its own). They reach the same dialog through `workflow:removeWorktree`, which is
separate from `demote` because an orphan has no record to update and no park to make — its uncommitted
work is not snow's to move into a shared stash under a marker it never claimed, so a dirty tree is a
refusal. `inContainer` (inside `<repo>-worktrees/`) decides only whether the row is **pre-checked**: a
directory snow did not lay out is listed but opt-in. `worktreeMap` is keyed by branch and skips
prunable entries, so a detached-HEAD worktree is not reported.

Both handlers share `removeLinkedWorktree`, so the try-once-then-close-terminals retry cannot drift
between them. The sweep itself is a renderer loop in the `launchAll` shape — one `action.run`, serial
(every handler takes the repo lock anyway), failures collected into a single `FailureDialog`. Order is
load-bearing: `unregister` refuses while the worktree is still linked, so `demote` lands first.

`worktreeDirectory` replaces path-unsafe characters, which would collapse distinct branches onto one
directory, so it appends a seven-character SHA-1 **only when sanitizing changed something**. Promoting
onto a non-empty directory is refused, with a message naming the branch.

**Launch** resolves per row: a usable worktree opens (or focuses) its tab, the branch checked out in the
main worktree opens a tab on the repo root, and a park-mode workflow is **promoted first**. A launched
tab inherits the preset whose `cwd` lives inside that repo (shortest match), carrying `startupCommand`
and `presetName`; `openWorktree` takes that repo as an optional second argument.

**Launch all** is that loop, sequentially and to the end — no stopping at the first failure, no
rollback. Failures are collected and reported **once** in a single `FailureDialog`.

**The screen loads and watches only while it is showing.** `WorkflowManager` is mounted for the app's
life, so its `active` prop gates both the overview load and the `git:watch` registrations it puts on
worktrees nothing else has open — otherwise parallel agents' `git:changed` broadcasts each re-run the
whole overview for a hidden tab. Re-subscribing on activation reloads as a side effect; previous rows
stay rendered while that lands.

Every mutating action runs through the shared `useGitAction`, whose single `pending` disables every
button. `RemoveWorkflowDialog` and `StopWorkflowDialog` are shared with `WorkflowSelect` (the copy is
the load-bearing part), both on `GitDialog`. Shared vocabulary — `usable`, `staleTitle`, `parkedTitle`,
`parkedStay`, `stateSlug`, `parkedBadge`, `repoScope` — lives in `workflowText.ts`.
`RemoveWorkflowDialog` renders a **second, buttonless form** when `usable(entry)`, because
`workflow:unregister` refuses while the worktree is still linked. `stateLabel` returns prose, so
`WorkflowManager` slugs it through `stateSlug` before interpolating a class name.

## Session tabs

`App.tsx` owns the tab model: `sessions` (`{ id, cwd? }`), `activeId` (`number | 'home'`), and a
per-session `cwds` map fed by each session's bottom-terminal OSC 7. `Session` renders the agent (top) +
shell (bottom) pair; all sessions stay mounted and inactive ones are hidden with `display:none` so their
PTYs survive tab switches. `Terminal` takes an `active` prop and re-fits via `requestAnimationFrame`;
its fit/resize is guarded on a non-zero container size so a hidden (0×0) pane is never shrunk to
`FitAddon`'s minimum columns.

Tabs are **reorderable by dragging**. `TabBar` tracks `{ from, over }` where `over` is an insertion
**slot** in `[0, n]`; `insertAt` collapses the two no-op slots to `null`, so both the drop indicator and
the drop are gated on one value. `App.reorderTab(from, to)` splices, converting slot to index.

The pane stack is rendered from **`mountedTabs`** — `tabs` sorted by `id`, an order reordering cannot
disturb — not from `tabs`. Keyed reconciliation moves a reordered child with `insertBefore`, which
resets `.xterm-viewport`'s `scrollTop`, so every terminal would jump to the top of its scrollback on a
drag. Only the active pane is visible, so the stack's DOM order carries no meaning.

### Repo tab groups

Every tab with a directory belongs to a group keyed on that directory's `mainWorktreeRoot` — the
repo-wide identity behind the `withRepoLock` key and every registry lookup. It answers with the current
worktree's own top level whenever the git dir _is_ the common dir, falling back to `dirname(common)`
only for a linked worktree (taking `dirname` unconditionally names an unrelated directory under
`--separate-git-dir`).

`App` resolves the key per distinct tab cwd through `git:mainRoot` and caches it by cwd, because
discovery only runs for the **active** tab. The cache is dropped on `git:reposChanged`; the effect keys
on the joined cwd list plus that epoch and reads the cache through a ref so it never re-runs on its own
writes.

Grouping is **enforced, not merely drawn**: `regroupTabs` pulls every tab of one repo next to the first
of that repo. It is a **derived** order (`orderedTabs`), not a `setTabs` correction — deriving keeps a
group from fighting a drag mid-gesture and cannot loop. Tabs with **no** repo keep their place.
`TabBar` constrains the drop rather than accepting any slot; a refused drop resolves to
`insertAt === null` and shows nothing. Dragging a group's expand/collapse button moves the whole block
via `App.reorderTabGroup`.

The color is `repoColor(key, lanes)` — an FNV hash of the normalized root into `git.lanes`. Hashing
alone is not enough (with four repos in an eight-lane palette a collision is likelier than not), so the
hash is the _preference_: `repoColor` remembers what it handed out and gives a new repo the **free lane
furthest in OKLab from every color in use**, walking from the hashed index. Distance rather than
inequality is the test, because hue-ordered palettes put the near-duplicate next door. When the winning
lane scores below `laneSeparation`, snow leaves the palette and searches OKLCH hue rotations crossed
with a ±0.1 lightness shift around the lane's own chroma, keeping the invented color in the theme's
register. The memo is a module singleton keyed on the palette, so `TabBar` and `WorkflowManager` read
one assignment; a theme switch resets it.

### Multi-repo git view

The active tab can touch more than one repo — its base cwd plus each split pane's live cwd. `App` builds
`repoEntries` (`{ cwd, presetCwd, presetName }`, deduped by cwd), joins their cwds into a stable
`discoverKey`, and runs one `git:discover` per cwd, merging by `repo.path`. Keying the effect on the
serialized `discoverKey` rather than array identity is load-bearing — `repoEntries` gets a fresh
identity whenever `cwds` changes. `handleSessionCwd` narrows that at the source, returning the previous
map unchanged when the directory already matches. `discover` returns canonical worktree roots and
expands a non-repo parent into its child repos.

That one `repos` list is the single source of truth. It is passed straight to `GitPanel` (a **pure
renderer** that no longer discovers) **and** drives `actionRepos`, which re-associates each root with a
preset by finding the `repoEntries` entry whose cwd lives inside it. A parent-expanded child that no
pane owns falls back to **adopting** a preset whose own `cwd` lives inside that root; the fallback runs
only when the owner lookup fails, so a captured `presetName` always wins. `presetName` rides from the
shell tab and from each split `Pane`, which is what gives `presetIndexFor` a name to match.

There is deliberately **no** second worktree-root round-trip from the renderer — `discover` already
canonicalizes, so one discovery feeds both surfaces and they cannot drift.

The **Freeze** checkbox pins the git view: `App` holds `frozen` as `{ entries } | null` (the entries, so
preset association survives), and everything reads
`activeEntries = frozen ? frozen.entries : repoEntries`. Because both `repos` and `actionRepos` derive
from it, freezing pins the panel _and_ the action bar together. It pins the _directories_, not the
content — watchers keep running.

Clicking any `.actionbar-button` (but **not** the `.actionbar-freeze` toggle) hands focus back to the
active session's first terminal via one delegated `onClick` resolving the visible `.terminal-host` — the
same DOM-query approach `Session`'s vim binds use, so no ref is threaded into `ActionBar`.

#### Rediscovery (`git:watchRepos`)

A **different watcher from `git:watch`**: that one needs a `.git` to exist and reports content changes;
this one watches for the repo itself appearing or disappearing. It watches `cwd` non-recursively, plus
each immediate child directory (capped at `maxDiscoveryChildren`) when `cwd` is **not** itself in a repo
— the child watchers catch a `git init` inside a `~/projects` parent and are dropped once `cwd` becomes
a repo.

Only `rename` events are accepted: creating or deleting `.git` is always a `rename`, while `change`
fires for every write _inside_ it. On a repo cwd the filter narrows to `.git` itself; on a non-repo cwd
any `rename` is accepted, since a fresh clone has an arbitrary name and needs a watcher of its own.

Events are debounced and the handler broadcasts only when the discovered root list actually changes.
`discoverRepos` is a thin wrapper over `discoveryState`, which returns `{ root, repos }` — the watcher
needs `root` to decide whether to watch children. Registrations are refcounted per `(webContents, cwd)`,
and the async setup re-checks that its record is still live before attaching.

#### `git:changed` is not left to the filesystem alone

`fs.watch` is best-effort, so it is the **second** source of `git:changed`. `withRepoLock` fires the
watcher's own `notify()` for the repo it just unlocked, so every mutating handler announces itself when
it settles. Each watcher handle carries the `root` it covers (derived exactly like the lock key, so a
linked worktree and its main worktree notify each other); the broadcast still goes out under that
watcher's own cwd and debounce.

Without it a switch is only as reliable as the watcher: a `git:changed` landing mid-checkout reads the
pre-switch HEAD (reads deliberately don't take the repo lock), and `useLatestRun` can drop the stale
read but cannot conjure a fresh one. An errored watcher is re-armed (`maxWatchRetries`, `watchRetryMs`)
and notifies on the way down.

## Platform notes

### Windows taskbar identity

snow deliberately **does not** call `electronApp.setAppUserModelId`. The electron-vite scaffold ships
that line and it is tempting to restore with the real `appId` — don't, it breaks the taskbar icon on
scoop and `.zip` installs. Setting an AUMID makes Windows resolve the taskbar button through that id,
and when no shortcut declares the same id there is nothing to resolve to. Only the NSIS installer stamps
it onto shortcuts (scoop uses `WScript.Shell`, which cannot; a `.zip` has no shortcut). With no AUMID,
Windows falls back to the path-derived identity and takes the exe's embedded icon, which every
distribution shape has. Nothing in snow consumes an AUMID — Windows toast notifications would be the
thing that needs one.

### Windows long paths

Every git command carries `-c core.longpaths=true` on win32, via the `gitOptions` object both `gitFor`
and the scratch-index `simpleGit` pass to their constructor. Without it Git for Windows refuses any path
over 260 characters. **Worktree workflows hit it first** because promotion shifts every path outward by
`len('-worktrees') + 1 + len(branch)`, so a repo comfortably under the limit at its own root can cross
it purely by being promoted.

The flag lifts the **total path** limit, not Windows' 255-character limit on a single path _component_ —
distinguishable by git's wording: `Filename too long` (total, fixed by the flag) versus
`Invalid argument` (single name, unfixable).

It belongs on `gitFor` rather than the `worktree add` call, because the whole family of write paths hits
it — the park push, the promotion restore, `worktree remove --force`. snow does **not** write
`core.longpaths` into the user's config; `-c` is per invocation.

## node-pty (native module) constraints

`node-pty` is native and must **not** be bundled:

- `electron.vite.config.ts` externalizes it via `externalizeDepsPlugin` in the `main` config.
- `electron-builder.yml` lists `**/node_modules/node-pty/**` under `asarUnpack`.
- It ships N-API prebuilds, so no native rebuild is needed across Node/Electron versions.

The default shell is `powershell.exe` on Windows, `$SHELL` (or `/bin/bash`) elsewhere —
`defaultShell()` in `pty.ts`.

## Conventions

- **Do not write comments.** Let the code speak for itself.
- Do not vertically align text with uneven spacing.
- `@renderer` maps to `src/renderer/src/` (see `electron.vite.config.ts`, `tsconfig.web.json`).
- Renderer terminal font is **Hack Nerd Font Mono**, bundled in `src/renderer/src/assets/fonts/` and
  declared with `font-display: block` in `assets/fonts.css`. Because `block` hides glyphs until the
  weight loads, `main.tsx` awaits **only the regular weight** before mounting `App`, then loads the
  other three in the background and dispatches `snow:fonts-ready`; `Terminal.tsx` listens and refits so
  xterm re-measures against real glyph metrics.
