import { ipcMain, WebContents } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { simpleGit, SimpleGit } from 'simple-git'
import { filterPaths } from './snowignore'

export interface GitCommit {
  hash: string
  parents: string[]
  author: string
  date: string
  subject: string
  refs: string
  col: number
  row: number
}

export interface GitLog {
  commits: GitCommit[]
  laneCount: number
}

export interface GitRepo {
  path: string
  name: string
}

export interface GitCommitPushResult {
  ok: boolean
  error?: string
}

export interface GitBranches {
  current: string | null
  branches: string[]
}

export interface GitCheckoutResult {
  ok: boolean
  error?: string
}

export interface GitSyncDefaultResult {
  ok: boolean
  branch?: string
  error?: string
}

export interface GitStatus {
  current: string | null
  tracking: string | null
  ahead: number
  behind: number
  staged: string[]
  modified: string[]
  not_added: string[]
  conflicted: string[]
  changed: number
  stageable: number
}

const commitFormat = {
  hash: '%H',
  parents: '%P',
  author: '%an',
  date: '%aI',
  subject: '%s',
  refs: '%D'
}

function layout(
  raw: {
    hash: string
    parents: string[]
    author: string
    date: string
    subject: string
    refs: string
  }[]
): GitLog {
  const lanes: (string | null)[] = []
  const commits: GitCommit[] = []
  let laneCount = 0

  const claim = (hash: string): number => {
    let col = lanes.indexOf(hash)
    if (col !== -1) return col
    col = lanes.indexOf(null)
    if (col === -1) col = lanes.length
    lanes[col] = hash
    return col
  }

  raw.forEach((commit, row) => {
    let col = lanes.indexOf(commit.hash)
    if (col === -1) {
      col = lanes.indexOf(null)
      if (col === -1) col = lanes.length
    }
    lanes[col] = null

    commits.push({ ...commit, col, row })

    commit.parents.forEach((parent, i) => {
      if (i !== 0) {
        claim(parent)
        return
      }
      const existing = lanes.indexOf(parent)
      if (existing === -1) {
        lanes[col] = parent
      } else if (col < existing) {
        lanes[existing] = null
        lanes[col] = parent
      }
    })

    laneCount = Math.max(laneCount, lanes.length)
  })

  return { commits, laneCount: Math.max(laneCount, 1) }
}

const gitByPath = new Map<string, SimpleGit>()

function gitFor(cwd?: string): SimpleGit {
  const dir = cwd || os.homedir()
  let git = gitByPath.get(dir)
  if (!git) {
    git = simpleGit(dir).env('GIT_OPTIONAL_LOCKS', '0')
    gitByPath.set(dir, git)
  }
  return git
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line || 'git command failed'
}

async function gitDir(cwd?: string): Promise<string | null> {
  try {
    const dir = (await gitFor(cwd).revparse(['--git-dir'])).trim()
    return path.isAbsolute(dir) ? dir : path.resolve(cwd || os.homedir(), dir)
  } catch {
    return null
  }
}

async function worktreeRoot(cwd?: string): Promise<string | null> {
  try {
    return (await gitFor(cwd).revparse(['--show-toplevel'])).trim() || null
  } catch {
    return null
  }
}

async function defaultBranch(cwd?: string): Promise<string | null> {
  const git = gitFor(cwd)

  const fromLocalRef = async (): Promise<string | null> => {
    try {
      const ref = (await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim()
      return ref ? ref.replace(/^origin\//, '') : null
    } catch {
      return null
    }
  }

  try {
    await git.raw(['fetch', 'origin'])
    await git.raw(['remote', 'set-head', 'origin', '--auto'])
  } catch {
    /* empty */
  }

  return fromLocalRef()
}

async function isRepoDir(dir: string): Promise<boolean> {
  try {
    await fs.promises.access(path.join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

async function discoverRepos(cwd?: string): Promise<GitRepo[]> {
  const dir = cwd || os.homedir()

  const root = await worktreeRoot(dir)
  if (root) return [{ path: root, name: path.basename(root) }]

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const found: GitRepo[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const child = path.join(dir, entry.name)
    if (await isRepoDir(child)) found.push({ path: child, name: entry.name })
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

const ignoredWorktreeEntry = /(^|[\\/])(\.git|node_modules)([\\/]|$)/
const transientGitEntry = /\.lock$/
const notifyQuietMs = 150
const notifyMaxWaitMs = 1000

interface GitWatcher {
  wcId: number
  close: () => void
}

const watchers = new Map<string, GitWatcher>()
const generations = new Map<string, number>()
const destroyHooked = new WeakSet<WebContents>()

function watcherKey(wcId: number, cwd?: string): string {
  return `${wcId}\u0000${cwd ?? ''}`
}

function nextGeneration(key: string): number {
  const next = (generations.get(key) ?? 0) + 1
  generations.set(key, next)
  return next
}

function closeWatcher(key: string): void {
  watchers.get(key)?.close()
  watchers.delete(key)
}

function closeWatchersFor(wcId: number): void {
  for (const [key, watcher] of watchers) {
    if (watcher.wcId !== wcId) continue
    nextGeneration(key)
    watcher.close()
    watchers.delete(key)
  }
}

export function disposeGitWatchers(): void {
  for (const { close } of watchers.values()) close()
  watchers.clear()
  generations.clear()
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:isRepo', async (_event, cwd?: string): Promise<boolean> => {
    try {
      return await gitFor(cwd).checkIsRepo()
    } catch {
      return false
    }
  })

  ipcMain.handle('git:log', async (_event, cwd?: string, maxCount = 200): Promise<GitLog> => {
    const log = await gitFor(cwd).log({
      format: commitFormat,
      '--all': null,
      '--max-count': maxCount
    })
    const raw = log.all.map((c) => ({
      hash: c.hash,
      parents: c.parents ? c.parents.split(' ').filter(Boolean) : [],
      author: c.author,
      date: c.date,
      subject: c.subject,
      refs: c.refs
    }))
    return layout(raw)
  })

  ipcMain.handle('git:status', async (_event, cwd?: string): Promise<GitStatus> => {
    const status = await gitFor(cwd).status()
    return {
      current: status.current,
      tracking: status.tracking,
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged,
      modified: status.modified,
      not_added: status.not_added,
      conflicted: status.conflicted,
      changed: status.files.length,
      stageable: filterPaths(status.files.map((f) => f.path)).length
    }
  })

  ipcMain.handle('git:branches', async (_event, cwd?: string): Promise<GitBranches> => {
    try {
      const summary = await gitFor(cwd).branchLocal()
      return { current: summary.current || null, branches: summary.all }
    } catch {
      return { current: null, branches: [] }
    }
  })

  ipcMain.handle(
    'git:checkout',
    async (_event, cwd: string | undefined, branch: string): Promise<GitCheckoutResult> => {
      if (!branch) return { ok: false, error: 'Branch required' }
      try {
        await gitFor(cwd).checkout(branch)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    }
  )

  ipcMain.handle(
    'git:createBranch',
    async (_event, cwd: string | undefined, branch: string): Promise<GitCheckoutResult> => {
      const name = (branch ?? '').trim()
      if (!name) return { ok: false, error: 'Branch name required' }
      try {
        await gitFor(cwd).checkoutLocalBranch(name)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    }
  )

  ipcMain.handle('git:syncDefault', async (_event, cwd?: string): Promise<GitSyncDefaultResult> => {
    const git = gitFor(cwd)
    const branch = await defaultBranch(cwd)
    if (!branch) return { ok: false, error: 'No default branch on origin' }

    try {
      const status = await git.status()
      if (status.current === branch) {
        await git.raw(['fetch', 'origin', branch])
        await git.raw(['merge', '--ff-only', `origin/${branch}`])
        return { ok: true, branch }
      }
      await git.raw(['fetch', 'origin', `${branch}:${branch}`])
      await git.checkout(branch)
      return { ok: true, branch }
    } catch (error) {
      return { ok: false, branch, error: errorText(error) }
    }
  })

  ipcMain.handle('git:discover', (_event, cwd?: string): Promise<GitRepo[]> => discoverRepos(cwd))

  ipcMain.handle(
    'git:commitPush',
    async (_event, cwd: string | undefined, message: string): Promise<GitCommitPushResult> => {
      const subject = (message ?? '').trim()
      if (!subject) return { ok: false, error: 'Commit message required' }

      const git = gitFor(cwd)
      try {
        const pending = await git.status()
        const paths = filterPaths(pending.files.map((f) => f.path))
        if (paths.length === 0) return { ok: false, error: 'Nothing to commit' }
        const root = await worktreeRoot(cwd)
        await git.add(root ? paths.map((p) => path.join(root, p)) : paths)
        await git.commit(subject)
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }

      try {
        const status = await git.status()
        if (status.tracking || !status.current) {
          await git.push()
        } else {
          await git.push(['--set-upstream', 'origin', status.current])
        }
      } catch (error) {
        return { ok: false, error: `Committed, push failed: ${errorText(error)}` }
      }

      return { ok: true }
    }
  )

  ipcMain.handle('git:unwatch', (event, cwd?: string): void => {
    const key = watcherKey(event.sender.id, cwd)
    nextGeneration(key)
    closeWatcher(key)
  })

  ipcMain.handle('git:watch', async (event, cwd?: string): Promise<void> => {
    const sender = event.sender
    const wcId = sender.id
    const key = watcherKey(wcId, cwd)
    const generation = nextGeneration(key)
    closeWatcher(key)

    const dir = await gitDir(cwd)
    if (!dir) return

    let timer: NodeJS.Timeout | null = null
    let burstStart = 0
    const notify = (): void => {
      const now = Date.now()
      if (!burstStart) burstStart = now
      if (timer) clearTimeout(timer)
      const wait = Math.min(notifyQuietMs, Math.max(0, burstStart + notifyMaxWaitMs - now))
      timer = setTimeout(() => {
        timer = null
        burstStart = 0
        if (!sender.isDestroyed()) sender.send('git:changed', cwd ?? null)
      }, wait)
    }

    const closers: (() => void)[] = []
    const watch = (
      target: string,
      recursive: boolean,
      accept?: (filename: string | null) => boolean
    ): void => {
      const handler: fs.WatchListener<string> = (_event, filename) => {
        if (accept && !accept(filename)) return
        notify()
      }
      const attach = (watcher: fs.FSWatcher): void => {
        watcher.on('error', () => watcher.close())
        closers.push(() => watcher.close())
      }
      try {
        attach(fs.watch(target, { recursive }, handler))
      } catch {
        if (!recursive) return
        try {
          attach(fs.watch(target, handler))
        } catch {
          // path may not exist yet or be unwatchable
        }
      }
    }

    const notLockFile = (filename: string | null): boolean =>
      !filename || !transientGitEntry.test(filename)

    watch(dir, false, notLockFile)
    watch(path.join(dir, 'refs'), true, notLockFile)
    watch(path.join(dir, 'logs'), true, notLockFile)

    const worktree = await worktreeRoot(cwd)
    if (worktree) {
      watch(worktree, true, (filename) => !filename || !ignoredWorktreeEntry.test(filename))
    }

    const close = (): void => {
      for (const c of closers) c()
      if (timer) clearTimeout(timer)
    }

    if (generations.get(key) !== generation || sender.isDestroyed()) {
      close()
      return
    }

    watchers.set(key, { wcId, close })

    if (!destroyHooked.has(sender)) {
      destroyHooked.add(sender)
      sender.once('destroyed', () => closeWatchersFor(wcId))
    }
  })
}
