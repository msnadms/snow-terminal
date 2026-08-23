import fs from 'fs'
import path from 'path'
import {
  broadcast,
  collapseHome,
  configDir,
  expandHome,
  samePath,
  watchConfigFile,
  writeDefaultConfig
} from './config'
import { log } from './log'

export interface WorkflowRecord {
  repo: string
  branch: string
  /** An absolute linked-worktree path when this workflow runs in parallel. */
  worktree?: string
}

const defaultRegistry = { workflows: [] as WorkflowRecord[] }

export function workflowsPath(): string {
  return path.join(configDir(), '.snowworkflows')
}

function validate(raw: unknown): WorkflowRecord[] {
  if (!raw || typeof raw !== 'object') return []
  const list = (raw as Record<string, unknown>).workflows
  if (!Array.isArray(list)) return []
  const result: WorkflowRecord[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.repo !== 'string' || typeof o.branch !== 'string') continue
    const repo = o.repo.trim()
    const branch = o.branch.trim()
    if (!repo || !branch) continue
    if (result.some((r) => r.branch === branch && samePath(expandHome(r.repo), expandHome(repo))))
      continue
    const worktree = typeof o.worktree === 'string' ? o.worktree.trim() : ''
    result.push(worktree ? { repo, branch, worktree } : { repo, branch })
  }
  return result
}

export function readRecords(): { records: WorkflowRecord[]; error: string | null } {
  try {
    const raw = JSON.parse(fs.readFileSync(workflowsPath(), 'utf8')) as unknown
    return { records: validate(raw), error: null }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return { records: [], error: null }
    return { records: [], error: e.message }
  }
}

function writeRecords(records: WorkflowRecord[]): string | null {
  const file = workflowsPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ workflows: records }, null, 2)}\n`)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

export function filterByRepo(records: WorkflowRecord[], repo: string): WorkflowRecord[] {
  return records.filter((r) => samePath(expandHome(r.repo), repo))
}

export function recordsFor(repo: string): { records: WorkflowRecord[]; error: string | null } {
  const { records, error } = readRecords()
  return { records: filterByRepo(records, repo), error }
}

/**
 * The park-mode branches of `repo`, plus the branch that owns `worktree` when that directory is
 * itself a workflow's parallel session. One read answers both, because every branch switch needs
 * to know whether it may park *and* whether it is standing in a worktree it must not leave.
 */
export function branchesFor(
  repo: string,
  worktree: string | null
): { parkable: string[]; owner: string | null; error: string | null } {
  const { records, error } = recordsFor(repo)
  const parkable = records.filter((r) => !r.worktree).map((r) => r.branch)
  const owner = worktree
    ? (records.find((r) => r.worktree && samePath(expandHome(r.worktree), worktree))?.branch ??
      null)
    : null
  return { parkable, owner, error }
}

export function addRecord(repo: string, branch: string): string | null {
  const { records, error } = readRecords()
  if (error) return error
  const index = records.findIndex((r) => r.branch === branch && samePath(expandHome(r.repo), repo))
  if (index !== -1) {
    const existing = records[index]
    if (!existing.worktree) return null
    const next = [...records]
    next[index] = { repo: existing.repo, branch: existing.branch }
    return writeRecords(next)
  }
  return writeRecords([...records, { repo: collapseHome(repo), branch }])
}

export function setWorktree(repo: string, branch: string, worktree: string | null): string | null {
  const { records, error } = readRecords()
  if (error) return error
  const index = records.findIndex((r) => r.branch === branch && samePath(expandHome(r.repo), repo))
  if (index === -1) return `Workflow ${branch} is not registered`
  const next = [...records]
  const record = next[index]
  next[index] = worktree
    ? { ...record, worktree: collapseHome(worktree) }
    : { repo: record.repo, branch: record.branch }
  return writeRecords(next)
}

export function removeRecord(repo: string, branch: string): string | null {
  const { records, error } = readRecords()
  if (error) return error
  const kept = records.filter((r) => !(r.branch === branch && samePath(expandHome(r.repo), repo)))
  return writeRecords(kept)
}

let stopWatching: (() => void) | null = null

export function initRegistry(): void {
  const file = workflowsPath()
  writeDefaultConfig(file, `${JSON.stringify(defaultRegistry, null, 2)}\n`)
  stopWatching = watchConfigFile(file, () => {
    const { error } = readRecords()
    log(error ? 'error' : 'info', 'workflow', 'registry reloaded', { path: file, error })
    broadcast('workflow:changed')
  })
}

export function disposeRegistryWatcher(): void {
  stopWatching?.()
  stopWatching = null
}
