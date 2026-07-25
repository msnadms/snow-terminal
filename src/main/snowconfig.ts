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
}

export interface SnowConfig {
  presets: Preset[]
  name?: string
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
    result.push(preset)
  }
  return result
}

function validateName(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const value = (raw as Record<string, unknown>).name
  if (typeof value !== 'string') return null
  return value.trim() || null
}

function rawConfig(): { presets: Preset[]; name: string | null; error: string | null } {
  const file = snowconfigPath()
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return { presets: validate(raw), name: validateName(raw), error: null }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { presets: validate(defaultConfig), name: null, error: null }
    return { presets: [], name: null, error: e.message }
  }
}

function readSnowconfig(): SnowconfigResult {
  const file = snowconfigPath()
  const { presets, name, error } = rawConfig()
  return {
    config: {
      presets: presets.map((p) => ({ ...p, cwd: expandHome(p.cwd) })),
      ...(name ? { name } : {})
    },
    path: file,
    error
  }
}

function writeConfig(presets: Preset[], name: string | null): SnowconfigResult {
  const file = snowconfigPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const data = name ? { presets, name } : { presets }
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  } catch (err) {
    return { config: { presets: [] }, path: file, error: (err as Error).message }
  }
  return readSnowconfig()
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
  const { presets, name, error } = rawConfig()
  if (error || name) return
  writeConfig(presets, resolved)
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
    (_e, preset: { name: string; cwd: string }): SnowconfigResult => {
      const name = String(preset?.name ?? '').trim()
      const cwd = String(preset?.cwd ?? '').trim()
      if (!name || !cwd) return readSnowconfig()
      const { presets, name: configName, error } = rawConfig()
      if (error) return readSnowconfig()
      presets.push({ name, cwd })
      return writeConfig(presets, configName)
    }
  )
  ipcMain.handle('snowconfig:setDefault', (_e, index: number): SnowconfigResult => {
    const { presets, name: configName, error } = rawConfig()
    if (error) return readSnowconfig()
    presets.forEach((p, i) => {
      if (i === index) p.default = true
      else delete p.default
    })
    return writeConfig(presets, configName)
  })
  ipcMain.handle('snowconfig:removePreset', (_e, index: number): SnowconfigResult => {
    const { presets, name: configName, error } = rawConfig()
    if (error) return readSnowconfig()
    if (!Number.isInteger(index) || index < 0 || index >= presets.length) return readSnowconfig()
    presets.splice(index, 1)
    return writeConfig(presets, configName)
  })
  ipcMain.handle('snowconfig:chooseDir', async (): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await (win
      ? dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : dialog.showOpenDialog({ properties: ['openDirectory'] }))
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
