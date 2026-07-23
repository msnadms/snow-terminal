import { ipcMain, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { configDir } from './config'
import { log } from './log'

export interface GitColors {
  background: string
  border: string
  text: string
  muted: string
  repo: string
  branch: string
  track: string
  dirty: string
  author: string
  hash: string
  hashHover: string
  tooltipBackground: string
  tooltipBorder: string
  tooltipText: string
  tooltipMuted: string
  diffAddBackground: string
  diffDeleteBackground: string
  diffAddGutter: string
  diffDeleteGutter: string
  diffAddText: string
  diffDeleteText: string
  lanes: string[]
}

export interface Theme {
  git: GitColors
}

export interface ThemeResult {
  theme: Theme
  path: string
  error: string | null
}

const defaultTheme: Theme = {
  git: {
    background: '#1e1e2e',
    border: '#2f2b40',
    text: '#b8b3cc',
    muted: '#5f5878',
    repo: '#8fbf9f',
    branch: '#c7b06b',
    track: '#7791c5',
    dirty: '#c3a865',
    author: '#a396c2',
    hash: '#6b9dc0',
    hashHover: '#d8c07a',
    tooltipBackground: '#191926',
    tooltipBorder: '#34304a',
    tooltipText: '#cdc8dd',
    tooltipMuted: '#6e6690',
    diffAddBackground: '#18291f',
    diffDeleteBackground: '#2c1d23',
    diffAddGutter: '#21402c',
    diffDeleteGutter: '#452630',
    diffAddText: '#8fbf9f',
    diffDeleteText: '#c98c96',
    lanes: ['#917ec8', '#7791c5', '#c7b06b', '#a387c9', '#6797c1', '#c3a865', '#8177c5', '#6eb0c4']
  }
}

export function themePath(): string {
  return path.join(configDir(), 'theme.json')
}

const hexColor = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

function color(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return hexColor.test(trimmed) ? trimmed : fallback
}

function laneList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  const valid = value
    .filter((v): v is string => typeof v === 'string' && hexColor.test(v.trim()))
    .map((v) => v.trim())
  return valid.length > 0 ? valid : fallback
}

function mergeGit(raw: unknown): GitColors {
  const base = defaultTheme.git
  if (!raw || typeof raw !== 'object') return base
  const g = raw as Record<string, unknown>
  return {
    background: color(g.background, base.background),
    border: color(g.border, base.border),
    text: color(g.text, base.text),
    muted: color(g.muted, base.muted),
    repo: color(g.repo, base.repo),
    branch: color(g.branch, base.branch),
    track: color(g.track, base.track),
    dirty: color(g.dirty, base.dirty),
    author: color(g.author, base.author),
    hash: color(g.hash, base.hash),
    hashHover: color(g.hashHover, base.hashHover),
    tooltipBackground: color(g.tooltipBackground, base.tooltipBackground),
    tooltipBorder: color(g.tooltipBorder, base.tooltipBorder),
    tooltipText: color(g.tooltipText, base.tooltipText),
    tooltipMuted: color(g.tooltipMuted, base.tooltipMuted),
    diffAddBackground: color(g.diffAddBackground, base.diffAddBackground),
    diffDeleteBackground: color(g.diffDeleteBackground, base.diffDeleteBackground),
    diffAddGutter: color(g.diffAddGutter, base.diffAddGutter),
    diffDeleteGutter: color(g.diffDeleteGutter, base.diffDeleteGutter),
    diffAddText: color(g.diffAddText, base.diffAddText),
    diffDeleteText: color(g.diffDeleteText, base.diffDeleteText),
    lanes: laneList(g.lanes, base.lanes)
  }
}

function readTheme(): ThemeResult {
  const file = themePath()
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    return { theme: { git: mergeGit(raw.git) }, path: file, error: null }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { theme: defaultTheme, path: file, error: null }
    return { theme: defaultTheme, path: file, error: e.message }
  }
}

function writeDefaultTheme(): void {
  const file = themePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(defaultTheme, null, 2)}\n`, { flag: 'wx' })
  } catch {
    return
  }
}

let watcher: fs.FSWatcher | null = null
let timer: NodeJS.Timeout | null = null

function watchTheme(): void {
  const file = themePath()
  const name = path.basename(file)
  try {
    const fsWatcher = fs.watch(path.dirname(file), (_event, filename) => {
      if (filename && path.basename(filename) !== name) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const result = readTheme()
        log(result.error ? 'error' : 'info', 'theme', 'reloaded', {
          path: result.path,
          error: result.error
        })
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) window.webContents.send('theme:changed', result)
        }
      }, 120)
    })
    fsWatcher.on('error', () => fsWatcher.close())
    watcher = fsWatcher
  } catch {
    watcher = null
  }
}

export function disposeThemeWatcher(): void {
  watcher?.close()
  watcher = null
  if (timer) clearTimeout(timer)
  timer = null
}

export function registerThemeHandlers(): void {
  writeDefaultTheme()
  watchTheme()
  ipcMain.handle('theme:get', (): ThemeResult => readTheme())
}
