import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { broadcast, configDir } from './config'
import { log } from './log'

export type AgentState = 'busy' | 'attention' | 'idle'

export interface AgentSession {
  sessionId: string
  terminal?: string
  terminalOwner?: string
  terminalId?: number
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

/** Distinguishes terminal bindings owned by concurrently running Snow main processes. */
export const agentOwner = randomUUID()

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
  const binding =
    typeof o.terminalBinding === 'string' && o.terminalBinding
      ? o.terminalBinding
      : typeof o.terminal === 'string' && o.terminal
        ? o.terminal
        : undefined
  return {
    sessionId: o.sessionId,
    ...(binding ? { terminal: binding } : {}),
    ...(typeof o.terminalOwner === 'string' && o.terminalOwner
      ? { terminalOwner: o.terminalOwner }
      : {}),
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
 * A record carrying a terminal token is Snow's to account for, and this map is the whole of that
 * accounting: the token is minted per spawn and inherited by the hook, so such a record is
 * meaningful only while that PTY is alive and only from the moment the terminal last became the
 * agent's. Each value carries the renderer's PTY id and that ownership moment - a spawn sets both,
 * an interruption or a returning shell prompt bumps the moment, and death drops the token. Every
 * teardown path used to restate the rule by sweeping the directory itself, which is what let a path
 * be forgotten (a phantom `busy` agent) and put a synchronous readdir of every record on the
 * keystroke and shell-prompt paths; they are all one map write now, and `readAgents` applies the
 * rule in the pass it already makes. The id is the stable pane ownership id, deliberately distinct
 * from the per-spawn transport id used to route PTY events.
 *
 * A record with no token belongs to a Claude session started outside Snow and is never touched.
 * Owner ids keep concurrently running Snow processes from retiring one another's terminals. On a
 * normal shutdown `disposeAgentWatcher` removes this process's records synchronously, since no
 * Snow-owned PTY can outlive its main process.
 */
type LiveTerminal = { id: number; since: number }

const live = new Map<string, LiveTerminal>()

/**
 * The tokens the last read actually reported. A terminal with no agent in it - a bottom shell, an
 * `npm run dev` split - is the common case, and both calls below run on paths as hot as a keypress,
 * so a token that is not on screen retires silently: there is nothing for a renderer to redraw.
 * A record written since that read has already announced itself through the directory watcher.
 */
const reported = new Set<string>()

function announce(token: string): void {
  if (reported.has(token)) scheduleBroadcast()
}

export function retainTerminal(token: string, id: number): void {
  live.set(token, { id, since: Date.now() })
}

/** The terminal is still alive, but the agent that was running in it is not. */
export function retireTerminal(token: string): void {
  const terminal = live.get(token)
  if (!terminal) return
  live.set(token, { ...terminal, since: Date.now() })
  announce(token)
}

export function releaseTerminal(token: string): void {
  if (!live.delete(token)) return
  announce(token)
}

function orphaned(session: AgentSession): boolean {
  if (!session.terminal) return false
  // A binding owned by another running Snow is valid, but cannot claim one of this window's tabs.
  // Treat it like an external session and leave cleanup to its owner (or ordinary staleness).
  if (session.terminalOwner && session.terminalOwner !== agentOwner) return false
  const terminal = live.get(session.terminal)
  return terminal === undefined || session.updated < terminal.since
}

export function readAgents(): AgentsResult {
  const dir = agentsDir()
  const { names, error } = listRecords(dir)
  if (error) return { sessions: [], error: error.code === 'ENOENT' ? null : error.message }

  const now = Date.now()
  const sessions: AgentSession[] = []
  reported.clear()
  for (const name of names) {
    const full = path.join(dir, name)
    const session = parseSession(full)
    if (!session) continue
    // A session killed at the terminal never fires SessionEnd, so nothing else deletes its file.
    if (orphaned(session) || session.updated < now - staleMs[session.state]) {
      try {
        fs.rmSync(full, { force: true })
      } catch (err) {
        log('warn', 'agents', 'cleanup failed', { file: full, error: String(err) })
      }
      continue
    }
    if (session.terminal) {
      const owned = !session.terminalOwner || session.terminalOwner === agentOwner
      if (owned) {
        reported.add(session.terminal)
        const terminal = live.get(session.terminal)
        if (terminal) session.terminalId = terminal.id
      }
    }
    sessions.push(session)
  }
  return { sessions, error: null }
}

let watcher: fs.FSWatcher | null = null
let timer: NodeJS.Timeout | null = null

/**
 * Retaining and releasing a token changes what `readAgents` reports without touching the directory,
 * so the registry has to announce itself; the watcher cannot. Sharing one debounce is what keeps a
 * window of panes closing at once - and the file deletions that pass then makes - to one reload.
 */
function scheduleBroadcast(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    broadcast('agents:changed', readAgents())
  }, debounceMs)
}

function watchAgents(): void {
  const dir = agentsDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    const handle = fs.watch(dir, (_event, filename) => {
      if (filename && !filename.endsWith('.json')) return
      scheduleBroadcast()
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

  // Releasing PTYs normally announces a debounced read, but will-quit tears this watcher down
  // before that timer can fire. Remove only this process's records now; another Snow instance may
  // be using the same agents directory and remains responsible for records carrying its owner id.
  const dir = agentsDir()
  const { names, error } = listRecords(dir)
  if (error) {
    if (error.code !== 'ENOENT') {
      log('warn', 'agents', 'shutdown cleanup failed', { dir, error: error.message })
    }
    return
  }
  for (const name of names) {
    const full = path.join(dir, name)
    const session = parseSession(full)
    if (session?.terminalOwner !== agentOwner) continue
    try {
      fs.rmSync(full, { force: true })
    } catch (err) {
      log('warn', 'agents', 'shutdown cleanup failed', { file: full, error: String(err) })
    }
  }
}

export function registerAgentHandlers(): void {
  watchAgents()
  ipcMain.handle('agents:get', (): AgentsResult => readAgents())
}
