# snow

A terminal emulator and AI workflow helper built with Electron, React, and
TypeScript. The long-term goal is a workspace of terminal panes hosting Claude
sessions and git windows.

## Current status

A working single-pane terminal. The renderer uses [xterm.js](https://xtermjs.org/)
for display and input, wired over IPC to a real shell process spawned by
[node-pty](https://github.com/microsoft/node-pty) in the main process.

Architecture:

- `src/main/pty.ts` — spawns/manages PTY processes, one per terminal `id`, and
  bridges their I/O to the renderer over IPC (`pty:spawn|write|resize|kill|data|exit`).
- `src/preload/index.ts` — exposes a typed `window.api.terminal` bridge.
- `src/renderer/src/components/Terminal.tsx` — an xterm.js pane connected to a PTY.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
