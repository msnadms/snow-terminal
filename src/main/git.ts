import { ipcMain, WebContents } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { simpleGit, SimpleGit, StatusResult } from 'simple-git'
import { filterPaths } from './snowignore'
import { registeredFor, workflowsPath } from './registry'

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

export interface GitCommitFile {
  path: string
  oldPath: string | null
  additions: number
  deletions: number
  binary: boolean
}

export interface GitBlameLine {
  hash: string
  author: string
  date: string
}

export type GitBlame = Record<number, GitBlameLine>

export interface GitCommitDetail {
  hash: string
  parents: string[]
  author: string
  email: string
  date: string
  subject: string
  body: string
  refs: string
  files: GitCommitFile[]
  patch: string
  truncated: boolean
}

export interface GitWorkingDiff {
  branch: string | null
  files: GitCommitFile[]
  patch: string
  truncated: boolean
}

export interface GitCommitPushResult {
  ok: boolean
  error?: string
}

export interface GitBranches {
  current: string | null
  branches: string[]
  remotes: string[]
}

export interface GitCheckoutResult {
  ok: boolean
  branch?: string
  parked?: number
  restored?: number
  conflicted?: string[]
  error?: string
  detail?: string
}

export interface GitSyncDefaultResult {
  ok: boolean
  branch?: string
  error?: string
  detail?: string
}

export interface GitUpdateDefaultResult {
  ok: boolean
  branch?: string
  from?: string
  updated?: boolean
  conflicted?: string[]
  error?: string
  detail?: string
}

export interface GitStatusFile {
  path: string
  from: string | null
  index: string
  working_dir: string
  ignored: boolean
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
  files: GitStatusFile[]
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

const detailFormat = ['%H', '%P', '%an', '%ae', '%aI', '%s', '%D', '%b'].join('%x1f')

const maxPatchChars = 2_000_000

const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

let scratchIndexCount = 0

function capPatch(patch: string): { patch: string; truncated: boolean } {
  if (patch.length <= maxPatchChars) return { patch, truncated: false }
  const head = patch.slice(0, maxPatchChars)
  const boundary = head.lastIndexOf('\ndiff --git ')
  return { patch: boundary > 0 ? head.slice(0, boundary + 1) : '', truncated: true }
}

function parseNumstat(raw: string): GitCommitFile[] {
  const tokens = raw.split('\0')
  const files: GitCommitFile[] = []
  for (let i = 0; i < tokens.length; i++) {
    const parts = tokens[i].split('\t')
    if (parts.length < 3) continue
    const [adds, dels, rest] = parts
    let oldPath: string | null = null
    let filePath = rest
    if (rest === '') {
      oldPath = tokens[++i] ?? ''
      filePath = tokens[++i] ?? ''
    }
    if (!filePath) continue
    files.push({
      path: filePath,
      oldPath: oldPath || null,
      additions: Number(adds) || 0,
      deletions: Number(dels) || 0,
      binary: adds === '-' && dels === '-'
    })
  }
  return files
}

const blameHeader = /^([0-9a-f]{40}) \d+ (\d+)/

function parseBlame(raw: string): GitBlame {
  const blame: GitBlame = {}
  let hash = ''
  let line = 0
  let author = ''
  let time = 0

  for (const text of raw.split('\n')) {
    if (text.startsWith('\t')) {
      if (line > 0) {
        blame[line] = { hash, author, date: time ? new Date(time * 1000).toISOString() : '' }
      }
      line = 0
      continue
    }
    const header = blameHeader.exec(text)
    if (header) {
      hash = header[1]
      line = Number(header[2])
      continue
    }
    if (text.startsWith('author ')) author = text.slice(7)
    else if (text.startsWith('author-time ')) time = Number(text.slice(12))
  }

  return blame
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

export function gitFor(cwd?: string): SimpleGit {
  const dir = cwd || os.homedir()
  let git = gitByPath.get(dir)
  if (!git) {
    git = simpleGit(dir).env('GIT_OPTIONAL_LOCKS', '0')
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

async function gitDir(cwd?: string): Promise<string | null> {
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

async function remoteName(cwd?: string): Promise<string | null> {
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

  try {
    const branch = (await git.raw(['symbolic-ref', '--short', 'HEAD'])).trim()
    const tracked = (await git.raw(['config', '--get', `branch.${branch}.remote`])).trim()
    if (tracked && remotes.includes(tracked)) return tracked
  } catch {
    /* empty */
  }

  return remotes.includes('origin') ? 'origin' : remotes[0]
}

export async function defaultBranch(
  cwd?: string,
  refresh = true
): Promise<{ remote: string; branch: string } | null> {
  const git = gitFor(cwd)
  const remote = await remoteName(cwd)
  if (!remote) return null

  if (refresh) {
    try {
      await git.raw(['fetch', remote])
      await git.raw(['remote', 'set-head', remote, '--auto'])
    } catch {
      /* empty */
    }
  }

  try {
    const ref = (await git.raw(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`])).trim()
    const prefix = `${remote}/`
    const branch = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref
    return branch ? { remote, branch } : null
  } catch {
    return null
  }
}

const markerPrefix = 'snow-wf:'
const markerPattern = new RegExp(`^(?:On [^:]+: )?${markerPrefix}(.+)$`)

interface StashEntry {
  selector: string
  branch: string
  date: string
}

interface Departure {
  current: string | null
  parked: number
  registered: string[]
}

export async function stashEntries(cwd?: string): Promise<StashEntry[]> {
  let raw: string
  try {
    raw = await gitFor(cwd).raw(['stash', 'list', '--format=%gd%x1f%gs%x1f%aI'])
  } catch {
    return []
  }

  const entries: StashEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [selector, subject, date] = line.split('\x1f')
    if (!selector || !subject) continue
    const match = markerPattern.exec(subject)
    if (!match) continue
    const branch = match[1].trim()
    if (branch) entries.push({ selector, branch, date: date ?? '' })
  }
  return entries
}

export function newestStash(entries: StashEntry[], branch: string): StashEntry | null {
  return entries.find((entry) => entry.branch === branch) ?? null
}

async function countLines(cwd: string | undefined, args: string[]): Promise<number | null> {
  try {
    const raw = await gitFor(cwd).raw(args)
    return raw.split('\n').filter((line) => line.trim()).length
  } catch {
    return null
  }
}

export async function parkedFiles(
  cwd: string | undefined,
  selector: string
): Promise<number | null> {
  const [tracked, untracked] = await Promise.all([
    countLines(cwd, ['stash', 'show', '--name-only', selector]),
    countLines(cwd, ['ls-tree', '-r', '--name-only', `${selector}^3`])
  ])
  return tracked === null ? null : tracked + (untracked ?? 0)
}

async function registeredBranches(cwd?: string): Promise<string[]> {
  const repo = await worktreeRoot(cwd)
  if (!repo) return []
  const { branches, error } = registeredFor(repo)
  if (error) throw new Error(`Could not read ${workflowsPath()}\n${error}`)
  return branches
}

async function parkPlan(cwd?: string): Promise<Departure & { status: StatusResult }> {
  const [registered, status] = await Promise.all([registeredBranches(cwd), gitFor(cwd).status()])
  const current = status.current
  const dirty = !!current && registered.includes(current) && status.files.length > 0
  return { current, parked: dirty ? status.files.length : 0, registered, status }
}

async function parkOnLeave(cwd?: string): Promise<Departure> {
  const { status, ...departure } = await parkPlan(cwd)
  if (departure.parked === 0) return departure

  if (status.conflicted.length > 0) {
    throw new Error(
      `Resolve conflicts on ${departure.current} before leaving it\n${status.conflicted.join('\n')}`
    )
  }

  await gitFor(cwd).raw(['stash', 'push', '-u', '-m', `${markerPrefix}${departure.current}`])
  return departure
}

async function restoreOnEnter(
  cwd: string | undefined,
  branch: string,
  registered: string[]
): Promise<GitCheckoutResult | null> {
  if (!registered.includes(branch)) return null
  const entry = newestStash(await stashEntries(cwd), branch)
  if (!entry) return null

  const files = await parkedFiles(cwd, entry.selector)
  try {
    await gitFor(cwd).raw(['stash', 'pop', entry.selector])
    return { ok: true, restored: files ?? 0 }
  } catch (error) {
    let conflicted: string[] = []
    try {
      conflicted = (await gitFor(cwd).status()).conflicted
    } catch {
      /* empty */
    }
    if (conflicted.length > 0) {
      return {
        ok: false,
        conflicted,
        error: 'Conflicts restoring parked changes',
        detail: [
          `Switched to ${branch}, but its parked changes conflict with the branch.`,
          'Resolve these files, then run: git stash drop',
          '',
          ...conflicted,
          '',
          'Your parked changes are still stashed, so nothing is lost.'
        ].join('\n')
      }
    }
    return { ok: false, error: errorText(error), detail: errorDetail(error) }
  }
}

async function rollbackPark(
  cwd: string | undefined,
  departure: Departure,
  failure: GitCheckoutResult
): Promise<GitCheckoutResult> {
  if (departure.parked === 0 || !departure.current) return failure

  const stranded = (): GitCheckoutResult => ({
    ...failure,
    detail: [
      failure.detail,
      [
        `Your changes are stashed as "${markerPrefix}${departure.current}" and could not be restored automatically.`,
        'Recover them with: git stash pop'
      ].join('\n')
    ]
      .filter(Boolean)
      .join('\n\n')
  })

  try {
    const entry = newestStash(await stashEntries(cwd), departure.current)
    if (!entry) return stranded()
    await gitFor(cwd).raw(['stash', 'pop', entry.selector])
    return failure
  } catch {
    return stranded()
  }
}

async function parkPreview(cwd?: string): Promise<{ branch: string; files: number } | null> {
  const { current, parked } = await parkPlan(cwd)
  return current && parked ? { branch: current, files: parked } : null
}

export async function switchBranch(
  cwd: string | undefined,
  target: string,
  checkout: (git: SimpleGit) => Promise<unknown>
): Promise<GitCheckoutResult> {
  let departure: Departure
  try {
    departure = await parkOnLeave(cwd)
  } catch (error) {
    return { ok: false, error: errorText(error), detail: errorDetail(error) }
  }

  try {
    await checkout(gitFor(cwd))
  } catch (error) {
    return rollbackPark(cwd, departure, {
      ok: false,
      error: errorText(error),
      detail: errorDetail(error)
    })
  }

  const restored = await restoreOnEnter(cwd, target, departure.registered)
  if (restored && !restored.ok) return { ...restored, branch: target, parked: departure.parked }
  return {
    ok: true,
    branch: target,
    parked: departure.parked,
    restored: restored?.restored ?? 0
  }
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
      '--topo-order': null,
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

  ipcMain.handle(
    'git:show',
    async (_event, cwd: string | undefined, hash: string): Promise<GitCommitDetail> => {
      const git = gitFor(cwd)
      const meta = (await git.raw(['show', '-s', `--format=${detailFormat}`, hash])).split('\x1f')
      const parents = (meta[1] ?? '').split(' ').filter(Boolean)
      const range = parents.length > 0 ? ['diff', parents[0], hash] : ['show', '--format=', hash]

      const [numstat, raw] = await Promise.all([
        git.raw([...range, '-M', '--numstat', '-z']),
        git.raw([...range, '-M', '--patch', '--no-color'])
      ])
      const { patch, truncated } = capPatch(raw)

      return {
        hash: meta[0] ?? hash,
        parents,
        author: meta[2] ?? '',
        email: meta[3] ?? '',
        date: meta[4] ?? '',
        subject: meta[5] ?? '',
        refs: meta[6] ?? '',
        body: (meta[7] ?? '').trim(),
        files: parseNumstat(numstat),
        patch,
        truncated
      }
    }
  )

  ipcMain.handle('git:diff', async (_event, cwd?: string): Promise<GitWorkingDiff> => {
    const git = gitFor(cwd)
    const root = (await worktreeRoot(cwd)) ?? cwd ?? os.homedir()
    const [branch, hasHead] = await Promise.all([
      git
        .raw(['rev-parse', '--abbrev-ref', 'HEAD'])
        .then((name) => name.trim())
        .catch(() => ''),
      git
        .raw(['rev-parse', '--verify', '--quiet', 'HEAD'])
        .then(() => true)
        .catch(() => false)
    ])

    const base = hasHead ? 'HEAD' : emptyTree
    const indexFile = path.join(os.tmpdir(), `snow-diff-${process.pid}-${++scratchIndexCount}`)
    const scratch = simpleGit(root)
      .env('GIT_OPTIONAL_LOCKS', '0')
      .env('GIT_INDEX_FILE', indexFile)

    try {
      await scratch.raw(['read-tree', base])
      await scratch.raw(['add', '-A', '-N'])

      const range = ['diff', base, '-M']
      const [numstat, raw] = await Promise.all([
        scratch.raw([...range, '--numstat', '-z']),
        scratch.raw([...range, '--patch', '--no-color'])
      ])
      const { patch, truncated } = capPatch(raw)

      return {
        branch: branch && branch !== 'HEAD' ? branch : null,
        files: parseNumstat(numstat),
        patch,
        truncated
      }
    } finally {
      await fs.promises.rm(indexFile, { force: true })
    }
  })

  ipcMain.handle(
    'git:blame',
    async (_event, cwd: string | undefined, rev: string, filePath: string): Promise<GitBlame> => {
      try {
        return parseBlame(await gitFor(cwd).raw(['blame', '--line-porcelain', rev, '--', filePath]))
      } catch {
        return {}
      }
    }
  )

  ipcMain.handle('git:status', async (_event, cwd?: string): Promise<GitStatus> => {
    const status = await gitFor(cwd).status()
    const stageable = filterPaths(status.files.map((f) => f.path))
    const keep = new Set(stageable)
    return {
      current: status.current,
      tracking: status.tracking,
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged,
      modified: status.modified,
      not_added: status.not_added,
      conflicted: status.conflicted,
      files: status.files.map((f) => ({
        path: f.path,
        from: f.from ?? null,
        index: f.index,
        working_dir: f.working_dir,
        ignored: !keep.has(f.path)
      })),
      changed: status.files.length,
      stageable: stageable.length
    }
  })

  ipcMain.handle('git:branches', async (_event, cwd?: string): Promise<GitBranches> => {
    const git = gitFor(cwd)
    let current: string | null = null
    let branches: string[] = []
    let remotes: string[] = []

    try {
      const summary = await git.branchLocal()
      current = summary.current || null
      branches = summary.all
    } catch {
      return { current: null, branches: [], remotes: [] }
    }

    try {
      const summary = await git.branch(['-r'])
      remotes = summary.all.filter((name) => !name.includes('->'))
    } catch {
      remotes = []
    }

    return { current, branches, remotes }
  })

  ipcMain.handle('git:defaultBranch', async (_event, cwd?: string): Promise<string | null> => {
    const target = await defaultBranch(cwd, false)
    return target?.branch ?? null
  })

  ipcMain.handle(
    'git:checkout',
    async (_event, cwd: string | undefined, branch: string): Promise<GitCheckoutResult> => {
      if (!branch) return { ok: false, error: 'Branch required' }
      return switchBranch(cwd, branch, (git) => git.checkout(branch))
    }
  )

  ipcMain.handle(
    'git:checkoutRemote',
    async (_event, cwd: string | undefined, ref: string): Promise<GitCheckoutResult> => {
      const remoteRef = (ref ?? '').trim()
      if (!remoteRef) return { ok: false, error: 'Branch required' }

      let local: string
      try {
        const remotes = await gitFor(cwd).getRemotes(false)
        const remote = remotes.find((r) => remoteRef.startsWith(`${r.name}/`))
        local = remote ? remoteRef.slice(remote.name.length + 1) : remoteRef
        if (!local) return { ok: false, error: 'Branch required' }
      } catch (error) {
        return { ok: false, error: errorText(error), detail: errorDetail(error) }
      }

      return switchBranch(cwd, local, async (git) => {
        const existing = await git.branchLocal()
        if (existing.all.includes(local)) await git.checkout(local)
        else await git.checkout(['--track', remoteRef])
      })
    }
  )

  ipcMain.handle(
    'git:createBranch',
    async (
      _event,
      cwd: string | undefined,
      branch: string,
      carry = false
    ): Promise<GitCheckoutResult> => {
      const name = (branch ?? '').trim()
      if (!name) return { ok: false, error: 'Branch name required' }
      if (!carry) return switchBranch(cwd, name, (git) => git.checkoutLocalBranch(name))
      try {
        await gitFor(cwd).checkoutLocalBranch(name)
        return { ok: true, branch: name }
      } catch (error) {
        return { ok: false, error: errorText(error), detail: errorDetail(error) }
      }
    }
  )

  ipcMain.handle(
    'git:parkPreview',
    async (_event, cwd?: string): Promise<{ branch: string; files: number } | null> => {
      try {
        return await parkPreview(cwd)
      } catch {
        return null
      }
    }
  )

  ipcMain.handle('git:syncDefault', async (_event, cwd?: string): Promise<GitSyncDefaultResult> => {
    const git = gitFor(cwd)
    const target = await defaultBranch(cwd)
    if (!target) return { ok: false, error: 'No default branch on remote' }
    const { remote, branch } = target

    try {
      const status = await git.status()
      if (status.current === branch) {
        await git.raw(['fetch', remote, branch])
        await git.raw(['merge', '--ff-only', `${remote}/${branch}`])
        return { ok: true, branch }
      }
      await git.raw(['fetch', remote, `${branch}:${branch}`])
    } catch (error) {
      return { ok: false, branch, error: errorText(error), detail: errorDetail(error) }
    }

    const result = await switchBranch(cwd, branch, (g) => g.checkout(branch))
    if (result.ok) return { ok: true, branch }
    const note = result.conflicted
      ? ''
      : `${branch} was updated from ${remote}, but the switch failed.`
    return {
      ok: false,
      branch,
      error: result.error,
      detail: [result.detail, note].filter(Boolean).join('\n\n')
    }
  })

  ipcMain.handle(
    'git:updateFromDefault',
    async (_event, cwd?: string): Promise<GitUpdateDefaultResult> => {
      const git = gitFor(cwd)
      const target = await defaultBranch(cwd)
      if (!target) return { ok: false, error: 'No default branch on remote' }
      const { remote, branch } = target
      const from = `${remote}/${branch}`

      let head: string
      let dirty: string[]
      try {
        const status = await git.status()
        if (!status.current) return { ok: false, error: 'HEAD is detached' }
        dirty = status.files
          .filter((f) => f.index !== '?' || f.working_dir !== '?')
          .map((f) => f.path)
        head = (await git.revparse(['HEAD'])).trim()
      } catch (error) {
        return { ok: false, branch, error: errorText(error), detail: errorDetail(error) }
      }

      if (dirty.length > 0) {
        return {
          ok: false,
          branch,
          from,
          error: 'Commit or stash your changes first',
          detail: dirty.join('\n')
        }
      }

      try {
        await git.raw(['fetch', remote, branch])
      } catch (error) {
        return { ok: false, branch, from, error: errorText(error), detail: errorDetail(error) }
      }

      try {
        await git.raw(['merge', '--no-edit', from])
      } catch (error) {
        let conflicted: string[] = []
        try {
          conflicted = (await git.status()).conflicted
        } catch {
          /* empty */
        }
        if (conflicted.length > 0) {
          return {
            ok: false,
            branch,
            from,
            conflicted,
            error: `Conflicts merging ${from}`,
            detail: [
              'Merge left in progress. Resolve these files, then commit:',
              '',
              ...conflicted,
              '',
              'Or run: git merge --abort'
            ].join('\n')
          }
        }
        return { ok: false, branch, from, error: errorText(error), detail: errorDetail(error) }
      }

      try {
        const after = (await git.revparse(['HEAD'])).trim()
        return { ok: true, branch, from, updated: after !== head }
      } catch {
        return { ok: true, branch, from, updated: true }
      }
    }
  )

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
          const remote = (await remoteName(cwd)) ?? 'origin'
          await git.push(['--set-upstream', remote, status.current])
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
