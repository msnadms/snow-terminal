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
    result.push({ repo, branch })
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

export function registeredFor(repo: string): { branches: string[]; error: string | null } {
  const { records, error } = readRecords()
  return {
    branches: records.filter((r) => samePath(expandHome(r.repo), repo)).map((r) => r.branch),
    error
  }
}

export function addRecord(repo: string, branch: string): string | null {
  const { records, error } = readRecords()
  if (error) return error
  if (records.some((r) => r.branch === branch && samePath(expandHome(r.repo), repo))) return null
  return writeRecords([...records, { repo: collapseHome(repo), branch }])
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
