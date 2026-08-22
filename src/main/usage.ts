import { ipcMain } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { broadcast } from './config'
import { log } from './log'

export type UsageAgent = 'claude' | 'codex'

export interface UsageResult {
  session: number
  agents: Record<UsageAgent, number>
  error: string | null
}

const sessionStart = Date.now()

interface Rates {
  input: number
  output: number
}

function anthropicRates(model: string): Rates {
  const m = model.toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) return { input: 10, output: 50 }
  if (m.includes('opus')) return { input: 5, output: 25 }
  if (m.includes('sonnet')) return { input: 3, output: 15 }
  if (m.includes('haiku')) return { input: 1, output: 5 }
  return { input: 0, output: 0 }
}

function openaiRates(model: string): Rates {
  const m = model.toLowerCase()
  if (!m.startsWith('gpt-5') && !m.startsWith('codex')) return { input: 0, output: 0 }
  if (m.includes('codex-mini')) return { input: 1.5, output: 6 }
  if (m.includes('nano')) return { input: 0.05, output: 0.4 }
  if (m.includes('mini')) return { input: 0.25, output: 2 }
  return { input: 1.25, output: 10 }
}

interface AnthropicUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

function anthropicCost(model: string, usage: AnthropicUsage): number {
  const { input, output } = anthropicRates(model)
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

interface CodexUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
}

function codexCost(model: string, usage: CodexUsage): number {
  const { input, output } = openaiRates(model)
  if (!input && !output) return 0
  const perIn = input / 1_000_000
  const perOut = output / 1_000_000
  const cached = usage.cached_input_tokens ?? 0
  const uncached = Math.max(0, (usage.input_tokens ?? 0) - cached)
  return uncached * perIn + cached * perIn * 0.1 + (usage.output_tokens ?? 0) * perOut
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

function readLines(full: string): string[] {
  try {
    return fs.readFileSync(full, 'utf8').split('\n')
  } catch {
    return []
  }
}

function parseClaudeFile(full: string): Entry[] {
  const entries: Entry[] = []
  for (const line of readLines(full)) {
    if (!line.includes('"usage"')) continue
    let entry: {
      timestamp?: string
      requestId?: string
      message?: { model?: string; id?: string; usage?: AnthropicUsage }
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
    entries.push({ key, ts, cost: anthropicCost(entry.message?.model ?? '', usage) })
  }
  return entries
}

function parseCodexFile(full: string): Entry[] {
  const entries: Entry[] = []
  let model = ''
  for (const line of readLines(full)) {
    if (!line.includes('"model"') && !line.includes('"token_count"')) continue
    let entry: {
      timestamp?: string
      payload?: {
        type?: string
        model?: string
        info?: { last_token_usage?: CodexUsage }
      }
    }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    const payload = entry.payload
    if (!payload) continue
    if (payload.model) model = payload.model
    if (payload.type !== 'token_count') continue
    const usage = payload.info?.last_token_usage
    if (!usage || !entry.timestamp) continue
    const ts = Date.parse(entry.timestamp)
    if (Number.isNaN(ts)) continue
    entries.push({ key: ':', ts, cost: codexCost(model, usage) })
  }
  return entries
}

interface Source {
  agent: UsageAgent
  dir: string
  parse: (full: string) => Entry[]
}

const sources: Source[] = [
  { agent: 'claude', dir: path.join(os.homedir(), '.claude', 'projects'), parse: parseClaudeFile },
  { agent: 'codex', dir: path.join(os.homedir(), '.codex', 'sessions'), parse: parseCodexFile }
]

const fileCache = new Map<string, CachedFile>()

function sessionFiles(dir: string): string[] | NodeJS.ErrnoException {
  try {
    return fs
      .readdirSync(dir, { recursive: true })
      .map((name) => String(name))
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(dir, name))
  } catch (err) {
    return err as NodeJS.ErrnoException
  }
}

function computeUsage(): UsageResult {
  const agents: Record<UsageAgent, number> = { claude: 0, codex: 0 }
  const live = new Set<string>()
  let error: string | null = null

  for (const source of sources) {
    const files = sessionFiles(source.dir)
    if (!Array.isArray(files)) {
      if (files.code !== 'ENOENT') error = error ?? files.message
      continue
    }

    const seen = new Set<string>()
    for (const full of files) {
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.mtimeMs < sessionStart) continue
      live.add(full)
      const cached = fileCache.get(full)
      const entries =
        cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size
          ? cached.entries
          : source.parse(full)
      if (entries !== cached?.entries) {
        fileCache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, entries })
      }
      for (const { key, ts, cost } of entries) {
        if (ts < sessionStart) continue
        if (key !== ':' && seen.has(key)) continue
        seen.add(key)
        agents[source.agent] += cost
      }
    }
  }

  for (const full of fileCache.keys()) {
    if (!live.has(full)) fileCache.delete(full)
  }

  return { session: agents.claude + agents.codex, agents, error }
}

const watchers: fs.FSWatcher[] = []
let timer: NodeJS.Timeout | null = null

function watchUsage(): void {
  for (const { dir, agent } of sources) {
    try {
      if (!fs.existsSync(path.dirname(dir))) continue
      fs.mkdirSync(dir, { recursive: true })
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && !filename.endsWith('.jsonl')) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          broadcast('usage:changed', computeUsage())
        }, 1000)
      })
      watcher.on('error', () => watcher.close())
      watchers.push(watcher)
    } catch (err) {
      log('warn', 'usage', 'watch failed', { agent, error: String(err) })
    }
  }
}

export function disposeUsageWatcher(): void {
  for (const watcher of watchers) watcher.close()
  watchers.length = 0
  if (timer) clearTimeout(timer)
  timer = null
}

export function registerUsageHandlers(): void {
  watchUsage()
  ipcMain.handle('usage:get', (): UsageResult => computeUsage())
}
