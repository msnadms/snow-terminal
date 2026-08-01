import { ipcMain } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { broadcast } from './config'
import { log } from './log'

export interface UsageResult {
  day: number
  week: number
  error: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

function projectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

interface Rates {
  input: number
  output: number
}

function ratesFor(model: string): Rates {
  const m = model.toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) return { input: 10, output: 50 }
  if (m.includes('opus')) return { input: 5, output: 25 }
  if (m.includes('sonnet')) return { input: 3, output: 15 }
  if (m.includes('haiku')) return { input: 1, output: 5 }
  return { input: 0, output: 0 }
}

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

function costOf(model: string, usage: Usage): number {
  const { input, output } = ratesFor(model)
  if (!input && !output) return 0
  const perIn = input / 1_000_000
  const perOut = output / 1_000_000
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const write5m = usage.cache_creation?.ephemeral_5m_input_tokens
  const write = write5m === undefined ? (usage.cache_creation_input_tokens ?? 0) - write1h : write5m
  return (
    (usage.input_tokens ?? 0) * perIn +
    (usage.output_tokens ?? 0) * perOut +
    (usage.cache_read_input_tokens ?? 0) * perIn * 0.1 +
    Math.max(0, write) * perIn * 1.25 +
    write1h * perIn * 2
  )
}

interface Entry {
  key: string
  ts: number
  cost: number
}

interface CachedFile {
  mtimeMs: number
  size: number
  entries: Entry[]
}

const fileCache = new Map<string, CachedFile>()

function parseFile(full: string): Entry[] {
  let raw: string
  try {
    raw = fs.readFileSync(full, 'utf8')
  } catch {
    return []
  }
  const entries: Entry[] = []
  for (const line of raw.split('\n')) {
    if (!line.includes('"usage"')) continue
    let entry: {
      timestamp?: string
      requestId?: string
      message?: { model?: string; id?: string; usage?: Usage }
    }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const usage = entry.message?.usage
    if (!usage || !entry.timestamp) continue
    const ts = Date.parse(entry.timestamp)
    if (Number.isNaN(ts)) continue
    const key = `${entry.message?.id ?? ''}:${entry.requestId ?? ''}`
    entries.push({ key, ts, cost: costOf(entry.message?.model ?? '', usage) })
  }
  return entries
}

function computeUsage(): UsageResult {
  const dir = projectsDir()
  const now = Date.now()
  const dayAgo = now - DAY_MS
  const weekAgo = now - WEEK_MS
  const seen = new Set<string>()
  let day = 0
  let week = 0

  let projects: string[]
  try {
    projects = fs.readdirSync(dir)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { day: 0, week: 0, error: null }
    return { day: 0, week: 0, error: e.message }
  }

  const live = new Set<string>()
  const all: Entry[] = []
  for (const project of projects) {
    const projectDir = path.join(dir, project)
    let files: string[]
    try {
      files = fs.readdirSync(projectDir)
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const full = path.join(projectDir, file)
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.mtimeMs < weekAgo) continue
      live.add(full)
      const cached = fileCache.get(full)
      const entries =
        cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
          ? cached.entries
          : parseFile(full)
      if (entries !== cached?.entries) {
        fileCache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, entries })
      }
      for (const entry of entries) all.push(entry)
    }
  }

  for (const full of fileCache.keys()) {
    if (!live.has(full)) fileCache.delete(full)
  }

  for (const { key, ts, cost } of all) {
    if (ts < weekAgo) continue
    if (key !== ':' && seen.has(key)) continue
    seen.add(key)
    week += cost
    if (ts >= dayAgo) day += cost
  }

  return { day, week, error: null }
}

let watcher: fs.FSWatcher | null = null
let timer: NodeJS.Timeout | null = null

function watchUsage(): void {
  const dir = projectsDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    const fsWatcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
      if (filename && !filename.endsWith('.jsonl')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        broadcast('usage:changed', computeUsage())
      }, 1000)
    })
    fsWatcher.on('error', () => fsWatcher.close())
    watcher = fsWatcher
  } catch (err) {
    log('warn', 'usage', 'watch failed', { error: String(err) })
    watcher = null
  }
}

export function disposeUsageWatcher(): void {
  watcher?.close()
  watcher = null
  if (timer) clearTimeout(timer)
  timer = null
}

export function registerUsageHandlers(): void {
  watchUsage()
  ipcMain.handle('usage:get', (): UsageResult => computeUsage())
}
