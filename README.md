# snow

A terminal emulator and AI-workflow workspace built with Electron, React, and
TypeScript. snow puts real shell panes, an embedded git view, a diff viewer, and
a browser side by side in one window - designed around running Claude sessions
next to the code they touch.

## Features

- **Terminal sessions** - each tab is a session with a Claude (top) + shell
  (bottom) terminal pair, backed by real shells via
  [node-pty](https://github.com/microsoft/node-pty) and rendered with
  [xterm.js](https://xtermjs.org/). Top panes can be **split** to run several
  terminals side by side. All sessions stay alive across tab switches.
- **Multi-repo git view** - a live panel lists every repo the active session
  touches (its cwd plus any split panes), each an accordion with a commit graph.
  A pane sitting in a parent folder expands into every repo beneath it. A
  **Freeze** toggle pins the view to the current repos while you work elsewhere.
- **Diff viewer** - view any commit or the working diff in a tab or a split
  beside your terminal, with `git blame` inline, syntax highlighting (run in a
  web worker over 22 grammars), and find-in-diff (`Ctrl+F`) via the native CSS
  Custom Highlight API.
- **Workspaces** - register a branch as a workspace and snow _parks_ its
  uncommitted work in a dedicated git stash when you leave it and restores it
  when you return, so switching branches never loses in-progress changes.
  Parked work lives in git's own stash list and is never dropped. A **workspace
  manager** tab lists every registered branch across every repo, each openable
  in its own git worktree. Opening a workspace applies its matching preset's
  startup command; starting an additional agent is a separate action, so Snow
  supplies Git context while Claude Code, Codex, or another dispatcher owns
  task assignment.
- **Agent activity** - Snow can read agent activity published by Claude Code
  hooks or another tool into its local activity directory. It surfaces agents
  by workspace, attention state, activity detail, cost, and Git review state;
  it never dispatches or declares agent tasks complete.
- **Repo tab groups** - tabs are grouped and colored by the repo (or worktree)
  they belong to, so a linked worktree's session sits next to the repo it came
  from instead of scattered across the tab strip.
- **Pull requests** - open the right "create PR" page for GitHub, GitLab,
  Bitbucket, and Azure remotes (with a per-repo config override for anything
  else), in an embedded browser tab.
- **Embedded browser** - open web tabs (e.g. a PR page) inside the app, backed
  by a sandboxed `WebContentsView`.
- **Themes** - a library of named JSON themes under `~/.config/snow/themes/`
  color the whole app (chrome, terminals, git view, diff highlighting). Edits
  hot-reload; a home-page picker switches the active theme.
- **Session presets** - save named working directories, startup commands,
  split layouts, and per-preset command buttons; launch them from the home page.
- **First-run tour** - a short guided intro the first time you open a repo.
- **`snow` on your PATH** - `snow ~/code/api` opens a session in that folder and
  remembers it as a preset; in an already-running snow it lands as a new tab.

## Installation

### Windows ([Scoop](https://scoop.sh/))

```powershell
scoop bucket add snow https://github.com/msnadms/scoop-snow
scoop install snow
```

Updates come through `scoop update snow`.

### All platforms

Grab an installer for your OS from the
[latest release](https://github.com/msnadms/snow-terminal/releases/latest):

- **Windows** - `snow-<version>-setup.exe` (installer) or `snow-<version>-win-x64.zip` (portable).
- **macOS** - `snow-<version>.dmg`.
- **Linux** - `snow-<version>.AppImage`, or the `.deb` / snap.

## The `snow` command

```sh
snow                # open snow
snow ~/code/api     # open a session there, saving it as a preset
snow .              # same, for the current directory
snow --help         # usage
snow --version
```

The folder is registered in `.snowconfig` the first time you point `snow` at
it, so it also shows up on the home page and answers to the preset keybinds
from then on. Pass a folder an existing preset already points at and that
preset opens instead - nothing is duplicated. When snow is already running the
folder opens as a new tab in that window rather than a second app.

You do not have to install the command. Scoop, the `.deb`, and the snap put
`snow` on your `PATH` themselves; every other build (the macOS `.dmg`, the
AppImage, the Windows `.zip`) writes a small launcher on first run:

- macOS / Linux - `~/.local/bin/snow`
- Windows - `%LOCALAPPDATA%\Microsoft\WindowsApps\snow.cmd`, or
  `%LOCALAPPDATA%\snow\bin\snow.cmd` if that directory is not on your `PATH`

snow never writes it when some other `snow` is already on your `PATH`, and it
rewrites it after you move or update the app, so the command keeps pointing at
the copy you actually run. If the directory it wrote to is not on your `PATH`
(`~/.local/bin` is picked up at your next login on most distros), `snow.log`
says so - snow will not edit your environment for you.

## Configuration

All config lives in `~/.config/snow/` (`$XDG_CONFIG_HOME/snow/` when set).
Every file is created with sensible defaults on first launch and hot-reloads on
edit:

- `.snowconfig` - session presets, greeting name, default startup command,
  active theme, keybinds, and UI toggles.
- `themes/*.json` - named theme files (`ui`, `git`, and `syntax` color
  sections).
- `.snowignore` - `.gitignore`-syntax paths snow's git actions never stage.
- `.snowworkflows` - the registry of branches opted in to workspace parking
  (the filename is retained for compatibility).
- `snow.log` - a rolling log of main-process and IPC activity.

When Claude Code activity hooks are installed, `.snowconfig` can set
`workflowStashProtection` to `deny` (default), `warn`, or `off` for raw
`git stash` commands inside a Snow worktree. `warn` asks for confirmation;
change it with
`snow hooks protection <warn|deny|off>`.

In deny mode, agents can inspect stashes but cannot run raw restore or write
commands. Snow's denial supplies the path to its `snow-workspace-stash restore`
helper, which restores only the marker stash belonging to the workspace they
are in.

### Example: a Claude + vim split

A preset's `splits` field lists **other presets by name**. Each entry seeds one
extra top pane beside the base pane, opened in the referenced preset's `cwd`
running its `startupCommand`. So a Claude + editor layout is two presets: the
one you open runs `claude`, and it pulls in an `editor` preset that runs `vim`.

```json
{
  "presets": [
    {
      "name": "snow",
      "cwd": "~/Documents/Projects/snow-terminal",
      "splits": ["editor"]
    },
    {
      "name": "editor",
      "cwd": "~/Documents/Projects/snow-terminal",
      "startupCommand": "vim"
    }
  ]
}
```

Opening the `snow` preset gives you a Claude pane and a vim pane side by side on
top, with a shell terminal below. The split pane runs the _referenced_ preset's
command, so the two panes keep their own startup commands (`claude` and `vim`)
even when they share a directory. You can also add splits from the home page:
right-click a preset and pick another under **Add split**.

### Keybinds

An optional `keybinds` object in `.snowconfig` overrides any of the built-in
shortcuts. List only the ones you want to change; everything you omit keeps its
default. Combos are `+`-joined: `Ctrl` / `Cmd` / `Meta` / `Alt` / `Shift`, plus
`Mod` (= `Cmd` on macOS, `Ctrl` elsewhere). Edits hot-reload.

| Action                                               | Default                         | Notes                                                 |
| ---------------------------------------------------- | ------------------------------- | ----------------------------------------------------- |
| `newTab`                                             | `Mod+Shift+T`                   | New session from the default preset                   |
| `closeTab`                                           | `Mod+Shift+W`                   | Close the active tab                                  |
| `nextTab`                                            | `Mod+Shift+}`                   | Select the next tab (wraps through home)              |
| `prevTab`                                            | `Mod+Shift+{`                   | Select the previous tab (wraps through home)          |
| `newSplit`                                           | `Mod+Shift+~`                   | Split the active session                              |
| `diffSplit`                                          | `Mod+Shift+G`                   | Open the working-tree diff as a split                 |
| `runCommand`                                         | `Mod+Shift+Q`                   | Toggle the preset's first command button              |
| `switchRepo`                                         | `Mod+Shift+?`                   | Switch the action bar's repo (when more than one)     |
| `openWorkflows`                                      | `Mod+Shift+O`                   | Open (or focus) the workspace manager tab             |
| `focusCommit`                                        | `Mod+Shift+M`                   | Focus the commit-message input                        |
| `pushRemote`                                         | `Mod+Shift+P`                   | Push commits (or publish the branch) to the remote    |
| `focusLeft` / `focusDown` / `focusUp` / `focusRight` | `Mod+Shift+H` / `J` / `K` / `L` | Move pane focus (vim directions)                      |
| `splitPreset`                                        | `Mod+Shift`                     | Prefix; `<prefix>+1..9` splits with nth preset        |
| `openPreset`                                         | `Mod+Alt`                       | Prefix; `<prefix>+1..9` opens nth preset in a new tab |

`splitPreset` and `openPreset` are **modifier prefixes** - you set the prefix and
snow appends the digit `1`-`9` (the nth preset in config order). On the home page,
`splitPreset+N` opens the preset instead of splitting.

```json
{
  "presets": [ ... ],
  "keybinds": {
    "newTab": "Mod+T",
    "focusLeft": "Alt+Left",
    "focusRight": "Alt+Right",
    "splitPreset": "Mod+Ctrl",
    "openPreset": "Mod+Shift"
  }
}
```

## Architecture

snow uses Electron's three-process split, each with its own tsconfig and build
target:

- **Main** (`src/main/`) - owns all OS access: PTY processes, git, the embedded
  browser, config files, and logging.
- **Preload** (`src/preload/`) - the only bridge, exposing a narrow typed
  `window.api` to the renderer via `contextBridge`.
- **Renderer** (`src/renderer/src/`) - the sandboxed React UI, with no direct
  Node access.

The default shell is `powershell.exe` on Windows and `$SHELL` (or `/bin/bash`)
elsewhere. See [`CLAUDE.md`](./CLAUDE.md) for a deeper tour of the internals.

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

### Other scripts

```bash
$ npm run build      # typecheck + compile all three processes into out/
$ npm run typecheck  # typecheck main/preload and renderer
$ npm run lint       # ESLint (cached)
$ npm run format     # Prettier
$ npm run start      # preview the last production build
```

There is no test runner configured.

### Build installers

```bash
# For Windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## License

[MIT](./LICENSE) © Mason Adams
