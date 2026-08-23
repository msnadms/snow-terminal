import { ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { broadcast, configDir } from './config'
import { log } from './log'

export type AgentState = 'busy' | 'attention' | 'idle'

export interface AgentSession {
  sessionId: string
  terminal?: string
  cwd: string
  state: AgentState
  detail: string
  agent: string
  updated: number
}

export interface AgentsResult {
  sessions: AgentSession[]
  error: string | null
}

/**
 * A record is self-healing: every hook event rewrites it, so expiring one early costs at most a
 * missing badge until the session's next event. Expiring one late is the worse error - it invents
 * a fleet of agents that finished hours ago. `attention` is the exception in both directions,
 * because it is the one state where nothing further happens until a human acts, so no event will
 * arrive to refresh it and a short window would retire the signal most worth surfacing.
 */
const staleMs: Record<AgentState, number> = {
  attention: 12 * 60 * 60 * 1000,
  busy: 30 * 60 * 1000,
  idle: 30 * 60 * 1000
}
const debounceMs = 150
const states: AgentState[] = ['busy', 'attention', 'idle']

export function agentsDir(): string {
  return path.join(configDir(), 'agents')
}

function parseSession(full: string): AgentSession | null {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(full, 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.sessionId !== 'string' || typeof o.cwd !== 'string') return null
  if (!states.includes(o.state as AgentState)) return null
  if (typeof o.updated !== 'number' || !Number.isFinite(o.updated)) return null
  return {
    sessionId: o.sessionId,
    ...(typeof o.terminal === 'string' && o.terminal ? { terminal: o.terminal } : {}),
    cwd: o.cwd,
    state: o.state as AgentState,
    detail: typeof o.detail === 'string' ? o.detail : '',
    agent: typeof o.agent === 'string' ? o.agent : '',
    updated: o.updated
  }
}

function listRecords(dir: string): { names: string[]; error: NodeJS.ErrnoException | null } {
  try {
    return { names: fs.readdirSync(dir).filter((name) => name.endsWith('.json')), error: null }
  } catch (err) {
    return { names: [], error: err as NodeJS.ErrnoException }
  }
}

/**
 * Claude's SessionEnd hook is skipped when Snow kills its terminal. The hook inherits a unique
 * terminal token, so remove only the records that belonged to those terminals and leave agents in
 * other tabs (or started outside Snow) alone. Like the other config modules, this only writes -
 * the directory watcher is what broadcasts, so closing a window of panes is one reload.
 */
export function removeAgentsForTerminals(terminals: ReadonlySet<string>): void {
  if (!terminals.size) return
  const dir = agentsDir()
  const { names, error } = listRecords(dir)
  if (error) {
    if (error.code !== 'ENOENT') log('warn', 'agents', 'cleanup failed', { error: String(error) })
    return
  }

  for (const name of names) {
    const full = path.join(dir, name)
    const terminal = parseSession(full)?.terminal
    if (!terminal || !terminals.has(terminal)) continue
    try {
      fs.rmSync(full, { force: true })
    } catch (err) {
      log('warn', 'agents', 'cleanup failed', { file: full, error: String(err) })
    }
  }
}

export function readAgents(): AgentsResult {
  const dir = agentsDir()
  const { names, error } = listRecords(dir)
  if (error) return { sessions: [], error: error.code === 'ENOENT' ? null : error.message }

  const now = Date.now()
  const sessions: AgentSession[] = []
  for (const name of names) {
    const full = path.join(dir, name)
    const session = parseSession(full)
    if (!session) continue
    // A session killed at the terminal never fires SessionEnd, so nothing else deletes its file.
    if (session.updated < now - staleMs[session.state]) {
      fs.rmSync(full, { force: true })
      continue
    }
    sessions.push(session)
  }
  return { sessions, error: null }
}

let watcher: fs.FSWatcher | null = null
let timer: NodeJS.Timeout | null = null

function watchAgents(): void {
  const dir = agentsDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    const handle = fs.watch(dir, (_event, filename) => {
      if (filename && !filename.endsWith('.json')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        broadcast('agents:changed', readAgents())
      }, debounceMs)
    })
    handle.on('error', () => handle.close())
    watcher = handle
  } catch (err) {
    log('warn', 'agents', 'watch failed', { dir, error: String(err) })
  }
}

export function disposeAgentWatcher(): void {
  watcher?.close()
  watcher = null
  if (timer) clearTimeout(timer)
  timer = null
}

export function registerAgentHandlers(): void {
  watchAgents()
  ipcMain.handle('agents:get', (): AgentsResult => readAgents())
}
