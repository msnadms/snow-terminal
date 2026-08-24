import { normalizePath } from './format'

export type SessionStatus = 'busy' | 'attention' | 'idle'

export interface StatusSession {
  cwd: string
  state: SessionStatus
  detail: string
  updated: number
  terminalId?: number
}

export interface WorkflowStatusSession extends StatusSession {
  sessionId: string
  agent: string
}

export interface TerminalStatusFallback {
  terminalId: number
  cwd?: string
  state?: SessionStatus
  detail?: string
}

export type AgentDir = { state: SessionStatus; detail: string; updated: number }

const rank: Record<SessionStatus, number> = { attention: 2, busy: 1, idle: 0 }

function better(candidate: AgentDir, current: AgentDir | undefined): boolean {
  return (
    !current ||
    rank[candidate.state] > rank[current.state] ||
    (rank[candidate.state] === rank[current.state] && candidate.updated > current.updated)
  )
}

function visible(session: StatusSession, interruptedTerminals: Record<number, number>): boolean {
  if (session.terminalId == null) return true
  return session.updated > (interruptedTerminals[session.terminalId] ?? 0)
}

/** Apply terminal-specific interruption tombstones before any tab or workflow consumes records. */
export function visibleAgentSessions<T extends StatusSession>(
  sessions: T[],
  interruptedTerminals: Record<number, number>
): T[] {
  return sessions.filter((session) => visible(session, interruptedTerminals))
}

/**
 * Keep hook records authoritative per terminal, but represent a busy terminal with no record so
 * workflow counts do not blink out when the tab dot falls back to byte activity. Heuristic
 * `attention` means only that output stopped while the tab was inactive; it cannot assert that an
 * agent requested input, so only a real hook record may contribute that state to a workflow chip.
 */
export function workflowSessionsOf<T extends WorkflowStatusSession>(
  sessions: T[],
  terminals: TerminalStatusFallback[]
): WorkflowStatusSession[] {
  const reportedTerminals = new Set(
    sessions
      .map((session) => session.terminalId)
      .filter((terminalId): terminalId is number => terminalId != null)
  )
  const result: WorkflowStatusSession[] = [...sessions]
  for (const terminal of terminals) {
    if (reportedTerminals.has(terminal.terminalId) || !terminal.cwd || terminal.state !== 'busy')
      continue
    result.push({
      sessionId: `snow-terminal:${terminal.terminalId}`,
      terminalId: terminal.terminalId,
      cwd: terminal.cwd,
      state: terminal.state,
      detail: terminal.detail ?? '',
      agent: '',
      updated: 0
    })
  }
  return result
}

function statusOf(session: StatusSession): AgentDir {
  return { state: session.state, detail: session.detail, updated: session.updated }
}

/** Collapse all live records in one directory to the state most worth surfacing. */
export function agentDirsOf(
  sessions: StatusSession[],
  interruptedTerminals: Record<number, number>
): Record<string, AgentDir> {
  const result: Record<string, AgentDir> = {}
  for (const session of sessions) {
    if (!session.cwd || !visible(session, interruptedTerminals)) continue
    const key = normalizePath(session.cwd)
    const candidate = statusOf(session)
    if (better(candidate, result[key])) result[key] = candidate
  }
  return result
}

/**
 * Resolve a tab from the terminals it owns. Hook state overrides the byte heuristic only for the
 * terminal that reported it; the loudest resulting terminal wins the tab dot. Cwd deliberately
 * plays no part: several tabs may start in the same directory, and an external agent there belongs
 * to the workflow rollup rather than to an arbitrary Snow tab.
 */
export function tabStatusIn(
  sessions: StatusSession[],
  interruptedTerminals: Record<number, number>,
  terminalIds: number[],
  terminalStatuses: Record<number, SessionStatus>
): SessionStatus | undefined {
  return tabStatusFrom(
    terminalAgentsOf(sessions, interruptedTerminals),
    terminalIds,
    terminalStatuses
  )
}

/** Index the best hook report for each terminal once before resolving multiple tabs. */
export function terminalAgentsOf(
  sessions: StatusSession[],
  interruptedTerminals: Record<number, number>
): Map<number, AgentDir> {
  const agents = new Map<number, AgentDir>()
  for (const session of sessions) {
    if (session.terminalId == null || !visible(session, interruptedTerminals)) continue
    const candidate = statusOf(session)
    const current = agents.get(session.terminalId)
    if (better(candidate, current)) agents.set(session.terminalId, candidate)
  }
  return agents
}

/** Resolve a tab from a pre-indexed terminal map. */
export function tabStatusFrom(
  agents: ReadonlyMap<number, AgentDir>,
  terminalIds: number[],
  terminalStatuses: Record<number, SessionStatus>
): SessionStatus | undefined {
  let result: AgentDir | undefined
  for (const terminalId of terminalIds) {
    const agent = agents.get(terminalId)
    const state = agent?.state ?? terminalStatuses[terminalId]
    if (!state) continue
    const candidate = agent ?? { state, detail: '', updated: 0 }
    if (better(candidate, result)) result = candidate
  }
  return result?.state
}
