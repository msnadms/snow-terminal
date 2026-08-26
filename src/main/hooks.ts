import { app, ipcMain } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { broadcast, collapseHome, configDir } from './config'
import { log } from './log'
import {
  activeWorkflowStashProtection,
  setWorkflowStashProtection,
  workflowStashProtections,
  type WorkflowStashProtection
} from './snowconfig'

export interface HooksResult {
  ok: boolean
  message: string
  detail: string
  error: string | null
}

export interface HooksState {
  /** Whether a supported agent is on this machine at all; nothing is worth offering otherwise. */
  available: boolean
  installed: boolean
  stashProtection: WorkflowStashProtection
  settings: string
  error: string | null
}

interface HookHandler {
  type?: string
  command?: string
  commandWindows?: string
}

interface HookGroup {
  matcher?: string
  hooks?: HookHandler[]
}

const marker = 'snow-agent-hook'
const helperMarker = 'snow-workspace-stash'
const scriptName = `${marker}.mjs`
const claudeHookEvents = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStop',
  'SessionEnd'
]
const codexHookEvents = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd'
]

type HookAgent = 'claude' | 'codex'

interface HookTarget {
  agent: HookAgent
  label: string
  directory: string
  file: string
  events: string[]
}

export function hooksDir(): string {
  return path.join(configDir(), 'hooks')
}

function scriptFile(): string {
  return path.join(hooksDir(), scriptName)
}

function shimFile(): string {
  return path.join(hooksDir(), process.platform === 'win32' ? `${marker}.cmd` : marker)
}

function helperShimFile(): string {
  return path.join(hooksDir(), process.platform === 'win32' ? `${helperMarker}.cmd` : helperMarker)
}

/**
 * What goes in settings.json, and it is **not** the bare path. Claude Code runs a hook command
 * through a shell - bash even on Windows - so an unquoted `C:\Users\…` arrives with every backslash
 * eaten as an escape and the hook fails with "command not found". Quoting also covers the ordinary
 * case of a space in the path. Forward slashes are what make the quoting sufficient rather than
 * merely usual: inside double quotes bash still unescapes `\$` and `\\`, which a directory starting
 * with `$` or a UNC home would otherwise hit. Git Bash runs a `.cmd` addressed this way happily.
 */
function shimCommand(agent: HookAgent): string {
  const file = shimFile()
  return `"${process.platform === 'win32' ? file.split(path.sep).join('/') : file}" ${agent}`
}

/**
 * Codex runs Windows hooks through cmd.exe. A quoted path works in a terminal but can be
 * reinterpreted by Codex's own outer command quoting and make every hook exit before the shim
 * starts. Keep the command line itself quote-free and put the path-safe invocation in PowerShell's
 * UTF-16LE encoded payload instead.
 */
function codexWindowsCommand(agent: HookAgent): string {
  const file = shimFile().replaceAll("'", "''")
  const payload = `& '${file}' '${agent}'; exit $LASTEXITCODE`
  return [
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(payload, 'utf16le').toString('base64')
  ].join(' ')
}

function claudeDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR
  return configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.claude')
}

function claudeSettingsFile(): string {
  return path.join(claudeDir(), 'settings.json')
}

function codexDir(): string {
  const configured = process.env.CODEX_HOME
  return configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.codex')
}

function codexHooksFile(): string {
  return path.join(codexDir(), 'hooks.json')
}

function hookTargets(): HookTarget[] {
  return [
    {
      agent: 'claude',
      label: 'Claude Code',
      directory: claudeDir(),
      file: claudeSettingsFile(),
      events: claudeHookEvents
    },
    {
      agent: 'codex',
      label: 'Codex',
      directory: codexDir(),
      file: codexHooksFile(),
      events: codexHookEvents
    }
  ]
}

/** Install into agents present on this machine; retain Claude as the no-agent fallback for the
 * existing CLI behavior, where `snow hooks install` may prepare hooks before Claude's first run. */
function installTargets(): HookTarget[] {
  const available = hookTargets().filter((target) => fs.existsSync(target.directory))
  return available.length > 0 ? available : [hookTargets()[0]]
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
  for (const file of [shimFile(), helperShimFile()]) {
    if (writeIfChanged(file, shim()) && process.platform !== 'win32') fs.chmodSync(file, 0o755)
  }
}

function readSettings(target: HookTarget): {
  settings: Record<string, unknown>
  error: string | null
} {
  try {
    const raw = JSON.parse(fs.readFileSync(target.file, 'utf8')) as unknown
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

function snowGroup(event: string, agent: HookAgent): HookGroup {
  const command = shimCommand(agent)
  return {
    ...(event === 'PreToolUse' || event === 'PostToolUse' ? { matcher: '*' } : {}),
    hooks: [
      {
        type: 'command',
        command,
        // PostToolUse also refreshes status. Keep it ordered with Stop/SessionEnd so a late
        // completion cannot restore `busy` after the turn has already ended.
        ...(agent === 'codex' && process.platform === 'win32'
          ? { commandWindows: codexWindowsCommand(agent) }
          : {})
      }
    ]
  }
}

/**
 * The whole of what being installed means, expressed once: snow's own entries out, exactly one
 * group per supported event back in. `install` and `repairSettings` both reconcile to this, so
 * repair cannot drift into a weaker second installer - an event added to either product's set, a
 * changed tool matcher, or a duplicated handler is fixed by the same pass either way.
 */
function withSnowHooks(
  raw: unknown,
  agent: HookAgent,
  events: string[]
): Record<string, HookGroup[]> {
  const { hooks } = withoutSnow(raw)
  for (const event of events) {
    hooks[event] = [...(hooks[event] ?? []), snowGroup(event, agent)]
  }
  return hooks
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

function writeSettings(target: HookTarget, settings: Record<string, unknown>): void {
  fs.mkdirSync(target.directory, { recursive: true })
  fs.writeFileSync(target.file, `${JSON.stringify(settings, null, 2)}\n`)
}

function failure(verb: string, error: string, detail = ''): HooksResult {
  return { ok: false, message: `Could not ${verb} snow's agent hooks`, detail, error }
}

function install(protection?: WorkflowStashProtection): HooksResult {
  if (protection) {
    const configured = setWorkflowStashProtection(protection)
    if (configured.error)
      return failure('install', 'Could not save shared-stash protection', configured.error)
  }
  try {
    writeRuntime()
  } catch (err) {
    return failure('install', `Could not write ${collapseHome(hooksDir())}`, (err as Error).message)
  }

  const targets = installTargets()
  const configs = targets.map((target) => ({ target, ...readSettings(target) }))
  const unreadable = configs.find((config) => config.error)
  if (unreadable) {
    return failure(
      'install',
      `Could not read ${collapseHome(unreadable.target.file)}`,
      `${unreadable.error}\n\nFix or move that file, then run: snow hooks install`
    )
  }

  for (const { target, settings } of configs) {
    const hooks = withSnowHooks(settings.hooks, target.agent, target.events)
    try {
      writeSettings(target, { ...settings, hooks })
    } catch (err) {
      return failure(
        'install',
        `Could not write ${collapseHome(target.file)}`,
        (err as Error).message
      )
    }
  }

  const labels = targets.map((target) => target.label)
  return {
    ok: true,
    message: `${labels.join(' and ')} hooks installed`,
    detail: [
      `snow now reads live session status from ${labels.join(' and ')} instead of inferring it from terminal output.`,
      '',
      `Hook: ${collapseHome(shimFile())}`,
      `Marked-stash restore helper: ${collapseHome(helperShimFile())} restore`,
      ...targets.map((target) => `${target.label}: ${collapseHome(target.file)}`),
      '',
      'Agent sessions that are already running keep their old settings until they restart.',
      ...(targets.some((target) => target.agent === 'codex')
        ? ['Codex requires new or changed hooks to be reviewed with /hooks before they run.']
        : []),
      `Shared-stash protection: ${activeWorkflowStashProtection()} (change with: snow hooks protection warn|deny|off)`,
      'Take them out again with: snow hooks remove'
    ].join('\n'),
    error: null
  }
}

function remove(): HooksResult {
  const configs = hookTargets()
    .filter((target) => fs.existsSync(target.file))
    .map((target) => ({ target, ...readSettings(target) }))
  const unreadable = configs.find((config) => config.error)
  if (unreadable)
    return failure(
      'remove',
      `Could not read ${collapseHome(unreadable.target.file)}`,
      unreadable.error!
    )

  let removed = 0
  const changed: { target: HookTarget; settings: Record<string, unknown> }[] = []
  for (const { target, settings } of configs) {
    const result = withoutSnow(settings.hooks)
    removed += result.removed
    if (result.removed === 0) continue
    const next = { ...settings }
    if (Object.keys(result.hooks).length > 0) next.hooks = result.hooks
    else delete next.hooks
    changed.push({ target, settings: next })
  }

  if (removed === 0)
    return {
      ok: true,
      message: 'No snow hooks were installed',
      detail: `${configs.map(({ target }) => collapseHome(target.file)).join(' and ') || 'Agent settings'} had nothing to remove.`,
      error: null
    }

  for (const { target, settings } of changed) {
    try {
      writeSettings(target, settings)
    } catch (err) {
      return failure(
        'remove',
        `Could not write ${collapseHome(target.file)}`,
        (err as Error).message
      )
    }
  }

  return {
    ok: true,
    message: 'Agent hooks removed',
    detail: [
      `Took ${removed} hook ${removed === 1 ? 'entry' : 'entries'} out of ${changed.map(({ target }) => collapseHome(target.file)).join(' and ')}.`,
      '',
      `${collapseHome(hooksDir())} was left alone; delete it by hand if you want it gone.`,
      'Session status falls back to what snow can infer from terminal output.'
    ].join('\n'),
    error: null
  }
}

export function hooksState(): HooksState {
  const targets = hookTargets().filter((target) => fs.existsSync(target.directory))
  const configs = targets.map((target) => ({ target, ...readSettings(target) }))
  const failed = configs.find((config) => config.error)
  const available = targets.length > 0
  const settings = targets.map((target) => collapseHome(target.file)).join(' · ')
  const stashProtection = activeWorkflowStashProtection()
  if (failed) return { available, installed: false, settings, stashProtection, error: failed.error }
  return {
    available,
    installed:
      configs.length > 0 &&
      configs.every(({ settings: parsed }) => withoutSnow(parsed.hooks).removed > 0),
    settings,
    stashProtection,
    error: null
  }
}

const protectionDetail: Record<WorkflowStashProtection, string> = {
  off: 'Agents will not warn about unqualified git stash commands in snow workspaces.',
  deny: 'Agents will block unqualified git stash commands in snow workspaces.',
  warn: 'Agents will warn before running an unqualified git stash command in a snow workspace.'
}

export function runHooks(action: string, protection?: string): HooksResult {
  const mode = workflowStashProtections.find((candidate) => candidate === protection)
  if (protection && !mode)
    return failure(
      'set shared-stash protection',
      `Unknown protection mode: ${protection}`,
      'Use one of: warn, deny, off'
    )
  const result =
    action === 'install'
      ? install(mode)
      : action === 'remove'
        ? remove()
        : action === 'protection' && mode
          ? (() => {
              const configured = setWorkflowStashProtection(mode)
              return configured.error
                ? failure('set shared-stash protection', configured.error)
                : {
                    ok: true,
                    message: `Shared-stash protection set to ${mode}`,
                    detail: protectionDetail[mode],
                    error: null
                  }
            })()
          : failure(
              'run',
              `Unknown command: snow hooks ${action}`,
              'Use one of:\n  snow hooks install [warn|deny|off]\n  snow hooks remove\n  snow hooks protection <warn|deny|off>'
            )
  log(result.error ? 'error' : 'info', 'hooks', result.message, { action, error: result.error })
  return result
}

function isInstalled(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  return Object.values(raw as Record<string, unknown>).some(
    (groups) =>
      Array.isArray(groups) &&
      (groups as HookGroup[]).some(
        (group) => group && Array.isArray(group.hooks) && group.hooks.some(isSnowHandler)
      )
  )
}

/**
 * Reconciles an already-installed hooks block back to what `install` would write. This is
 * maintenance of something the user asked for, not a fresh install: an entry in either agent config
 * has to prove the user still wants it. Those entries are the half of the install a shim refresh
 * cannot reach - a stale command path written by an older snow, an event this version added, or
 * another supported agent is only fixable from here.
 */
function repairSettings(): void {
  const targets = hookTargets()
  const configs = targets.map((target) => ({ target, ...readSettings(target) }))
  const installed = configs.filter(({ settings }) => isInstalled(settings.hooks))
  if (installed.length === 0) return
  const installedForClaude = installed.some(({ target }) => target.agent === 'claude')

  for (const { target, settings, error } of configs) {
    // A Claude installation is explicit opt-in to Snow's agent integration. Carry that opt-in
    // forward to Codex even when Codex has not created ~/.codex yet; writeSettings creates it.
    if (!fs.existsSync(target.directory) && !(target.agent === 'codex' && installedForClaude))
      continue
    if (error) {
      log('warn', 'hooks', 'settings unreadable, left alone', { path: target.file, error })
      continue
    }
    const command = shimCommand(target.agent)
    const hooks = withSnowHooks(settings.hooks, target.agent, target.events)
    if (JSON.stringify(hooks) === JSON.stringify(settings.hooks)) continue

    try {
      writeSettings(target, { ...settings, hooks })
      log('info', 'hooks', 'hook settings repaired', { agent: target.agent, command })
    } catch (err) {
      log('warn', 'hooks', 'repair failed', {
        agent: target.agent,
        error: (err as Error).message
      })
    }
  }
}

/**
 * The shim names a specific app binary, so an update would otherwise leave it dangling. A hook
 * entry, rather than the shim itself, proves the user installed Snow's integration. This also lets
 * startup recover a missing runtime and migrate an existing Claude installation to Codex.
 */
export function refreshHooks(): void {
  const installed = hookTargets().some((target) => {
    if (!fs.existsSync(target.file)) return false
    return isInstalled(readSettings(target).settings.hooks)
  })
  if (!installed) return
  try {
    writeRuntime()
  } catch (err) {
    log('warn', 'hooks', 'refresh failed', { error: (err as Error).message })
    return
  }
  repairSettings()
}

export function registerHooksHandlers(): void {
  ipcMain.handle('hooks:state', (): HooksState => hooksState())
  ipcMain.handle('hooks:run', (_event, action: string, protection?: string): HooksResult => {
    const result = runHooks(String(action ?? ''), protection)
    broadcast('hooks:changed', result)
    return result
  })
}
