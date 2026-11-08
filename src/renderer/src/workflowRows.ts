import { statusRank, type SessionStatus } from './agentStatus'
import { normalizePath } from '@renderer/format'
import { agentSummary, type AgentSession, type AgentSummary } from '@renderer/useAgents'
import {
  cleanupCandidate,
  cleanupOrphan,
  cleanupReasons,
  cleanupStale,
  inboxSignal,
  usable,
  type CleanupTarget,
  type InboxSignal,
  type WorkflowComparison,
  type WorkflowEntry,
  type WorkflowRepo
} from '@renderer/workflowText'

export type Overview = Awaited<ReturnType<typeof window.api.workflow.overview>>

export type Targeted = { repo: WorkflowRepo; entry: WorkflowEntry }

export type Activity = {
  status?: SessionStatus
  title?: string
  sessionId?: number
  agents: AgentSession[]
  summary: AgentSummary
}

export type WorkflowRow = {
  entry: WorkflowEntry
  activity: Activity
  dir: string | undefined
  order: number
  signal: InboxSignal
}

export type OpenSession = {
  id: number
  dir?: string
  directories: string[]
  label: string
  status?: SessionStatus
  title?: string
  terminalIds: number[]
}

export type SessionRow = {
  session: OpenSession
  activity: Activity
  signal: InboxSignal
  comparison?: WorkflowComparison
}

export type IndexedActivity = { activity: Activity }

export type WorkflowReviewTarget = { cwd: string; branch: string }

export const emptyActivity: Activity = {
  agents: [],
  summary: { waiting: 0, working: 0, names: [] }
}

const noActivity: IndexedActivity = { activity: emptyActivity }

export function openDir(repo: WorkflowRepo, entry: WorkflowEntry): string | undefined {
  if (usable(entry) && entry.worktree) return entry.worktree
  if (entry.current) return repo.repo
  return undefined
}

export function directoryKey(dir: string, windows = navigator.platform.startsWith('Win')): string {
  const normalized = normalizePath(dir)
  return windows ? normalized.toLowerCase() : normalized
}

export function orderRepos(repos: WorkflowRepo[], order: string[]): WorkflowRepo[] {
  const positions = new Map<string, number>()
  for (const [index, repo] of order.entries()) {
    const key = directoryKey(repo)
    if (!positions.has(key)) positions.set(key, index)
  }
  return repos
    .map((repo, index) => ({ repo, index, position: positions.get(directoryKey(repo.repo)) }))
    .sort(
      (left, right) =>
        (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index
    )
    .map(({ repo }) => repo)
}

export function signalTitle(signal: InboxSignal, activity: Activity): string {
  const names = activity.summary.names
  const who = names.length > 1 ? `${signal.label} (${names.join(', ')})` : signal.label
  return activity.title ? `${who}\n${activity.title}` : who
}

export function activitySignal(activity: Activity): InboxSignal {
  const { waiting, working } = activity.summary
  if (waiting > 0) {
    return {
      tier: 4,
      label: `${waiting === 1 ? 'needs input' : `${waiting} need input`}${
        working > 0 ? ` · ${working} working` : ''
      }`,
      slug: 'input'
    }
  }
  if (working > 0 || activity.status === 'busy') {
    return {
      tier: 2,
      label: working > 1 ? `${working} working` : 'working',
      slug: 'working'
    }
  }
  if (activity.status === 'attention') return { tier: 3, label: 'finished', slug: 'finished' }
  return { tier: 0, label: '', slug: '' }
}

export function statusTitle(status: SessionStatus, activity: Activity): string {
  if (status === 'busy') return 'Busy'
  return activity.summary.waiting > 0 ? 'Ready for input' : 'Finished'
}

export function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

export function failureList(label: string, title: string, detail: string): string {
  return `${label}: ${title}${detail ? `\n${indent(detail)}` : ''}`
}

export function workflowDirectories(repos: WorkflowRepo[]): Set<string> {
  return new Set(
    repos.flatMap((repo) =>
      repo.workflows.flatMap((entry) => {
        const dir = openDir(repo, entry)
        return dir ? [directoryKey(dir)] : []
      })
    )
  )
}

export function nonaffiliatedSessions(
  openSessions: OpenSession[],
  workflowDirs: Set<string>
): OpenSession[] {
  return openSessions.filter((session) => {
    if (!session.dir) return true
    const dir = directoryKey(session.dir)
    for (const workflowDir of workflowDirs) {
      if (dir === workflowDir || dir.startsWith(`${workflowDir}/`)) return false
    }
    return true
  })
}

interface ActivityInput {
  repos: WorkflowRepo[]
  nonaffiliated: OpenSession[]
  openSessions: OpenSession[]
  agentSessions: AgentSession[]
  sessionStatuses: Record<string, SessionStatus>
  sessionTitles: Record<string, string>
}

type ActivityBucket = {
  agents: AgentSession[]
  tabSelected: { path: string; status: SessionStatus; sessionId?: number } | null
}

export function indexActivity({
  repos,
  nonaffiliated,
  openSessions,
  agentSessions,
  sessionStatuses,
  sessionTitles
}: ActivityInput): Map<string, IndexedActivity> {
  const buckets = new Map<string, ActivityBucket>()
  const open = (dir: string): void => {
    const key = directoryKey(dir)
    if (!buckets.has(key)) buckets.set(key, { agents: [], tabSelected: null })
  }
  for (const repo of repos) {
    for (const entry of repo.workflows) {
      const dir = openDir(repo, entry)
      if (dir) open(dir)
    }
  }
  for (const session of nonaffiliated) if (session.dir) open(session.dir)

  const sessionsByDirectory = new Map<string, OpenSession[]>()
  for (const session of openSessions) {
    for (const dir of session.directories) {
      const key = directoryKey(dir)
      const current = sessionsByDirectory.get(key) ?? []
      if (!current.includes(session)) current.push(session)
      sessionsByDirectory.set(key, current)
    }
  }

  const visitOwners = (raw: string, visit: (row: ActivityBucket) => void): void => {
    let key = directoryKey(raw)
    while (key) {
      const row = buckets.get(key)
      if (row) visit(row)
      const slash = key.lastIndexOf('/')
      if (slash < 0) break
      const parent = key.slice(0, slash)
      if (!parent || parent === key) break
      key = parent
    }
  }

  for (const session of agentSessions) {
    if (session.state === 'idle' || !session.cwd) continue
    visitOwners(session.cwd, (row) => row.agents.push(session))
  }

  for (const [path, status] of Object.entries(sessionStatuses)) {
    const candidates = sessionsByDirectory.get(directoryKey(path)) ?? []
    const session = candidates.find((candidate) => candidate.status === status) ?? candidates[0]
    visitOwners(path, (row) => {
      if (!row.tabSelected || statusRank[status] > statusRank[row.tabSelected.status]) {
        row.tabSelected = { path, status, sessionId: session?.id }
      }
    })
  }

  const result = new Map<string, IndexedActivity>()
  for (const [key, row] of buckets) {
    const summary = agentSummary(row.agents)
    const tabTitle = row.tabSelected ? sessionTitles[row.tabSelected.path] : undefined
    result.set(key, { activity: bucketActivity(row, summary, tabTitle, openSessions) })
  }
  return result
}

function bucketActivity(
  row: ActivityBucket,
  summary: AgentSummary,
  tabTitle: string | undefined,
  openSessions: OpenSession[]
): Activity {
  if (!row.agents.length) {
    return row.tabSelected
      ? {
          status: row.tabSelected.status,
          title: row.tabSelected.status === 'idle' ? undefined : tabTitle,
          sessionId: row.tabSelected.sessionId,
          agents: row.agents,
          summary
        }
      : { agents: row.agents, summary }
  }
  const detail = row.agents
    .map((session) => session.detail)
    .filter(Boolean)
    .join('\n')
  const selectedState = summary.waiting ? 'attention' : summary.working ? 'busy' : undefined
  const selectedSession = selectedState
    ? openSessions.find((session) =>
        row.agents.some(
          (agent) =>
            agent.state === selectedState &&
            agent.terminalId != null &&
            session.terminalIds.includes(agent.terminalId)
        )
      )
    : undefined
  return {
    status: summary.waiting ? 'attention' : 'busy',
    title: tabTitle || detail,
    sessionId: selectedSession?.id,
    agents: row.agents,
    summary
  }
}

export function activityFor(indexed: Map<string, IndexedActivity>, dir: string): IndexedActivity {
  return indexed.get(directoryKey(dir)) ?? noActivity
}

export function sessionRowsOf(
  agentSessions: AgentSession[],
  sessions: OpenSession[],
  comparisons: Map<string, WorkflowComparison>
): SessionRow[] {
  const agentsByTerminal = new Map<number, AgentSession[]>()
  for (const agent of agentSessions) {
    if (agent.state === 'idle' || agent.terminalId == null) continue
    const current = agentsByTerminal.get(agent.terminalId) ?? []
    current.push(agent)
    agentsByTerminal.set(agent.terminalId, current)
  }

  return sessions
    .map((session): SessionRow => {
      const agents = session.terminalIds.flatMap(
        (terminalId) => agentsByTerminal.get(terminalId) ?? []
      )
      const summary = agentSummary(agents)
      const status = summary.waiting ? 'attention' : summary.working ? 'busy' : session.status
      const detail = agents
        .map((agent) => agent.detail)
        .filter(Boolean)
        .join('\n')
      const activity: Activity = {
        status,
        title: status === 'idle' ? undefined : session.title || detail || undefined,
        agents,
        summary
      }
      return {
        session,
        activity,
        signal: activitySignal(activity),
        comparison: session.dir ? comparisons.get(directoryKey(session.dir)) : undefined
      }
    })
    .sort(
      (left, right) => right.signal.tier - left.signal.tier || left.session.id - right.session.id
    )
}

export function repoRows(repo: WorkflowRepo, indexed: Map<string, IndexedActivity>): WorkflowRow[] {
  return repo.workflows
    .map((entry, order) => {
      const dir = openDir(repo, entry)
      const { activity } = dir ? activityFor(indexed, dir) : noActivity
      return {
        entry,
        activity,
        dir,
        order,
        signal: inboxSignal(
          entry,
          activity.summary,
          activity.status === 'attention' && activity.summary.waiting === 0
        )
      }
    })
    .sort((left, right) => right.signal.tier - left.signal.tier || left.order - right.order)
}

export function reviewTargetsOf(
  repos: WorkflowRepo[],
  rowsOf: (repo: WorkflowRepo) => WorkflowRow[]
): WorkflowReviewTarget[] {
  return repos.flatMap((repo) =>
    rowsOf(repo).flatMap(({ entry, dir, signal }) =>
      dir &&
      signal.slug === 'review' &&
      ((entry.review?.changed ?? 0) > 0 || (entry.review?.ahead ?? 0) > 0)
        ? [{ cwd: dir, branch: entry.branch }]
        : []
    )
  )
}

export function cleanupTargetsOf(
  repos: WorkflowRepo[],
  rowsOf: (repo: WorkflowRepo) => WorkflowRow[]
): CleanupTarget[] {
  return repos.flatMap((repo) => {
    if (repo.unreachable) return []
    const workspaces = rowsOf(repo).flatMap(({ entry, activity }): CleanupTarget[] => {
      const shape = cleanupCandidate(entry, activity)
        ? {
            kind: 'workspace' as const,
            directory: usable(entry) ? (entry.worktree ?? null) : null,
            reasons: cleanupReasons(entry)
          }
        : cleanupStale(entry)
          ? {
              kind: 'stale' as const,
              directory: entry.worktree ?? null,
              reasons: ['no longer linked']
            }
          : null
      if (!shape) return []
      return [
        { repo: repo.repo, repoName: repo.name, branch: entry.branch, suggested: true, ...shape }
      ]
    })
    const orphans = (repo.orphans ?? []).filter(cleanupOrphan).map((orphan): CleanupTarget => ({
      repo: repo.repo,
      repoName: repo.name,
      kind: 'orphan',
      branch: orphan.branch,
      directory: orphan.directory,
      reasons: ['merged', 'no changes'],
      suggested: orphan.inContainer
    }))
    return [...workspaces, ...orphans]
  })
}
