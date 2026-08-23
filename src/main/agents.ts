import { ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import { broadcast, configDir } from './config'
import { log } from './log'

export type AgentState = 'busy' | 'attention' | 'idle'

export interface AgentSession {
  sessionId: string
  parentSessionId?: string
  cwd: string
  state: AgentState
  detail: string
  task?: string
  result?: string
  agent: string
  updated: number
}

export interface AgentsResult {
  sessions: AgentSession[]
  error: string | null
}

const staleMs = 12 * 60 * 60 * 1000
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
    ...(typeof o.parentSessionId === 'string' && o.parentSessionId
      ? { parentSessionId: o.parentSessionId }
      : {}),
    cwd: o.cwd,
    state: o.state as AgentState,
    detail: typeof o.detail === 'string' ? o.detail : '',
    ...(typeof o.task === 'string' && o.task ? { task: o.task } : {}),
    ...(typeof o.result === 'string' && o.result ? { result: o.result } : {}),
    agent: typeof o.agent === 'string' ? o.agent : 'claude',
    updated: o.updated
  }
}

export function readAgents(): AgentsResult {
  const dir = agentsDir()
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    return { sessions: [], error: e.code === 'ENOENT' ? null : e.message }
  }

  const cutoff = Date.now() - staleMs
  const sessions: AgentSession[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const full = path.join(dir, name)
    const session = parseSession(full)
    if (!session) continue
    // A session killed at the terminal never fires SessionEnd, so nothing else deletes its file.
    if (session.updated < cutoff) {
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
