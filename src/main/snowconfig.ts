import { ipcMain, BrowserWindow, dialog } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configDir, expandHome } from './config'
import { log } from './log'

const execFileAsync = promisify(execFile)

export interface Preset {
  name: string
  cwd: string
  default?: boolean
  commands?: string[]
  startupCommand?: string
  splits?: string[]
}

export interface SnowConfig {
  presets: Preset[]
  name?: string
  startupCommand?: string
  gradients?: boolean
  theme?: string
  tourSeen?: boolean
}

export interface SnowconfigResult {
  config: SnowConfig
  path: string
  error: string | null
}

const defaultConfig: SnowConfig = {
  presets: [{ name: 'home', cwd: '~', default: true }]
}

export function snowconfigPath(): string {
  return path.join(configDir(), '.snowconfig')
}

function validateCommandList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const command = item.trim()
    if (command) result.push(command)
  }
  return result
}

function validate(raw: unknown): Preset[] {
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as Record<string, unknown>).presets
  if (!Array.isArray(list)) return []
  const result: Preset[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.name !== 'string' || typeof o.cwd !== 'string') continue
    const name = o.name.trim()
    const cwd = o.cwd.trim()
    if (!name || !cwd) continue
    const preset: Preset = { name, cwd }
    if (o.default === true) preset.default = true
    const commands = validateCommandList(o.commands)
    if (commands.length) preset.commands = commands
    if (typeof o.startupCommand === 'string') {
      const startupCommand = o.startupCommand.trim()
      if (startupCommand) preset.startupCommand = startupCommand
    }
    const splits = validateCommandList(o.splits)
    if (splits.length) preset.splits = splits
    result.push(preset)
  }
  return result
}

function validatePresentString(raw: unknown, key: string): string | null {
  if (!raw || typeof raw !== 'object') return null
  const value = (raw as Record<string, unknown>)[key]
  if (typeof value !== 'string') return null
  return value.trim()
}

function validateStringField(raw: unknown, key: string): string | null {
  return validatePresentString(raw, key) || null
}

function validateBooleanField(raw: unknown, key: string): boolean | null {
  if (!raw || typeof raw !== 'object') return null
  const value = (raw as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : null
}

interface RawConfig {
  presets: Preset[]
  name: string | null
  startupCommand: string | null
  gradients: boolean | null
  theme: string | null
  tourSeen: boolean | null
  error: string | null
}

function rawConfig(): RawConfig {
  const file = snowconfigPath()
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return {
      presets: validate(raw),
      name: validateStringField(raw, 'name'),
      startupCommand: validatePresentString(raw, 'startupCommand'),
      gradients: validateBooleanField(raw, 'gradients'),
      theme: validateStringField(raw, 'theme'),
      tourSeen: validateBooleanField(raw, 'tourSeen'),
      error: null
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT')
      return {
        presets: validate(defaultConfig),
        name: null,
        startupCommand: null,
        gradients: null,
        theme: null,
        tourSeen: null,
        error: null
      }
    return {
      presets: [],
      name: null,
      startupCommand: null,
      gradients: null,
      theme: null,
      tourSeen: null,
      error: e.message
    }
  }
}

function readSnowconfig(): SnowconfigResult {
  const file = snowconfigPath()
  const { presets, name, startupCommand, gradients, theme, tourSeen, error } = rawConfig()
  return {
    config: {
      presets: presets.map((p) => ({ ...p, cwd: expandHome(p.cwd) })),
      ...(name ? { name } : {}),
      ...(startupCommand !== null ? { startupCommand } : {}),
      ...(gradients !== null ? { gradients } : {}),
      ...(theme ? { theme } : {}),
      ...(tourSeen !== null ? { tourSeen } : {})
    },
    path: file,
    error
  }
}

export function activeThemeName(): string {
  return rawConfig().theme ?? 'theme'
}

function writeConfig(next: Omit<RawConfig, 'error'>): SnowconfigResult {
  const file = snowconfigPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const data: SnowConfig = { presets: next.presets }
    if (next.name) data.name = next.name
    if (next.startupCommand !== null) data.startupCommand = next.startupCommand
    if (next.gradients !== null) data.gradients = next.gradients
    if (next.theme) data.theme = next.theme
    if (next.tourSeen !== null) data.tourSeen = next.tourSeen
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  } catch (err) {
    return { config: { presets: [] }, path: file, error: (err as Error).message }
  }
  return readSnowconfig()
}

function mutateConfig(mutate: (cfg: Omit<RawConfig, 'error'>) => boolean): SnowconfigResult {
  const { presets, name, startupCommand, gradients, theme, tourSeen, error } = rawConfig()
  if (error) return readSnowconfig()
  const cfg = { presets, name, startupCommand, gradients, theme, tourSeen }
  if (!mutate(cfg)) return readSnowconfig()
  return writeConfig(cfg)
}

async function runName(file: string, args: string[], cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, { windowsHide: true, cwd })
    const value = stdout.trim()
    return value && value !== 'null' ? value : null
  } catch {
    return null
  }
}

async function githubName(): Promise<string | null> {
  const fromGh = await runName('gh', ['api', 'user', '--jq', '.name'])
  if (fromGh) return fromGh.split(' ')[0]
  return runName('git', ['config', 'user.name'], os.homedir())
}

async function seedName(): Promise<void> {
  if (rawConfig().name) return
  const resolved = await githubName()
  if (!resolved) return
  mutateConfig((cfg) => {
    if (cfg.name) return false
    cfg.name = resolved
    return true
  })
}

function writeDefaultSnowconfig(): void {
  const file = snowconfigPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(defaultConfig, null, 2)}\n`, { flag: 'wx' })
  } catch {
    return
  }
}

let watcher: fs.FSWatcher | null = null
let timer: NodeJS.Timeout | null = null

function watchSnowconfig(): void {
  const file = snowconfigPath()
  const name = path.basename(file)
  try {
    const fsWatcher = fs.watch(path.dirname(file), (_event, filename) => {
      if (filename && path.basename(filename) !== name) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const result = readSnowconfig()
        log(result.error ? 'error' : 'info', 'snowconfig', 'reloaded', {
          path: result.path,
          error: result.error
        })
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed())
            window.webContents.send('snowconfig:changed', result)
        }
      }, 120)
    })
    fsWatcher.on('error', () => fsWatcher.close())
    watcher = fsWatcher
  } catch {
    watcher = null
  }
}

export function disposeSnowconfigWatcher(): void {
  watcher?.close()
  watcher = null
  if (timer) clearTimeout(timer)
  timer = null
}

export function registerSnowconfigHandlers(): void {
  writeDefaultSnowconfig()
  watchSnowconfig()
  void seedName()
  ipcMain.handle('snowconfig:get', (): SnowconfigResult => readSnowconfig())
  ipcMain.handle(
    'snowconfig:addPreset',
    (_e, preset: { name: string; cwd: string; startupCommand?: string }): SnowconfigResult => {
      const name = String(preset?.name ?? '').trim()
      const cwd = String(preset?.cwd ?? '').trim()
      const startupCommand = String(preset?.startupCommand ?? '').trim()
      if (!name || !cwd) return readSnowconfig()
      return mutateConfig((cfg) => {
        cfg.presets.push(startupCommand ? { name, cwd, startupCommand } : { name, cwd })
        return true
      })
    }
  )
  ipcMain.handle('snowconfig:setDefault', (_e, index: number): SnowconfigResult =>
    mutateConfig((cfg) => {
      cfg.presets.forEach((p, i) => {
        if (i === index) p.default = true
        else delete p.default
      })
      return true
    })
  )
  ipcMain.handle('snowconfig:removePreset', (_e, index: number): SnowconfigResult =>
    mutateConfig((cfg) => {
      if (!Number.isInteger(index) || index < 0 || index >= cfg.presets.length) return false
      cfg.presets.splice(index, 1)
      return true
    })
  )
  ipcMain.handle(
    'snowconfig:addCommand',
    (_e, presetIndex: number, command: string): SnowconfigResult => {
      const trimmed = String(command ?? '').trim()
      if (!trimmed) return readSnowconfig()
      return mutateConfig((cfg) => {
        const preset = cfg.presets[presetIndex]
        if (!preset) return false
        preset.commands = [...(preset.commands ?? []), trimmed]
        return true
      })
    }
  )
  ipcMain.handle(
    'snowconfig:removeCommand',
    (_e, presetIndex: number, index: number): SnowconfigResult =>
      mutateConfig((cfg) => {
        const preset = cfg.presets[presetIndex]
        if (!preset || !preset.commands) return false
        if (!Number.isInteger(index) || index < 0 || index >= preset.commands.length) return false
        preset.commands.splice(index, 1)
        if (preset.commands.length === 0) delete preset.commands
        return true
      })
  )
  ipcMain.handle(
    'snowconfig:addSplit',
    (_e, presetIndex: number, name: string): SnowconfigResult => {
      const trimmed = String(name ?? '').trim()
      if (!trimmed) return readSnowconfig()
      return mutateConfig((cfg) => {
        const preset = cfg.presets[presetIndex]
        if (!preset) return false
        preset.splits = [...(preset.splits ?? []), trimmed]
        return true
      })
    }
  )
  ipcMain.handle('snowconfig:removeSplit', (_e, presetIndex: number): SnowconfigResult =>
    mutateConfig((cfg) => {
      const preset = cfg.presets[presetIndex]
      if (!preset || !preset.splits || preset.splits.length === 0) return false
      preset.splits.pop()
      if (preset.splits.length === 0) delete preset.splits
      return true
    })
  )
  ipcMain.handle(
    'snowconfig:setStartupCommand',
    (_e, presetIndex: number, command: string): SnowconfigResult =>
      mutateConfig((cfg) => {
        const preset = cfg.presets[presetIndex]
        if (!preset) return false
        const trimmed = String(command ?? '').trim()
        if (trimmed) preset.startupCommand = trimmed
        else delete preset.startupCommand
        return true
      })
  )
  ipcMain.handle('snowconfig:setTheme', (_e, theme: string): SnowconfigResult => {
    const name = String(theme ?? '').trim()
    return mutateConfig((cfg) => {
      cfg.theme = name || null
      return true
    })
  })
  ipcMain.handle('snowconfig:setTourSeen', (): SnowconfigResult =>
    mutateConfig((cfg) => {
      cfg.tourSeen = true
      return true
    })
  )
  ipcMain.handle('snowconfig:chooseDir', async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await (win
      ? dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : dialog.showOpenDialog({ properties: ['openDirectory'] }))
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
