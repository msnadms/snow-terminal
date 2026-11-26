import fs from 'fs'
import os from 'os'
import path from 'path'
import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git'
import { readRecords } from './registry'
import { expandHome, samePath } from './config'

const gitByPath = new Map<string, SimpleGit>()

export const gitOptions: Partial<SimpleGitOptions> =
  process.platform === 'win32' ? { config: ['core.longpaths=true'] } : {}

export const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

export function gitFor(cwd?: string): SimpleGit {
  const dir = cwd || os.homedir()
  let git = gitByPath.get(dir)
  if (!git) {
    git = simpleGit(dir, gitOptions).env('GIT_OPTIONAL_LOCKS', '0')
    gitByPath.set(dir, git)
  }
  return git
}

export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line || 'git command failed'
}

export function errorDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim()
}

export function fail(error: unknown): { ok: false; error: string; detail: string } {
  return { ok: false, error: errorText(error), detail: errorDetail(error) }
}

export function conflictedIn(git: SimpleGit): Promise<string[]> {
  return git
    .status()
    .then((status) => status.conflicted)
    .catch((): string[] => [])
}

export function isStaged(index: string): boolean {
  return index !== ' ' && index !== '?' && index !== '!'
}

export async function gitDir(cwd?: string): Promise<string | null> {
  try {
    const dir = (await gitFor(cwd).revparse(['--git-dir'])).trim()
    return path.isAbsolute(dir) ? dir : path.resolve(cwd || os.homedir(), dir)
  } catch {
    return null
  }
}

export async function worktreeRoot(cwd?: string): Promise<string | null> {
  try {
    return (await gitFor(cwd).revparse(['--show-toplevel'])).trim() || null
  } catch {
    return null
  }
}

async function registeredRootSharing(
  common: string,
  absolute: (raw: string) => string
): Promise<string | null> {
  const { records, error } = readRecords()
  if (error) return null
  for (const record of records) {
    const candidate = expandHome(record.repo)
    try {
      const candidateCommon = await gitFor(candidate).revparse(['--git-common-dir'])
      if (!samePath(absolute(candidateCommon), absolute(common))) continue
      const root = await worktreeRoot(candidate)
      if (root) return root
    } catch {
      continue
    }
  }
  return null
}

export async function mainWorktreeRoot(cwd?: string): Promise<string | null> {
  try {
    const git = gitFor(cwd)
    const absolute = (raw: string): string =>
      path.resolve(
        path.isAbsolute(raw.trim()) ? raw.trim() : path.join(cwd || os.homedir(), raw.trim())
      )
    const [dir, common] = await Promise.all([
      git.revparse(['--git-dir']),
      git.revparse(['--git-common-dir'])
    ])
    if (!common.trim()) return null
    if (samePath(absolute(dir), absolute(common))) {
      const top = (await git.revparse(['--show-toplevel'])).trim()
      if (top) return path.resolve(top)
    }
    const worktrees = await git.raw(['worktree', 'list', '--porcelain'])
    const primary = worktrees
      .split(/\r?\n/)
      .find((line) => line.startsWith('worktree '))
      ?.slice('worktree '.length)
      .trim()
    if (primary && fs.existsSync(path.join(primary, '.git'))) return path.resolve(primary)

    return (await registeredRootSharing(common, absolute)) ?? (await worktreeRoot(cwd))
  } catch {
    return null
  }
}

export function parseWorktreeList(raw: string): Map<string, string> {
  const map = new Map<string, string>()
  let directory: string | null = null
  let branch: string | null = null
  let prunable = false
  const commit = (): void => {
    if (directory && branch && !prunable) map.set(branch, directory)
    directory = null
    branch = null
    prunable = false
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line) {
      commit()
    } else if (line.startsWith('worktree ')) {
      directory = line.slice('worktree '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      branch = line.slice('branch refs/heads/'.length)
    } else if (line.startsWith('prunable')) {
      prunable = true
    }
  }
  commit()
  return map
}

export async function worktreeMap(cwd?: string): Promise<Map<string, string>> {
  try {
    return parseWorktreeList(await gitFor(cwd).raw(['worktree', 'list', '--porcelain']))
  } catch {
    return new Map()
  }
}

export async function remoteName(cwd?: string): Promise<string | null> {
  const git = gitFor(cwd)

  let remotes: string[]
  try {
    remotes = (await git.raw(['remote']))
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean)
  } catch {
    return null
  }
  if (remotes.length === 0) return null

  const tracked = await git
    .raw(['symbolic-ref', '--short', 'HEAD'])
    .then((branch) => git.raw(['config', '--get', `branch.${branch.trim()}.remote`]))
    .then((name) => name.trim())
    .catch(() => '')
  if (tracked && remotes.includes(tracked)) return tracked

  return remotes.includes('origin') ? 'origin' : remotes[0]
}

export async function defaultBranch(
  cwd?: string,
  refresh = true,
  knownRemote?: string
): Promise<{ remote: string; branch: string } | null> {
  const git = gitFor(cwd)
  const remote = knownRemote ?? (await remoteName(cwd))
  if (!remote) return null

  if (refresh) {
    await git
      .raw(['fetch', remote])
      .then(() => git.raw(['remote', 'set-head', remote, '--auto']))
      .catch(() => undefined)
  }

  const resolves = async (ref: string): Promise<boolean> => {
    try {
      return !!(await git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()
    } catch {
      return false
    }
  }

  const symbolic = await git
    .raw(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])
    .then((raw) => {
      const ref = raw.trim()
      const prefix = `${remote}/`
      return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref
    })
    .catch(() => '')
  if (symbolic && (await resolves(`refs/remotes/${remote}/${symbolic}`)))
    return { remote, branch: symbolic }

  const configured = await git
    .raw(['config', '--get', 'init.defaultBranch'])
    .then((branch) => branch.trim())
    .catch(() => '')
  const candidates = [...new Set([configured, 'main', 'master'].filter(Boolean))]
  for (const branch of candidates) {
    if (await resolves(`refs/remotes/${remote}/${branch}`)) return { remote, branch }
  }
  return null
}
