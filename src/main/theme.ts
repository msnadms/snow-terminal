import { ipcMain, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { configDir } from './config'
import { log } from './log'

export interface GitColors {
  background: string
  border: string
  text: string
  strongText: string
  accent: string
  buttonBorder: string
  buttonBorderHover: string
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

export interface SyntaxColors {
  comment: string
  keyword: string
  string: string
  number: string
  function: string
  className: string
  variable: string
  constant: string
  operator: string
  punctuation: string
  tag: string
  attrName: string
  regex: string
}

export interface Theme {
  git: GitColors
  syntax: SyntaxColors
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
    strongText: '#cdd6f4',
    accent: '#d8c07a',
    buttonBorder: '#313244',
    buttonBorderHover: '#45475a',
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
  },
  syntax: {
    comment: '#5f5878',
    keyword: '#a387c9',
    string: '#8fbf9f',
    number: '#c3a865',
    function: '#7791c5',
    className: '#c7b06b',
    variable: '#b8b3cc',
    constant: '#c98c96',
    operator: '#8f8aa8',
    punctuation: '#6e6690',
    tag: '#917ec8',
    attrName: '#6eb0c4',
    regex: '#6b9dc0'
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

function mergeColors<T extends object>(raw: unknown, base: T): T {
  if (!raw || typeof raw !== 'object') return base
  const source = raw as Record<string, unknown>
  const entries = Object.entries(base) as [string, string][]
  return Object.fromEntries(
    entries.map(([key, fallback]) => [key, color(source[key], fallback)])
  ) as T
}

function mergeGit(raw: unknown): GitColors {
  const { lanes, ...base } = defaultTheme.git
  const g = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { ...mergeColors(g, base), lanes: laneList(g.lanes, lanes) }
}

function readTheme(): ThemeResult {
  const file = themePath()
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    return {
      theme: { git: mergeGit(raw.git), syntax: mergeColors(raw.syntax, defaultTheme.syntax) },
      path: file,
      error: null
    }
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
