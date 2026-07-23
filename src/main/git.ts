import { ipcMain } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { simpleGit, SimpleGit } from 'simple-git'

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

export interface GitStatus {
  current: string | null
  tracking: string | null
  ahead: number
  behind: number
  staged: string[]
  modified: string[]
  not_added: string[]
  conflicted: string[]
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
    laneCount = Math.max(laneCount, lanes.length)

    commit.parents.forEach((parent, i) => {
      if (i === 0) lanes[col] = parent
      else claim(parent)
    })
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

const ignoredWorktreeEntry = /(^|[\\/])(\.git|node_modules)([\\/]|$)/
const transientGitEntry = /\.lock$/
const notifyQuietMs = 150
const notifyMaxWaitMs = 1000

const watchers = new Map<number, () => void>()

export function disposeGitWatchers(): void {
  for (const close of watchers.values()) close()
  watchers.clear()
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:isRepo', async (_event, cwd?: string): Promise<boolean> => {
    try {
      return await gitFor(cwd).checkIsRepo()
    } catch {
      return false
    }
  })

  ipcMain.handle('git:log', async (_event, cwd?: string): Promise<GitLog> => {
    const log = await gitFor(cwd).log({ format: commitFormat, '--all': null, '--max-count': 200 })
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
      conflicted: status.conflicted
    }
  })

  ipcMain.handle('git:watch', async (event, cwd?: string): Promise<void> => {
    const wcId = event.sender.id
    watchers.get(wcId)?.()
    watchers.delete(wcId)

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
        if (!event.sender.isDestroyed()) event.sender.send('git:changed')
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
    watchers.set(wcId, close)
    event.sender.once('destroyed', () => {
      close()
      watchers.delete(wcId)
    })
  })
}
