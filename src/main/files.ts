import { ipcMain, type WebContents } from 'electron'
import { spawn } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { WatcherRegistry } from './watchRegistry'

export type DirEntry = { name: string; dir: boolean; ignored: boolean }
export type RepoLocation = { root: string; prefix: string }
export type DirListing = { entries: DirEntry[]; repo: RepoLocation | null } | { error: string }
export type FileTarget = { root: string; path: string }
export type IndexedFile = { path: string; target: FileTarget | null }
export type SearchHit = { path: string; dir: boolean; target: FileTarget | null }
export type SearchResult = { hits: SearchHit[]; total: number; partial: boolean }

interface DirWatch {
  dir: string
  sender: WebContents
  paths: () => string[]
  arm: () => void
  replaced: () => void
  suspend: () => void
  identity: () => Promise<string | undefined>
}

const hiddenNames = new Set(['.git'])
const gitTimeoutMs = 2000
const indexGitTimeoutMs = 20_000
const changeDebounceMs = 100
const rearmDelayMs = 500
const maxRearms = 5
const maxIndexedFiles = 200_000
const maxWalkedDirs = 5000
const indexTtlMs = 3000
const maxSearchHits = 500
const fileWatchers = new WatcherRegistry()
const dirWatches = new Map<string, DirWatch>()
const destroyHooked = new WeakSet<WebContents>()
const suspendedRoots: string[] = []
let cachedIndex: { root: string; at: number | null; index: Promise<FileIndex> } | null = null

type FileIndex = { files: IndexedFile[]; partial: boolean }

export function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!/^\.\.(?:[\\/]|$)/.test(rel) && !isAbsolute(rel))
}

function isSuspended(paths: string[]): boolean {
  return suspendedRoots.some((root) => paths.some((path) => isWithin(path, root)))
}

async function realDirectory(dir: string): Promise<string> {
  try {
    return await realpath(dir)
  } catch {
    return dir
  }
}

export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(b.dir) - Number(a.dir) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  )
}

export function parseIgnored(stdout: string): Set<string> {
  return new Set(stdout.split('\0').filter(Boolean))
}

export function parseRepoLocation(stdout: string): RepoLocation | null {
  const [root, prefix = ''] = stdout.split(/\r?\n/)
  return root ? { root, prefix } : null
}

function runGit(
  dir: string,
  args: string[],
  input?: string,
  timeoutMs = gitTimeoutMs
): Promise<string | null> {
  return new Promise((resolve) => {
    const full = process.platform === 'win32' ? ['-c', 'core.longpaths=true', ...args] : args
    const child = spawn('git', full, {
      cwd: dir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null)
    })
    child.stdin.end(input)
  })
}

async function ignoredNames(dir: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set()
  const stdout = await runGit(dir, ['check-ignore', '-z', '--stdin'], names.join('\0') + '\0')
  return stdout === null ? new Set() : parseIgnored(stdout)
}

async function repoLocation(dir: string): Promise<RepoLocation | null> {
  const stdout = await runGit(dir, ['rev-parse', '--show-toplevel', '--show-prefix'])
  return stdout === null ? null : parseRepoLocation(stdout)
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export function identityOf(info: { ino: number; birthtimeMs: number }): string {
  return `${info.ino}:${info.birthtimeMs}`
}

async function directoryIdentity(dir: string): Promise<string | undefined> {
  try {
    return identityOf(await stat(dir))
  } catch {
    return undefined
  }
}

export async function listDirectory(dir: string): Promise<DirListing> {
  let dirents
  try {
    dirents = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    return { error: (error as Error).message }
  }
  const visible = dirents.filter((d) => !hiddenNames.has(d.name))
  const [kinds, ignored, repo] = await Promise.all([
    Promise.all(
      visible.map((d) =>
        d.isSymbolicLink() ? isDirectory(join(dir, d.name)) : Promise.resolve(d.isDirectory())
      )
    ),
    ignoredNames(
      dir,
      visible.map((d) => d.name)
    ),
    repoLocation(dir)
  ])
  return {
    entries: sortEntries(
      visible.map((d, i) => ({ name: d.name, dir: kinds[i], ignored: ignored.has(d.name) }))
    ),
    repo
  }
}

export function parseLsFiles(
  staged: string,
  others: string,
  rel: string,
  repo: RepoLocation
): { files: IndexedFile[]; nested: string[] } {
  const files = new Set<string>()
  const nested = new Set<string>()
  for (const entry of staged.split('\0')) {
    const tab = entry.indexOf('\t')
    if (tab === -1) continue
    const path = entry.slice(tab + 1)
    if (entry.startsWith('160000 ')) nested.add(path)
    else files.add(path)
  }
  for (const path of others.split('\0').filter(Boolean)) {
    if (path.endsWith('/')) nested.add(path.slice(0, -1))
    else files.add(path)
  }
  for (const path of nested) files.delete(path)
  return {
    files: [...files].map((path) => ({
      path: rel + path,
      target: { root: repo.root, path: repo.prefix + path }
    })),
    nested: [...nested]
  }
}

async function buildIndex(root: string): Promise<FileIndex> {
  const files: IndexedFile[] = []
  const queue = [{ dir: root, rel: '' }]
  let partial = false
  for (let next = 0; next < queue.length; next++) {
    if (next >= maxWalkedDirs || files.length >= maxIndexedFiles) {
      partial = true
      break
    }
    const { dir, rel } = queue[next]
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const repo =
      rel === '' || dirents.some((d) => hiddenNames.has(d.name)) ? await repoLocation(dir) : null
    if (repo) {
      const [staged, others] = await Promise.all([
        runGit(dir, ['ls-files', '-s', '-z'], undefined, indexGitTimeoutMs),
        runGit(dir, ['ls-files', '-o', '--exclude-standard', '-z'], undefined, indexGitTimeoutMs)
      ])
      if (staged === null || others === null) {
        partial = true
        continue
      }
      const listed = parseLsFiles(staged, others, rel, repo)
      files.push(...listed.files)
      for (const path of listed.nested) queue.push({ dir: join(dir, path), rel: `${rel}${path}/` })
      continue
    }
    for (const d of dirents) {
      if (hiddenNames.has(d.name)) continue
      if (d.isDirectory()) queue.push({ dir: join(dir, d.name), rel: `${rel}${d.name}/` })
      else files.push({ path: rel + d.name, target: null })
    }
  }
  if (files.length > maxIndexedFiles) partial = true
  return { files: files.slice(0, maxIndexedFiles), partial }
}

function fileIndex(root: string): Promise<FileIndex> {
  const cached = cachedIndex
  if (cached?.root === root && (cached.at === null || Date.now() - cached.at < indexTtlMs))
    return cached.index
  const entry: NonNullable<typeof cachedIndex> = { root, at: null, index: buildIndex(root) }
  const settled = (): void => {
    entry.at = Date.now()
  }
  entry.index.then(settled, settled)
  cachedIndex = entry
  return entry.index
}

export function foldCase(text: string): string {
  let folded = ''
  for (const char of text) folded += char.toLowerCase()
  return folded
}

export function searchFiles(
  files: IndexedFile[],
  query: string,
  limit: number
): Omit<SearchResult, 'partial'> {
  const needle = foldCase(query.trim())
  const hits: SearchHit[] = []
  const dirs = new Set<string>()
  let total = 0
  const add = (hit: SearchHit): void => {
    total++
    if (hits.length < limit) hits.push(hit)
  }
  if (!needle) return { hits, total }
  for (const file of files) {
    const segments = file.path.split('/')
    let prefix = ''
    for (const segment of segments.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      if (dirs.has(prefix) || !foldCase(segment).includes(needle)) continue
      dirs.add(prefix)
      add({ path: prefix, dir: true, target: null })
    }
    if (foldCase(segments[segments.length - 1]).includes(needle))
      add({ path: file.path, dir: false, target: file.target })
  }
  return { hits, total }
}

function watcherKey(wcId: number, dir: string): string {
  return `${wcId}\u0000${dir}`
}

function watchDirectory(sender: WebContents, dir: string): void {
  const wcId = sender.id
  const key = watcherKey(wcId, dir)
  const handle = fileWatchers.begin(key, wcId)
  if (!handle) return
  if (!destroyHooked.has(sender)) {
    destroyHooked.add(sender)
    sender.once('destroyed', () => fileWatchers.closeFor(wcId))
    sender.on('did-navigate', () => fileWatchers.closeFor(wcId))
  }

  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null
  let retry: NodeJS.Timeout | null = null
  let retries = 0
  let real = dir
  const paths = (): string[] => (real === dir ? [dir] : [dir, real])
  let names: Set<string> | null = new Set()
  let identity: Promise<string | undefined> = Promise.resolve(undefined)
  const send = (changed: string[] | null): void => {
    if (!sender.isDestroyed()) sender.send('files:changed', dir, changed)
  }
  const suspend = (): void => {
    if (timer) clearTimeout(timer)
    if (retry) clearTimeout(retry)
    timer = null
    retry = null
    names = new Set()
    watcher?.close()
    watcher = null
  }
  const arm = (): void => {
    suspend()
    identity = Promise.resolve(undefined)
    if (isSuspended(paths())) return
    try {
      watcher = watch(dir, { recursive: false }, (event, name) => {
        if (event !== 'rename') return
        if (name && names) names.add(name.toString())
        else names = null
        timer ??= setTimeout(() => {
          const changed = names && [...names]
          timer = null
          names = new Set()
          send(changed)
        }, changeDebounceMs)
      })
    } catch {
      return
    }
    const current = watcher
    current.on('error', () => {
      if (watcher !== current) return
      const armed = identity
      suspend()
      identity = armed
      send(null)
      if (retries++ >= maxRearms) return
      retry = setTimeout(() => {
        retry = null
        arm()
        if (watcher) send(null)
      }, rearmDelayMs)
    })
    identity = directoryIdentity(dir)
  }
  handle.root = dir
  handle.close = () => {
    suspend()
    if (dirWatches.get(key)?.sender === sender) dirWatches.delete(key)
  }
  const replaced = (): void => {
    retries = 0
    arm()
  }
  dirWatches.set(key, { dir, sender, paths, arm, replaced, suspend, identity: () => identity })
  arm()
  void realDirectory(dir).then((resolved) => {
    real = resolved
    if (watcher && isSuspended(paths())) suspend()
  })
}

async function rearmIfReplaced(wcId: number, dir: string): Promise<void> {
  const entry = dirWatches.get(watcherKey(wcId, dir))
  if (!entry || isSuspended(entry.paths())) return
  const [current, armed] = await Promise.all([directoryIdentity(dir), entry.identity()])
  if (current === undefined || current === armed || isSuspended(entry.paths())) return
  if (dirWatches.get(watcherKey(wcId, dir)) === entry) entry.replaced()
}

export async function suspendFileWatchersIn(directory: string): Promise<() => void> {
  const real = await realDirectory(directory)
  const roots = real === directory ? [directory] : [directory, real]
  const covers = (entry: DirWatch): boolean =>
    entry.paths().some((path) => roots.some((root) => isWithin(path, root)))
  suspendedRoots.push(...roots)
  for (const entry of dirWatches.values()) if (covers(entry)) entry.suspend()
  let resumed = false
  return () => {
    if (resumed) return
    resumed = true
    for (const root of roots) suspendedRoots.splice(suspendedRoots.indexOf(root), 1)
    for (const entry of dirWatches.values()) {
      if (!covers(entry) || isSuspended(entry.paths())) continue
      entry.arm()
      if (!entry.sender.isDestroyed()) entry.sender.send('files:changed', entry.dir, null)
    }
  }
}

export function disposeFileWatchers(): void {
  fileWatchers.disposeAll()
}

export function registerFileHandlers(): void {
  ipcMain.handle('files:list', async (event, dir: string): Promise<DirListing> => {
    const listing = await listDirectory(dir)
    if (!('error' in listing)) await rearmIfReplaced(event.sender.id, dir)
    return listing
  })
  ipcMain.handle(
    'files:search',
    async (_event, root: string, query: string): Promise<SearchResult> => {
      const index = await fileIndex(root)
      return { ...searchFiles(index.files, query, maxSearchHits), partial: index.partial }
    }
  )
  ipcMain.handle('files:watch', (event, dir: string): void => watchDirectory(event.sender, dir))
  ipcMain.handle('files:unwatch', (event, dir: string): void => {
    fileWatchers.release(watcherKey(event.sender.id, dir))
  })
}
