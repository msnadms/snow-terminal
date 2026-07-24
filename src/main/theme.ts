import { ipcMain, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { configDir } from './config'
import { log } from './log'

export interface GitColors {
  background: string
  panelBackground: string
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
    background: '#171c2b',
    panelBackground: '#121724',
    border: '#28334c',
    text: '#b3c2da',
    strongText: '#e4eefb',
    accent: '#a6dcf0',
    buttonBorder: '#2a3852',
    buttonBorderHover: '#3e5273',
    muted: '#5d6f8f',
    repo: '#7fd8e8',
    branch: '#6fb2f0',
    track: '#9d9ce8',
    dirty: '#45a3cf',
    author: '#ccd4de',
    hash: '#7ba8d0',
    hashHover: '#a6dcf0',
    tooltipBackground: '#111725',
    tooltipBorder: '#2b3a55',
    tooltipText: '#ccd9ee',
    tooltipMuted: '#6b7d9d',
    diffAddBackground: '#142c28',
    diffDeleteBackground: '#2e1c25',
    diffAddGutter: '#1e4a40',
    diffDeleteGutter: '#4a2734',
    diffAddText: '#7fdcc0',
    diffDeleteText: '#e89aac',
    lanes: ['#6fb2f0', '#7fd8e8', '#9d9ce8', '#c09ae0', '#4f86c6', '#7fdcc0', '#a6c8f0', '#6e7fb8']
  },
  syntax: {
    comment: '#546882',
    keyword: '#9d9ce8',
    string: '#7fdcc0',
    number: '#a6dcf0',
    function: '#6fb2f0',
    className: '#7fd8e8',
    variable: '#c3d2e8',
    constant: '#e89aac',
    operator: '#93a4c0',
    punctuation: '#7385a3',
    tag: '#c09ae0',
    attrName: '#8fbfe0',
    regex: '#b8a0e8'
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
