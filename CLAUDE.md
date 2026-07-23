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

### User theme config

Colors live in `~/.config/snow/theme.json` (`$XDG_CONFIG_HOME/snow/theme.json` when set), currently
scoped to the git view. `src/main/theme.ts` owns it: it writes the defaults on first launch, reads and
validates on `theme:get`, and `fs.watch`es the directory to broadcast `theme:changed` on edit. Unknown
or malformed values fall back to the defaults per key, so a bad edit degrades instead of breaking.

`useGitColors` (`src/renderer/src/useGitColors.ts`) pushes each color onto `document.documentElement`
as a `--git-*` custom property that `main.css` consumes with the default as its fallback; `lanes` is
returned to `GitPanel` since SVG strokes need the value in JS.

## node-pty (native module) constraints

`node-pty` is a native module and must **not** be bundled:
- `electron.vite.config.ts` externalizes it via `externalizeDepsPlugin` in the `main` config.
- `electron-builder.yml` lists `**/node_modules/node-pty/**` under `asarUnpack` so its `.node` binaries load from disk in packaged builds.
- It ships N-API prebuilds (ABI-stable), so no native rebuild is needed across Node/Electron versions.

The default shell is `powershell.exe` on Windows, `$SHELL` (or `/bin/bash`) elsewhere — set in `defaultShell()` in `pty.ts`.

## Conventions

- Do not write comments. Let the code speak for itself.
- Do not vertically align text with uneven spacing (no padding names/values with extra spaces to line up columns).
- Renderer terminal font is **Hack Nerd Font Mono** (system-installed) so Starship glyphs render aligned; the stack falls back to Menlo/Consolas/Cascadia/monospace.
- `@renderer` path alias maps to `src/renderer/src/` (see `electron.vite.config.ts` and `tsconfig.web.json`).
- New privileged capabilities follow the same pattern: add an `ipcMain` handler in main, expose a wrapper in preload's `api`, never give the renderer direct Node access.
