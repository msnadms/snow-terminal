import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { boundedCache } from './cache'
import { collapseHome, samePath } from './config'
import { gitFor, worktreeMap } from './gitCore'
import { closePtysInDirectory } from './pty'
import type { WorkflowOrphan, WorkflowResult } from './workflowTypes'

export function worktreeContainer(repo: string): string {
  return path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`)
}

export function worktreeDirectory(repo: string, branch: string): string {
  const safeBranch = branch.replace(/[\\/:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow'
  const suffix =
    safeBranch === branch ? '' : `-${createHash('sha1').update(branch).digest('hex').slice(0, 7)}`
  return path.join(worktreeContainer(repo), `${safeBranch}${suffix}`)
}

export async function occupiedWorktree(
  destination: string,
  branch: string,
  verb: 'create' | 'open'
): Promise<WorkflowResult | null> {
  const remaining = await fs.promises
    .readdir(destination)
    .catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))
  if (!remaining.length) return null
  return {
    ok: false,
    error: `${branch}'s worktree directory already has files in it`,
    detail: [
      collapseHome(destination),
      '',
      `snow will not check ${branch} out over it. Move or delete that directory, then ${verb} the workspace again.`
    ].join('\n')
  }
}

export async function stillLinked(
  repo: string,
  branch: string,
  directory: string
): Promise<boolean> {
  const linked = (await worktreeMap(repo)).get(branch)
  return !!linked && samePath(linked, directory)
}

export async function revCount(cwd: string | undefined, range: string): Promise<number | null> {
  try {
    const value = Number((await gitFor(cwd).raw(['rev-list', '--count', range])).trim())
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

export async function aheadOf(directory: string, bases: string[]): Promise<number | null> {
  for (const base of bases) {
    const value = await revCount(directory, `${base}..HEAD`)
    if (value !== null) return value
  }
  return null
}

export function nameStatusPaths(raw: string): string[] {
  const fields = raw.split('\0')
  const paths: string[] = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    if (!status) continue
    const first = fields[index++]
    if (first) paths.push(first)
    if (status[0] === 'R' || status[0] === 'C') {
      const second = fields[index++]
      if (second) paths.push(second)
    }
  }
  return paths
}

export async function rangePaths(
  directory: string | undefined,
  range: string
): Promise<string[] | null> {
  try {
    const raw = await gitFor(directory).raw(['diff', '--name-status', '-z', '-M', range])
    return nameStatusPaths(raw)
  } catch {
    return null
  }
}

export async function committedPaths(directory: string, bases: string[]): Promise<string[]> {
  for (const base of bases) {
    const paths = await rangePaths(directory, `${base}...HEAD`)
    if (paths) return paths
  }
  return []
}

export async function resolveBase(
  cwd: string | undefined,
  bases: string[]
): Promise<string | null> {
  const resolved = await Promise.all(
    bases.map((base) =>
      gitFor(cwd)
        .raw(['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
        .then((sha) => sha.trim())
        .catch(() => '')
    )
  )
  return resolved.find(Boolean) ?? null
}

export async function branchHeads(cwd: string | undefined): Promise<Map<string, string>> {
  try {
    const raw = await gitFor(cwd).raw([
      'for-each-ref',
      '--format=%(refname:short)%09%(objectname)',
      'refs/heads/'
    ])
    const heads = new Map<string, string>()
    for (const line of raw.split('\n')) {
      const [branch, sha] = line.trim().split('\t')
      if (branch && sha) heads.set(branch, sha)
    }
    return heads
  } catch {
    return new Map()
  }
}

export async function mergeBase(directory: string, a: string, b: string): Promise<string | null> {
  try {
    return (await gitFor(directory).raw(['merge-base', a, b])).trim() || null
  } catch {
    return null
  }
}

const maxCachedMerges = 500
const mergedCache = boundedCache<boolean | null>(maxCachedMerges)

async function evaluateMerged(
  cwd: string | undefined,
  branch: string,
  base: string
): Promise<boolean | null> {
  const ahead = await revCount(cwd, `${base}..${branch}`)
  if (ahead === null) return null
  if (ahead === 0) return true
  const paths = await rangePaths(cwd, `${base}...${branch}`)
  if (!paths) return null
  if (paths.length === 0) return true
  try {
    const raw = await gitFor(cwd).raw(['diff', '--name-only', '-z', base, branch, '--', ...paths])
    return raw.replace(/\0/g, '').length === 0
  } catch {
    return null
  }
}

export async function mergedInto(
  cwd: string | undefined,
  branch: string,
  base: string | null,
  head: string | null
): Promise<boolean | null> {
  if (!base) return null
  if (head === base) return true
  if (!head) return evaluateMerged(cwd, branch, base)
  const key = `${base}\0${head}`
  const cached = mergedCache.get(key)
  if (cached !== undefined) return cached
  return mergedCache.set(key, await evaluateMerged(cwd, branch, base))
}

export async function removeLinkedWorktree(
  repo: string,
  branch: string,
  directory: string
): Promise<void> {
  try {
    await gitFor(repo).raw(['worktree', 'remove', '--force', '--force', directory])
  } catch (first) {
    if (!(await stillLinked(repo, branch, directory))) throw first
    await closePtysInDirectory(directory)
    try {
      await gitFor(repo).raw(['worktree', 'remove', '--force', '--force', directory])
    } catch (second) {
      throw Object.assign(second as object, { terminalsClosed: true })
    }
  }
  if (samePath(path.dirname(directory), worktreeContainer(repo)))
    await fs.promises.rmdir(worktreeContainer(repo)).catch(() => {})
}

export function closedTerminals(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'terminalsClosed' in error
}

export async function orphansOf(
  cwd: string | undefined,
  repo: string | null,
  checkedOut: Map<string, string>,
  claimed: Set<string>,
  base: string | null,
  heads: Map<string, string>
): Promise<WorkflowOrphan[]> {
  const container = repo ? worktreeContainer(repo) : null
  return Promise.all(
    [...checkedOut]
      .filter(([branch, directory]) => !claimed.has(branch) && !(repo && samePath(directory, repo)))
      .map(async ([branch, directory]) => {
        const [merged, changed] = await Promise.all([
          mergedInto(cwd, branch, base, heads.get(branch) ?? null),
          gitFor(directory)
            .status()
            .then((status) => status.files.length)
            .catch(() => null)
        ])
        return {
          branch,
          directory,
          merged,
          changed,
          inContainer: !!container && samePath(path.dirname(directory), container)
        }
      })
  )
}
