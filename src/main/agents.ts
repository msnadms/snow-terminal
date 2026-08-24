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
 * A record carrying a terminal token is Snow's to account for, and this map is the whole of that
 * accounting: the token is minted per spawn and inherited by the hook, so such a record is
 * meaningful only while that PTY is alive and only from the moment the terminal last became the
 * agent's. The value is that moment - a spawn sets it, an interruption or a returning shell prompt
 * bumps it, and death drops the token. Every teardown path used to restate the rule by sweeping
 * the directory itself, which is what let a path be forgotten (a phantom `busy` agent) and put a
 * synchronous readdir of every record on the keystroke and shell-prompt paths; they are all one
 * map write now, and `readAgents` applies the rule in the pass it already makes.
 *
 * A record with no token belongs to a Claude session started outside Snow and is never touched.
 * At startup nothing is retained, so every token from a previous run is orphaned by the same rule
 * rather than by a separate sweep - no Snow-owned PTY can outlive Snow's main process.
 */
const live = new Map<string, number>()

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

export function retainTerminal(token: string): void {
  live.set(token, Date.now())
}

/** The terminal is still alive, but the agent that was running in it is not. */
export function retireTerminal(token: string): void {
  if (!live.has(token)) return
  live.set(token, Date.now())
  announce(token)
}

export function releaseTerminal(token: string): void {
  if (!live.delete(token)) return
  announce(token)
}

function orphaned(session: AgentSession): boolean {
  if (!session.terminal) return false
  const since = live.get(session.terminal)
  return since === undefined || session.updated < since
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
    if (session.terminal) reported.add(session.terminal)
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
}

export function registerAgentHandlers(): void {
  watchAgents()
  ipcMain.handle('agents:get', (): AgentsResult => readAgents())
}
