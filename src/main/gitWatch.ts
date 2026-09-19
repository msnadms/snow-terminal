import { ipcMain, WebContents } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { samePath } from './config'
import { gitDir, mainWorktreeRoot, worktreeRoot } from './gitCore'
import type { GitRepo } from './gitTypes'
import { contentWatchers, repoWatchers } from './watchRegistry'

interface DiscoveryState {
  root: string | null
  repos: GitRepo[]
}

const ignoredWorktreeEntry = /(^|[\\/])(\.git|node_modules)([\\/]|$)/
const transientGitEntry = /\.lock$/
const gitEntry = /^\.git([\\/]|$)/
const notifyQuietMs = 150
const notifyMaxWaitMs = 1000
const watchRetryMs = 500
const maxWatchRetries = 5
const discoveryQuietMs = 300
const maxDiscoveryChildren = 64

const destroyHooked = new WeakSet<WebContents>()

async function isRepoDir(dir: string): Promise<boolean> {
  try {
    await fs.promises.access(path.join(dir, '.git'))
    return true
  } catch {
    return false
  }
}

async function discoveryState(cwd?: string): Promise<DiscoveryState> {
  const dir = cwd || os.homedir()

  const root = await worktreeRoot(dir)
  if (root) {
    const common = (await mainWorktreeRoot(dir)) ?? root
    return { root, repos: [{ path: root, name: path.basename(root), common }] }
  }

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return { root: null, repos: [] }
  }

  const found = (
    await Promise.all(
      entries.map(async (entry): Promise<GitRepo | null> => {
        if (!entry.isDirectory() || entry.name.startsWith('.')) return null
        const child = path.join(dir, entry.name)
        if (!(await isRepoDir(child))) return null
        const childRoot = (await worktreeRoot(child)) ?? child
        return {
          path: childRoot,
          name: path.basename(childRoot),
          common: (await mainWorktreeRoot(child)) ?? childRoot
        }
      })
    )
  ).filter((repo): repo is GitRepo => repo !== null)
  return { root: null, repos: found.sort((a, b) => a.name.localeCompare(b.name)) }
}

function isGitEntry(filename: string | null): boolean {
  return !!filename && gitEntry.test(filename)
}

function repoSignature(state: DiscoveryState): string {
  return state.repos.map((repo) => repo.path).join('\n')
}

function watcherKey(wcId: number, cwd?: string): string {
  return `${wcId}\u0000${cwd ?? ''}`
}

function closeWatchersFor(wcId: number): void {
  contentWatchers.closeFor(wcId)
  repoWatchers.closeFor(wcId)
}

function hookDestroy(sender: WebContents, wcId: number): void {
  if (destroyHooked.has(sender)) return
  destroyHooked.add(sender)
  sender.once('destroyed', () => closeWatchersFor(wcId))
}

export function disposeGitWatchers(): void {
  contentWatchers.disposeAll()
  repoWatchers.disposeAll()
}

export function registerWatchHandlers(): void {
  ipcMain.handle(
    'git:discover',
    async (_event, cwd?: string): Promise<GitRepo[]> => (await discoveryState(cwd)).repos
  )

  ipcMain.handle('git:mainRoot', (_event, cwd?: string): Promise<string | null> =>
    mainWorktreeRoot(cwd)
  )

  ipcMain.handle('git:unwatch', (event, cwd?: string): void => {
    contentWatchers.release(watcherKey(event.sender.id, cwd))
  })

  ipcMain.handle('git:unwatchRepos', (event, cwd?: string): void => {
    repoWatchers.release(watcherKey(event.sender.id, cwd))
  })

  ipcMain.handle('git:watchRepos', async (event, cwd?: string): Promise<void> => {
    const sender = event.sender
    const wcId = sender.id
    const key = watcherKey(wcId, cwd)

    const handle = repoWatchers.begin(key, wcId)
    if (!handle) return

    const dir = cwd || os.homedir()
    const rootClosers: (() => void)[] = []
    let childClosers: (() => void)[] = []
    let timer: NodeJS.Timeout | null = null
    let inRepo = false
    let childKey = ''
    let signature = ''

    handle.close = () => {
      if (timer) clearTimeout(timer)
      timer = null
      for (const close of rootClosers) close()
      for (const close of childClosers) close()
      rootClosers.length = 0
      childClosers = []
    }

    const live = (): boolean => repoWatchers.isCurrent(key, handle) && !sender.isDestroyed()

    const watchDir = (
      target: string,
      accept: (filename: string | null) => boolean,
      into: (() => void)[]
    ): void => {
      try {
        const watcher = fs.watch(target, { recursive: false }, (event, filename) => {
          if (event === 'rename' && accept(filename)) notify()
        })
        watcher.on('error', () => watcher.close())
        into.push(() => watcher.close())
      } catch {
        return
      }
    }

    const syncChildren = async (root: string | null): Promise<void> => {
      inRepo = root !== null
      const drop = (): void => {
        for (const close of childClosers) close()
        childClosers = []
      }
      if (inRepo) {
        childKey = ''
        drop()
        return
      }

      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        entries = []
      }
      const names = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort()
        .slice(0, maxDiscoveryChildren)

      const next = names.join('\n')
      if (next === childKey) return
      childKey = next
      drop()
      if (!live()) return
      for (const name of names) watchDir(path.join(dir, name), isGitEntry, childClosers)
    }

    const recheck = async (): Promise<void> => {
      if (!live()) return
      const state = await discoveryState(cwd)
      if (!live()) return
      await syncChildren(state.root)
      if (!live()) return
      const next = repoSignature(state)
      if (next === signature) return
      signature = next
      sender.send('git:reposChanged', cwd ?? null)
    }

    const notify = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void recheck()
      }, discoveryQuietMs)
    }

    const initial = await discoveryState(cwd)
    if (!live()) {
      repoWatchers.bail(key, handle)
      return
    }
    signature = repoSignature(initial)

    watchDir(dir, (filename) => !inRepo || isGitEntry(filename), rootClosers)
    await syncChildren(initial.root)
    if (!live()) {
      repoWatchers.bail(key, handle)
      return
    }

    hookDestroy(sender, wcId)
  })

  ipcMain.handle('git:watch', async (event, cwd?: string): Promise<void> => {
    const sender = event.sender
    const wcId = sender.id
    const key = watcherKey(wcId, cwd)

    const handle = contentWatchers.begin(key, wcId)
    if (!handle) return

    const [dir, common] = await Promise.all([gitDir(cwd), mainWorktreeRoot(cwd)])
    if (!dir) {
      contentWatchers.bail(key, handle)
      return
    }

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
    handle.close = () => {
      for (const c of closers) c()
      if (timer) clearTimeout(timer)
    }

    const watch = (
      target: string,
      recursive: boolean,
      accept?: (filename: string | null) => boolean
    ): void => {
      const handler: fs.WatchListener<string> = (_event, filename) => {
        if (accept && !accept(filename)) return
        notify()
      }
      let stopped = false
      let retries = 0
      let retry: NodeJS.Timeout | null = null
      const attach = (watcher: fs.FSWatcher): void => {
        watcher.on('error', () => {
          watcher.close()
          notify()
          if (stopped || retries++ >= maxWatchRetries) return
          retry = setTimeout(open, watchRetryMs)
        })
        closers.push(() => {
          stopped = true
          if (retry) clearTimeout(retry)
          watcher.close()
        })
      }
      function open(): void {
        if (stopped) return
        retry = null
        try {
          attach(fs.watch(target, { recursive }, handler))
          return
        } catch {
          if (!recursive) return
        }
        try {
          attach(fs.watch(target, handler))
        } catch {
          return
        }
      }
      open()
    }

    const notLockFile = (filename: string | null): boolean =>
      !filename || !transientGitEntry.test(filename)

    watch(dir, false, notLockFile)
    watch(path.join(dir, 'refs'), true, notLockFile)
    watch(path.join(dir, 'logs'), true, notLockFile)
    if (common && !samePath(common, path.dirname(dir))) {
      watch(path.join(common, '.git', 'refs'), true, notLockFile)
      watch(path.join(common, '.git', 'logs'), true, notLockFile)
    }

    const worktree = await worktreeRoot(cwd)
    if (worktree) {
      watch(worktree, true, (filename) => !!filename && !ignoredWorktreeEntry.test(filename))
    }

    if (!contentWatchers.isCurrent(key, handle) || sender.isDestroyed()) {
      contentWatchers.bail(key, handle)
      return
    }

    handle.root = common ?? worktree ?? cwd ?? os.homedir()
    handle.notify = notify

    hookDestroy(sender, wcId)
  })
}
