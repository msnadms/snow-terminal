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
  /** Cost per working directory, so a workflow can be asked what it has spent. */
  byDirectory: Record<string, number>
  error: string | null
}

const sessionStart = Date.now()
const readChunkBytes = 1024 * 1024

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
  dir: string
}

interface CachedFile {
  mtimeMs: number
  size: number
  offset: number
  entries: Entry[]
  agent: UsageAgent
  state: ParserState
}

/**
 * Both CLIs record the session's own working directory, so nothing has to decode
 * `~/.claude/projects/<dashed-cwd>/` - an encoding that maps separators and dots onto the same
 * character and cannot be reversed.
 */
function normalizeDir(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return ''
  return path.resolve(raw).split(path.sep).join('/').replace(/\/+$/, '')
}

interface ParserState {
  model: string
  dir: string
}

function parseClaudeLines(lines: string[]): Entry[] {
  const entries: Entry[] = []
  for (const line of lines) {
    if (!line.includes('"usage"')) continue
    let entry: {
      timestamp?: string
      requestId?: string
      cwd?: string
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
    entries.push({
      key,
      ts,
      cost: anthropicCost(entry.message?.model ?? '', usage),
      dir: normalizeDir(entry.cwd)
    })
  }
  return entries
}

function parseCodexLines(lines: string[], state: ParserState): Entry[] {
  const entries: Entry[] = []
  for (const line of lines) {
    const meta = !state.dir && line.includes('"session_meta"')
    if (!meta && !line.includes('"model"') && !line.includes('"token_count"')) continue
    let entry: {
      timestamp?: string
      type?: string
      payload?: {
        type?: string
        model?: string
        cwd?: string
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
    // A rollout tags its opening record on the envelope, while every event tags itself on the
    // payload - so `session_meta` is read from `entry.type`, not from `payload.type`.
    if (entry.type === 'session_meta') {
      state.dir = normalizeDir(payload.cwd)
      continue
    }
    if (payload.model) state.model = payload.model
    if (payload.type !== 'token_count') continue
    const usage = payload.info?.last_token_usage
    if (!usage || !entry.timestamp) continue
    const ts = Date.parse(entry.timestamp)
    if (Number.isNaN(ts)) continue
    entries.push({ key: ':', ts, cost: codexCost(state.model, usage), dir: state.dir })
  }
  // A rollout's cwd normally arrives first. Preserve the old repair behavior for an unusual chunk
  // where metadata and usage were observed in the opposite order.
  return state.dir
    ? entries.map((entry) => (entry.dir ? entry : { ...entry, dir: state.dir }))
    : entries
}

interface Source {
  agent: UsageAgent
  dir: string
  parse: (lines: string[], state: ParserState) => Entry[]
}

const sources: Source[] = [
  {
    agent: 'claude',
    dir: path.join(os.homedir(), '.claude', 'projects'),
    parse: (lines) => parseClaudeLines(lines)
  },
  {
    agent: 'codex',
    dir: path.join(os.homedir(), '.codex', 'sessions'),
    parse: parseCodexLines
  }
]

const fileCache = new Map<string, CachedFile>()

async function sessionFiles(dir: string): Promise<string[]> {
  const names = await fs.promises.readdir(dir, { recursive: true })
  return names
    .map((name) => String(name))
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(dir, name))
}

async function updateFile(source: Source, full: string): Promise<void> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(full)
  } catch {
    fileCache.delete(full)
    return
  }

  const cached = fileCache.get(full)
  if (!cached && stat.mtimeMs < sessionStart) return
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return

  const reset = !cached || cached.agent !== source.agent || stat.size < cached.offset
  const offset = reset ? 0 : cached.offset
  const state: ParserState = reset ? { model: '', dir: '' } : { ...cached.state }
  const entries = reset ? [] : [...cached.entries]
  const length = stat.size - offset

  if (length > 0) {
    let handle: fs.promises.FileHandle
    try {
      handle = await fs.promises.open(full, 'r')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') fileCache.delete(full)
      return
    }
    let position = offset
    let pending = Buffer.alloc(0)
    try {
      while (position < stat.size) {
        const data = Buffer.allocUnsafe(Math.min(readChunkBytes, stat.size - position))
        const result = await handle.read(data, 0, data.length, position)
        if (!result.bytesRead) break
        position += result.bytesRead

        const chunk = data.subarray(0, result.bytesRead)
        const complete = pending.length ? Buffer.concat([pending, chunk]) : chunk
        const newline = complete.lastIndexOf(0x0a)
        if (newline >= 0) {
          const lines = complete.subarray(0, newline).toString('utf8').split('\n')
          entries.push(...source.parse(lines, state))
          pending = complete.subarray(newline + 1)
        } else {
          pending = complete
        }

        // Parsing stays in the main process, but yielding between bounded chunks keeps terminal IPC
        // responsive during the one-time read of an already-large active session.
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    } catch {
      return
    } finally {
      await handle.close().catch(() => undefined)
    }

    // Advance only through complete JSONL records. If a watcher observes a partial append, the
    // unfinished bytes are read again after the writer terminates the line.
    fileCache.set(full, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      offset: position - pending.length,
      entries,
      agent: source.agent,
      state
    })
    return
  }

  fileCache.set(full, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    offset,
    entries,
    agent: source.agent,
    state
  })
}

function aggregateUsage(error: string | null): UsageResult {
  const agents: Record<UsageAgent, number> = { claude: 0, codex: 0 }
  const byDirectory: Record<string, number> = {}
  const seen: Record<UsageAgent, Set<string>> = { claude: new Set(), codex: new Set() }

  for (const cached of fileCache.values()) {
    for (const { key, ts, cost, dir } of cached.entries) {
      if (ts < sessionStart) continue
      if (key !== ':' && seen[cached.agent].has(key)) continue
      seen[cached.agent].add(key)
      agents[cached.agent] += cost
      if (dir) byDirectory[dir] = (byDirectory[dir] ?? 0) + cost
    }
  }

  return { session: agents.claude + agents.codex, agents, byDirectory, error }
}

async function refreshAllUsage(): Promise<UsageResult> {
  const live = new Set<string>()
  let error: string | null = null
  for (const source of sources) {
    let files: string[]
    try {
      files = await sessionFiles(source.dir)
    } catch (err) {
      const failure = err as NodeJS.ErrnoException
      if (failure.code !== 'ENOENT') error = error ?? failure.message
      continue
    }
    for (let i = 0; i < files.length; i += 32) {
      const batch = files.slice(i, i + 32)
      batch.forEach((full) => live.add(full))
      await Promise.all(batch.map((full) => updateFile(source, full)))
    }
  }
  for (const full of fileCache.keys()) {
    if (!live.has(full)) fileCache.delete(full)
  }
  return aggregateUsage(error)
}

const watchers: fs.FSWatcher[] = []
let timer: NodeJS.Timeout | null = null
let lastUsage: UsageResult = {
  session: 0,
  agents: { claude: 0, codex: 0 },
  byDirectory: {},
  error: null
}
let initialized = false
let initialRefresh: Promise<UsageResult> | null = null
let refreshQueue: Promise<unknown> = Promise.resolve()
const changedFiles = new Map<string, Source>()
let fullRefreshNeeded = false

function enqueueRefresh(run: () => Promise<UsageResult>): Promise<UsageResult> {
  const next = refreshQueue.then(run, run)
  refreshQueue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function initialUsage(): Promise<UsageResult> {
  if (initialized) return Promise.resolve(lastUsage)
  if (!initialRefresh) {
    initialRefresh = enqueueRefresh(refreshAllUsage).then(
      (result) => {
        initialized = true
        lastUsage = result
        return result
      },
      (error) => {
        initialRefresh = null
        throw error
      }
    )
  }
  return initialRefresh
}

async function refreshChangedUsage(): Promise<UsageResult> {
  await initialUsage()
  return enqueueRefresh(async () => {
    // A source error from the previous full scan may be transient. Retry every source on the next
    // watcher event so a normal named-file update can clear the error and restore the usage meter.
    const rescan = fullRefreshNeeded || lastUsage.error !== null
    fullRefreshNeeded = false
    const files = [...changedFiles]
    changedFiles.clear()

    if (rescan) {
      lastUsage = await refreshAllUsage()
      return lastUsage
    }

    await Promise.all(files.map(([full, source]) => updateFile(source, full)))
    lastUsage = aggregateUsage(lastUsage.error)
    return lastUsage
  })
}

function scheduleUsageRefresh(source: Source, filename: string | Buffer | null): void {
  if (filename) {
    const relative = String(filename)
    if (!relative.endsWith('.jsonl')) return
    changedFiles.set(path.join(source.dir, relative), source)
  } else {
    fullRefreshNeeded = true
  }
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void refreshChangedUsage()
      .then((result) => broadcast('usage:changed', result))
      .catch((err) => log('warn', 'usage', 'refresh failed', { error: String(err) }))
  }, 1000)
}

function watchUsage(): void {
  for (const source of sources) {
    const { dir, agent } = source
    try {
      if (!fs.existsSync(path.dirname(dir))) continue
      fs.mkdirSync(dir, { recursive: true })
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        scheduleUsageRefresh(source, filename)
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
  changedFiles.clear()
  fullRefreshNeeded = false
}

export function registerUsageHandlers(): void {
  watchUsage()
  ipcMain.handle('usage:get', (): Promise<UsageResult> => initialUsage())
}
