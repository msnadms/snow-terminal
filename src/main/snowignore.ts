import { ipcMain, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import ignore, { Ignore } from 'ignore'
import { configDir } from './config'
import { log } from './log'

export interface SnowignoreResult {
  patterns: string[]
  path: string
  error: string | null
}

const defaultSnowignore = [
  '# Files listed here are excluded from snow action bar actions.',
  '# Syntax is the same as .gitignore; paths are relative to the repository root.',
  '# This applies to every repository snow opens.',
  '#',
  '# secrets.env',
  '# notes/**',
  ''
].join('\n')

export function snowignorePath(): string {
  return path.join(configDir(), '.snowignore')
}

function parsePatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

function readSnowignore(): SnowignoreResult {
  const file = snowignorePath()
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return { patterns: parsePatterns(raw), path: file, error: null }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { patterns: [], path: file, error: null }
    return { patterns: [], path: file, error: e.message }
  }
}

function writeDefaultSnowignore(): void {
  const file = snowignorePath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, defaultSnowignore, { flag: 'wx' })
  } catch {
    return
  }
}

function fileStamp(file: string): string {
  try {
    const stat = fs.statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return ''
  }
}

let cache: { stamp: string; error: string | null; matcher: Ignore | null } | null = null

function currentMatcher(): Ignore | null {
  const file = snowignorePath()
  const stamp = fileStamp(file)

  if (!cache || cache.stamp !== stamp) {
    const { patterns, error } = readSnowignore()
    cache = {
      stamp,
      error,
      matcher: error || patterns.length === 0 ? null : ignore().add(patterns)
    }
  }

  if (cache.error) throw new Error(`Could not read ${file}\n${cache.error}`)
  return cache.matcher
}

export function filterPaths(paths: string[]): string[] {
  const active = currentMatcher()
  if (!active) return paths
  return paths.filter((p) => {
    const normalized = p.replace(/\\/g, '/').replace(/^\.\//, '')
    if (normalized === '' || normalized.startsWith('/')) return true
    return !active.ignores(normalized)
  })
}

let watcher: fs.FSWatcher | null = null
let timer: NodeJS.Timeout | null = null

function watchSnowignore(): void {
  const file = snowignorePath()
  const name = path.basename(file)
  try {
    const fsWatcher = fs.watch(path.dirname(file), (_event, filename) => {
      if (filename && path.basename(filename) !== name) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        cache = null
        const result = readSnowignore()
        log(result.error ? 'error' : 'info', 'snowignore', 'reloaded', {
          path: result.path,
          patterns: result.patterns.length,
          error: result.error
        })
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed())
            window.webContents.send('snowignore:changed', result)
        }
      }, 120)
    })
    fsWatcher.on('error', () => fsWatcher.close())
    watcher = fsWatcher
  } catch {
    watcher = null
  }
}

export function disposeSnowignoreWatcher(): void {
  watcher?.close()
  watcher = null
  if (timer) clearTimeout(timer)
  timer = null
  cache = null
}

export function registerSnowignoreHandlers(): void {
  writeDefaultSnowignore()
  watchSnowignore()
  ipcMain.handle('snowignore:get', (): SnowignoreResult => readSnowignore())
}
