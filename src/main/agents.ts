import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { broadcast, configDir, expandHome, samePath } from './config'
import { mainWorktreeRoot, objectId, worktreeMap } from './gitCore'
import { log } from './log'
import { addRecord, recordsFor, workflowsPath } from './registry'

export type AgentState = 'busy' | 'attention' | 'idle'

export interface CodeLink {
  path: string
  line?: number
  endLine?: number
}

export interface CodeLinks {
  root: string
  at: number
  items: CodeLink[]
}

export interface AgentTurn {
  root: string
  base: string
  end?: string
  promptId?: string
  at: number
}

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
  promptId?: string
  links?: CodeLinks
  turn?: AgentTurn
}

export interface AgentsResult {
  sessions: AgentSession[]
  error: string | null
}

const staleMs: Record<AgentState, number> = {
  attention: 12 * 60 * 60 * 1000,
  busy: 30 * 60 * 1000,
  idle: 30 * 60 * 1000
}
const debounceMs = 150
const states: AgentState[] = ['busy', 'attention', 'idle']

export const agentOwner = randomUUID()

export function agentsDir(): string {
  return path.join(configDir(), 'agents')
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function safeRelative(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  if (path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false
  return !value.split(/[\\/]/).includes('..')
}

export function parseLinks(raw: unknown): CodeLinks | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const at = positive(o.at)
  if (!at || typeof o.root !== 'string' || !path.isAbsolute(o.root) || !Array.isArray(o.items))
    return undefined
  const items: CodeLink[] = []
  const seen = new Set<string>()
  for (const item of o.items) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (!safeRelative(entry.path)) continue
    const line = positive(entry.line)
    const end = positive(entry.endLine)
    const endLine = line && end && end > line ? end : undefined
    const key = `${entry.path}:${line ?? ''}-${endLine ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ path: entry.path, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}) })
  }
  return items.length > 0 ? { root: o.root, at, items } : undefined
}

export function parseTurn(raw: unknown): AgentTurn | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const at = positive(o.at)
  if (!at || typeof o.root !== 'string' || !path.isAbsolute(o.root)) return undefined
  if (typeof o.base !== 'string' || !objectId.test(o.base)) return undefined
  const end = typeof o.end === 'string' && objectId.test(o.end) ? o.end : undefined
  const promptId = typeof o.promptId === 'string' && o.promptId ? o.promptId : undefined
  return {
    root: o.root,
    base: o.base,
    ...(end ? { end } : {}),
    ...(promptId ? { promptId } : {}),
    at
  }
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
  const links = parseLinks(o.links)
  const turn = parseTurn(o.turn)
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
    updated: o.updated,
    ...(typeof o.promptId === 'string' && o.promptId ? { promptId: o.promptId } : {}),
    ...(links ? { links } : {}),
    ...(turn ? { turn } : {})
  }
}

function listRecords(dir: string): { names: string[]; error: NodeJS.ErrnoException | null } {
  try {
    return { names: fs.readdirSync(dir).filter((name) => name.endsWith('.json')), error: null }
  } catch (err) {
    return { names: [], error: err as NodeJS.ErrnoException }
  }
}

type LiveTerminal = { id: number; since: number }

const live = new Map<string, LiveTerminal>()

const reported = new Set<string>()

let workflowRegistration: Promise<void> | null = null
let pendingWorkflowRegistration: AgentSession[] | null = null
let acceptingWorkflowRegistrations = false

export async function registerAgentWorktrees(sessions: AgentSession[]): Promise<void> {
  const cwds = sessions
    .map((session) => session.cwd.trim())
    .filter((cwd, index, all) => cwd && all.findIndex((known) => samePath(known, cwd)) === index)
  const repos: string[] = []

  for (const cwd of cwds) {
    const repo = await mainWorktreeRoot(cwd)
    if (!repo || repos.some((known) => samePath(known, repo))) continue
    repos.push(repo)
  }

  for (const repo of repos) {
    const linked = await worktreeMap(repo)

    const { records, error } = recordsFor(repo)
    if (error) {
      log('warn', 'agents', 'workflow registration skipped', {
        repo,
        path: workflowsPath(),
        error
      })
      continue
    }

    for (const [branch, directory] of linked) {
      if (samePath(directory, repo)) continue
      const existing = records.find((record) => record.branch === branch)
      if (existing?.worktree && samePath(expandHome(existing.worktree), directory)) continue

      const failed = addRecord(repo, branch, directory)
      if (failed) {
        log('warn', 'agents', 'workflow registration failed', {
          repo,
          branch,
          worktree: directory,
          path: workflowsPath(),
          error: failed
        })
        continue
      }
      log('info', 'agents', 'worktree registered as workflow', {
        repo,
        branch,
        worktree: directory
      })
    }
  }
}

function scheduleWorkflowRegistration(sessions: AgentSession[]): void {
  if (!acceptingWorkflowRegistrations) return
  if (sessions.length === 0) {
    pendingWorkflowRegistration = null
    return
  }
  pendingWorkflowRegistration = sessions.map((session) => ({ ...session }))
  if (workflowRegistration) return

  workflowRegistration = (async () => {
    try {
      while (acceptingWorkflowRegistrations && pendingWorkflowRegistration) {
        const snapshot = pendingWorkflowRegistration
        pendingWorkflowRegistration = null
        try {
          await registerAgentWorktrees(snapshot)
        } catch (error) {
          log('warn', 'agents', 'workflow discovery failed', { error: String(error) })
        }
      }
    } finally {
      workflowRegistration = null
    }
  })()
}

function announce(token: string): void {
  if (reported.has(token)) scheduleBroadcast()
}

export function retainTerminal(token: string, id: number): void {
  live.set(token, { id, since: Date.now() })
}

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
  scheduleWorkflowRegistration(sessions)
  return { sessions, error: null }
}

let watcher: fs.FSWatcher | null = null
let timer: NodeJS.Timeout | null = null

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
  acceptingWorkflowRegistrations = false
  pendingWorkflowRegistration = null
  watcher?.close()
  watcher = null
  if (timer) clearTimeout(timer)
  timer = null

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
  acceptingWorkflowRegistrations = true
  watchAgents()
  ipcMain.handle('agents:get', (): AgentsResult => readAgents())
}
