import { app, ipcMain } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { broadcast, collapseHome, configDir } from './config'
import { log } from './log'

export interface HooksResult {
  ok: boolean
  message: string
  detail: string
  error: string | null
}

export interface HooksState {
  /** Whether Claude Code is on this machine at all; nothing is worth offering when it is not. */
  available: boolean
  installed: boolean
  settings: string
  error: string | null
}

interface HookHandler {
  type?: string
  command?: string
}

interface HookGroup {
  matcher?: string
  hooks?: HookHandler[]
}

const marker = 'snow-agent-hook'
const scriptName = `${marker}.mjs`
const hookEvents = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'SessionEnd'
]

export function hooksDir(): string {
  return path.join(configDir(), 'hooks')
}

function scriptFile(): string {
  return path.join(hooksDir(), scriptName)
}

function shimFile(): string {
  return path.join(hooksDir(), process.platform === 'win32' ? `${marker}.cmd` : marker)
}

/**
 * What goes in settings.json, and it is **not** the bare path. Claude Code runs a hook command
 * through a shell - bash even on Windows - so an unquoted `C:\Users\…` arrives with every backslash
 * eaten as an escape and the hook fails with "command not found". Quoting also covers the ordinary
 * case of a space in the path. Forward slashes are what make the quoting sufficient rather than
 * merely usual: inside double quotes bash still unescapes `\$` and `\\`, which a directory starting
 * with `$` or a UNC home would otherwise hit. Git Bash runs a `.cmd` addressed this way happily.
 */
function shimCommand(): string {
  const file = shimFile()
  return `"${process.platform === 'win32' ? file.split(path.sep).join('/') : file}"`
}

function claudeDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR
  return configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.claude')
}

function settingsFile(): string {
  return path.join(claudeDir(), 'settings.json')
}

/**
 * The shim exists so settings.json can hold a path snow owns and keeps current, rather than one
 * that breaks the next time the app moves or updates - an AppImage's execPath is a temporary mount
 * that is gone by the next boot. Electron run as node is the fallback rather than the default
 * because it costs an extra ~60 ms of startup on every single tool call.
 */
function shim(): string {
  const script = scriptFile()
  const binary = process.env.APPIMAGE || process.execPath
  if (process.platform === 'win32') {
    return [
      '@echo off',
      'where node >nul 2>nul',
      'if not errorlevel 1 (',
      `  node "${script}" %*`,
      '  exit /b %errorlevel%',
      ')',
      'set ELECTRON_RUN_AS_NODE=1',
      `"${binary}" "${script}" %*`,
      'exit /b %errorlevel%',
      ''
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    'if command -v node >/dev/null 2>&1; then',
    `  exec node "${script}" "$@"`,
    'fi',
    'export ELECTRON_RUN_AS_NODE=1',
    `exec "${binary}" "${script}" "$@"`,
    ''
  ].join('\n')
}

function sourceScript(): string {
  return path.join(app.getAppPath(), 'resources', 'hooks', scriptName)
}

function writeIfChanged(file: string, contents: string): boolean {
  let current: string | null = null
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch {
    current = null
  }
  if (current === contents) return false
  fs.writeFileSync(file, contents)
  return true
}

function writeRuntime(): void {
  fs.mkdirSync(hooksDir(), { recursive: true })
  writeIfChanged(scriptFile(), fs.readFileSync(sourceScript(), 'utf8'))
  if (writeIfChanged(shimFile(), shim()) && process.platform !== 'win32')
    fs.chmodSync(shimFile(), 0o755)
}

function readSettings(): { settings: Record<string, unknown>; error: string | null } {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { settings: {}, error: 'the file does not contain a JSON object' }
    return { settings: raw as Record<string, unknown>, error: null }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { settings: {}, error: null }
    return { settings: {}, error: e.message }
  }
}

function isSnowHandler(handler: HookHandler): boolean {
  return typeof handler?.command === 'string' && handler.command.includes(marker)
}

/**
 * Snow's own entries come out; everything else in the user's hooks block - including groups that
 * merely shared an event with snow's - goes back untouched.
 */
function withoutSnow(raw: unknown): { hooks: Record<string, HookGroup[]>; removed: number } {
  const hooks: Record<string, HookGroup[]> = {}
  let removed = 0
  if (!raw || typeof raw !== 'object') return { hooks, removed }
  for (const [event, groups] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    const kept: HookGroup[] = []
    for (const group of groups as HookGroup[]) {
      if (!group || typeof group !== 'object') continue
      if (!Array.isArray(group.hooks)) {
        kept.push(group)
        continue
      }
      const handlers = group.hooks.filter((handler) => {
        if (!isSnowHandler(handler)) return true
        removed += 1
        return false
      })
      if (handlers.length > 0) kept.push({ ...group, hooks: handlers })
    }
    if (kept.length > 0) hooks[event] = kept
  }
  return { hooks, removed }
}

function writeSettings(settings: Record<string, unknown>): void {
  fs.mkdirSync(claudeDir(), { recursive: true })
  fs.writeFileSync(settingsFile(), `${JSON.stringify(settings, null, 2)}\n`)
}

function failure(verb: string, error: string, detail = ''): HooksResult {
  return { ok: false, message: `Could not ${verb} snow's Claude Code hooks`, detail, error }
}

function install(): HooksResult {
  try {
    writeRuntime()
  } catch (err) {
    return failure('install', `Could not write ${collapseHome(hooksDir())}`, (err as Error).message)
  }

  const { settings, error } = readSettings()
  if (error)
    return failure(
      'install',
      `Could not read ${collapseHome(settingsFile())}`,
      `${error}\n\nFix or move that file, then run: snow hooks install`
    )

  const { hooks } = withoutSnow(settings.hooks)
  const command = shimCommand()
  for (const event of hookEvents) {
    const group: HookGroup = {
      ...(event === 'PreToolUse' ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command }]
    }
    hooks[event] = [...(hooks[event] ?? []), group]
  }

  try {
    writeSettings({ ...settings, hooks })
  } catch (err) {
    return failure(
      'install',
      `Could not write ${collapseHome(settingsFile())}`,
      (err as Error).message
    )
  }

  return {
    ok: true,
    message: 'Claude Code hooks installed',
    detail: [
      'snow now reads live session status from Claude Code instead of inferring it from terminal output.',
      '',
      `Hook: ${collapseHome(shimFile())}`,
      `Settings: ${collapseHome(settingsFile())}`,
      '',
      'Claude sessions that are already running keep their old settings until they restart.',
      'Take them out again with: snow hooks remove'
    ].join('\n'),
    error: null
  }
}

function remove(): HooksResult {
  const { settings, error } = readSettings()
  if (error) return failure('remove', `Could not read ${collapseHome(settingsFile())}`, error)

  const { hooks, removed } = withoutSnow(settings.hooks)
  if (removed === 0)
    return {
      ok: true,
      message: 'No snow hooks were installed',
      detail: `${collapseHome(settingsFile())} has nothing to remove.`,
      error: null
    }

  const next = { ...settings }
  if (Object.keys(hooks).length > 0) next.hooks = hooks
  else delete next.hooks

  try {
    writeSettings(next)
  } catch (err) {
    return failure(
      'remove',
      `Could not write ${collapseHome(settingsFile())}`,
      (err as Error).message
    )
  }

  return {
    ok: true,
    message: 'Claude Code hooks removed',
    detail: [
      `Took ${removed} hook ${removed === 1 ? 'entry' : 'entries'} out of ${collapseHome(settingsFile())}.`,
      '',
      `${collapseHome(hooksDir())} was left alone; delete it by hand if you want it gone.`,
      'Session status falls back to what snow can infer from terminal output.'
    ].join('\n'),
    error: null
  }
}

export function hooksState(): HooksState {
  const available = fs.existsSync(claudeDir())
  const settings = collapseHome(settingsFile())
  const { settings: parsed, error } = readSettings()
  if (error) return { available, installed: false, settings, error }
  return { available, installed: withoutSnow(parsed.hooks).removed > 0, settings, error: null }
}

export function runHooks(action: string): HooksResult {
  const result =
    action === 'install'
      ? install()
      : action === 'remove'
        ? remove()
        : failure(
            'run',
            `Unknown command: snow hooks ${action}`,
            'Use one of:\n  snow hooks install\n  snow hooks remove'
          )
  log(result.error ? 'error' : 'info', 'hooks', result.message, { action, error: result.error })
  return result
}

/**
 * Repairs the command string in an already-installed entry. This is maintenance of something the
 * user asked for, not an install: it runs only when the shim is already on disk, and it rewrites
 * nothing but snow's own handlers. It exists because the shim path is the half of the install that
 * settings.json holds, so a shim refresh alone cannot fix an entry written by an older snow.
 */
function repairSettings(): void {
  const command = shimCommand()
  const { settings, error } = readSettings()
  if (error) {
    log('warn', 'hooks', 'settings unreadable, left alone', { error })
    return
  }

  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object') return
  let stale = 0
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups as HookGroup[]) {
      if (!group || !Array.isArray(group.hooks)) continue
      for (const handler of group.hooks) {
        if (!isSnowHandler(handler) || handler.command === command) continue
        handler.command = command
        stale += 1
      }
    }
  }
  if (stale === 0) return

  try {
    writeSettings(settings)
    log('info', 'hooks', 'hook command repaired', { entries: stale, command })
  } catch (err) {
    log('warn', 'hooks', 'repair failed', { error: (err as Error).message })
  }
}

/**
 * The shim names a specific app binary, so an update would otherwise leave it dangling. It is only
 * ever refreshed once the user has installed it: snow creates neither this directory nor a hooks
 * entry in settings.json on its own.
 */
export function refreshHooks(): void {
  if (!fs.existsSync(shimFile())) return
  try {
    writeRuntime()
  } catch (err) {
    log('warn', 'hooks', 'refresh failed', { error: (err as Error).message })
  }
  repairSettings()
}

export function registerHooksHandlers(): void {
  ipcMain.handle('hooks:state', (): HooksState => hooksState())
  ipcMain.handle('hooks:run', (_event, action: string): HooksResult => {
    const result = runHooks(String(action ?? ''))
    broadcast('hooks:changed', result)
    return result
  })
}
