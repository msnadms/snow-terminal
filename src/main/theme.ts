import { ipcMain, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { configDir } from './config'
import { activeThemeName } from './snowconfig'
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
  diffHover: string
  diffSelection: string
  lanes: string[]
}

export interface UiColors {
  background: string
  chrome: string
  surface: string
  surfaceHover: string
  terminalBackground: string
  border: string
  borderHover: string
  borderStrong: string
  text: string
  mutedText: string
  faintText: string
  placeholder: string
  accent: string
  success: string
  danger: string
  snow: string
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
  ui: UiColors
  git: GitColors
  syntax: SyntaxColors
}

export interface ThemeResult {
  theme: Theme
  path: string
  error: string | null
}

const defaultTheme: Theme = {
  ui: {
    background: '#181825',
    chrome: '#11111b',
    surface: '#1e1e2e',
    surfaceHover: '#313244',
    terminalBackground: '#1e1e2e',
    border: '#313244',
    borderHover: '#45475a',
    borderStrong: '#585b70',
    text: '#cdd6f4',
    mutedText: '#a6adc8',
    faintText: '#6c7086',
    placeholder: '#5d6f8f',
    accent: '#a6dcf0',
    success: '#a6e3a1',
    danger: '#f38ba8',
    snow: '#cdd6f4'
  },
  git: {
    background: '#1a1a2e',
    panelBackground: '#1a1a2e',
    border: '#2b3448',
    text: '#c5d0e2',
    strongText: '#eef2fb',
    accent: '#c3d9f2',
    buttonBorder: '#303a52',
    buttonBorderHover: '#454f6c',
    muted: '#78859c',
    repo: '#b3d4ec',
    branch: '#9cc4ee',
    track: '#b6b0ec',
    dirty: '#82b8e6',
    author: '#d4dbe8',
    hash: '#a0bce2',
    hashHover: '#cfe2f5',
    tooltipBackground: '#12151e',
    tooltipBorder: '#2a3348',
    tooltipText: '#d7dff4',
    tooltipMuted: '#7d89a2',
    diffAddBackground: '#142c28',
    diffDeleteBackground: '#2e1c25',
    diffAddGutter: '#1e4a40',
    diffDeleteGutter: '#4a2734',
    diffAddText: '#7fdcc0',
    diffDeleteText: '#e89aac',
    diffHover: '#242c3d',
    diffSelection: '#3a4358',
    lanes: ['#9cc4ee', '#b6aeec', '#8ecbea', '#c6a6e6', '#7fb0e2', '#a99ce0', '#a8d0ef', '#c19fdc']
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

export function themesDir(): string {
  return path.join(configDir(), 'themes')
}

function themeFile(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '') || 'theme'
  return path.join(themesDir(), `${safe}.json`)
}

export function themePath(): string {
  return themeFile(activeThemeName())
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
      theme: {
        ui: mergeColors(raw.ui, defaultTheme.ui),
        git: mergeGit(raw.git),
        syntax: mergeColors(raw.syntax, defaultTheme.syntax)
      },
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
  const file = themeFile('theme')
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
  try {
    const fsWatcher = fs.watch(themesDir(), (_event, filename) => {
      if (filename && !filename.endsWith('.json')) return
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
  ipcMain.handle('theme:list', (): string[] => {
    try {
      return fs
        .readdirSync(themesDir())
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .sort()
    } catch {
      return ['theme']
    }
  })
}
