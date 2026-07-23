import { ipcMain, BrowserWindow, dialog } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configDir } from './config'

export interface Preset {
  name: string
  cwd: string
  default?: boolean
}

export interface SnowConfig {
  presets: Preset[]
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

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
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

function rawPresets(): { presets: Preset[]; error: string | null } {
  const file = snowconfigPath()
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return { presets: validate(raw), error: null }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { presets: validate(defaultConfig), error: null }
    return { presets: [], error: e.message }
  }
}

function readSnowconfig(): SnowconfigResult {
  const file = snowconfigPath()
  const { presets, error } = rawPresets()
  return {
    config: { presets: presets.map((p) => ({ ...p, cwd: expandHome(p.cwd) })) },
    path: file,
    error
  }
}

function writePresets(presets: Preset[]): SnowconfigResult {
  const file = snowconfigPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ presets }, null, 2)}\n`)
  } catch (err) {
    return { config: { presets: [] }, path: file, error: (err as Error).message }
  }
  return readSnowconfig()
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
  ipcMain.handle('snowconfig:get', (): SnowconfigResult => readSnowconfig())
  ipcMain.handle(
    'snowconfig:addPreset',
    (_e, preset: { name: string; cwd: string }): SnowconfigResult => {
      const name = String(preset?.name ?? '').trim()
      const cwd = String(preset?.cwd ?? '').trim()
      if (!name || !cwd) return readSnowconfig()
      const presets = rawPresets().presets
      presets.push({ name, cwd })
      return writePresets(presets)
    }
  )
  ipcMain.handle('snowconfig:setDefault', (_e, index: number): SnowconfigResult => {
    const presets = rawPresets().presets
    presets.forEach((p, i) => {
      if (i === index) p.default = true
      else delete p.default
    })
    return writePresets(presets)
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
