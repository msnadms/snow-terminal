import { app, BrowserWindow, ipcMain } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { broadcast, expandHome, samePath } from './config'
import { log } from './log'
import { presetForDir, type Preset } from './snowconfig'

type CommandState = 'ready' | 'install' | 'update' | 'path'

const usage = `snow - a terminal emulator and AI workflow helper

Usage:
  snow [folder] [command]

  folder         open a session there. The folder is saved as a preset in
                 ~/.config/snow/.snowconfig unless one already points at it.
  command        startup command for a newly created preset (ignored if the
                 folder already has a preset).

Options:
  -h, --help     print this message
  -v, --version  print the version
`

function hasFlag(argv: string[], ...names: string[]): boolean {
  return argv.slice(1).some((value) => names.includes(value))
}

function positionalArgs(argv: string[], cwd: string): string[] {
  return argv
    .slice(1)
    .filter((value) => !value.startsWith('-'))
    .filter((value) => !samePath(path.resolve(cwd, expandHome(value)), app.getAppPath()))
}

function folderArg(argv: string[], cwd: string): string | null {
  const arg = positionalArgs(argv, cwd)[0]
  if (!arg) return null
  const dir = path.resolve(cwd, expandHome(arg))
  try {
    if (fs.statSync(dir).isDirectory()) return dir
    log('warn', 'cli', 'not a directory', { arg, dir })
  } catch (err) {
    log('warn', 'cli', 'unreadable path', { arg, dir, error: (err as Error).message })
  }
  return null
}

function presetFor(argv: string[], cwd: string): Preset | null {
  const dir = folderArg(argv, cwd)
  if (!dir) return null
  const startupCommand = positionalArgs(argv, cwd)[1]
  const preset = presetForDir(dir, startupCommand)
  log(preset ? 'info' : 'error', 'cli', 'open folder', { dir, preset: preset?.name ?? null })
  return preset
}

function print(text: string): void {
  try {
    process.stdout.write(text)
  } catch {
    /* launched without a console */
  }
}

function focusWindow(): void {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

let launched: { argv: string[]; cwd: string } | null = null
let startupPreset: Preset | null = null

export function startCli(): boolean {
  if (hasFlag(process.argv, '-h', '--help')) {
    print(usage)
    return false
  }
  if (hasFlag(process.argv, '-v', '--version')) {
    print(`snow ${app.getVersion()}\n`)
    return false
  }
  if (app.isPackaged && !app.requestSingleInstanceLock()) return false

  launched = { argv: process.argv, cwd: process.cwd() }
  app.on('second-instance', (_event, argv, workingDirectory) => {
    focusWindow()
    const preset = presetFor(argv, workingDirectory)
    if (preset) broadcast('cli:open', preset)
  })
  return true
}

function commandDir(): string {
  if (process.platform !== 'win32') return path.join(os.homedir(), '.local', 'bin')
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const aliases = path.join(base, 'Microsoft', 'WindowsApps')
  if (onPath(aliases) && fs.existsSync(aliases)) return aliases
  return path.join(base, 'snow', 'bin')
}

function commandPath(): string {
  return path.join(commandDir(), process.platform === 'win32' ? 'snow.cmd' : 'snow')
}

function launcher(): string {
  const target = process.env.APPIMAGE || process.execPath
  return app.isPackaged ? `"${target}"` : `"${target}" "${app.getAppPath()}"`
}

function shim(): string {
  if (process.platform === 'win32') return `@echo off\r\nstart "" ${launcher()} %*\r\n`
  return `#!/bin/sh\nnohup ${launcher()} "$@" >/dev/null 2>&1 &\n`
}

function pathDirs(): string[] {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
}

function onPath(dir: string): boolean {
  return pathDirs().some((entry) => {
    try {
      return samePath(expandHome(entry), dir)
    } catch {
      return false
    }
  })
}

function alreadyOnPath(): boolean {
  const names = process.platform === 'win32' ? ['snow.exe', 'snow.cmd', 'snow.bat'] : ['snow']
  return pathDirs().some((dir) => names.some((name) => fs.existsSync(path.join(dir, name))))
}

function commandState(contents: string | null, dir: string): CommandState {
  if (contents === null) return alreadyOnPath() ? 'ready' : 'install'
  if (contents !== shim()) return 'update'
  return onPath(dir) ? 'ready' : 'path'
}

function installCommand(): void {
  if (!app.isPackaged) return
  const file = commandPath()
  const dir = path.dirname(file)
  let contents: string | null = null
  try {
    contents = fs.readFileSync(file, 'utf8')
  } catch {
    contents = null
  }

  const state = commandState(contents, dir)
  if (state === 'ready') return
  if (state === 'path') {
    log('warn', 'cli', 'command not on PATH', { path: file, dir })
    return
  }

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, shim())
    if (process.platform !== 'win32') fs.chmodSync(file, 0o755)
  } catch (err) {
    log('error', 'cli', 'install failed', { path: file, error: (err as Error).message })
    return
  }
  log('info', 'cli', state === 'update' ? 'command relinked' : 'command installed', {
    path: file,
    onPath: onPath(dir)
  })
}

export function registerCliHandlers(): void {
  if (launched) startupPreset = presetFor(launched.argv, launched.cwd)
  launched = null
  installCommand()

  ipcMain.handle('cli:pending', (): Preset | null => {
    const preset = startupPreset
    startupPreset = null
    return preset
  })
}
