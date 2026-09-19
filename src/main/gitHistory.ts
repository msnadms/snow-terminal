import { ipcMain } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { simpleGit } from 'simple-git'
import { defaultBranch, gitFor, gitOptions, worktreeRoot } from './gitCore'
import type {
  GitBlame,
  GitBlameResult,
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  GitLog,
  GitReviewDiff,
  GitWorkingDiff
} from './gitTypes'

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

const maxSourceChars = 400_000

const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

let scratchIndexCount = 0

async function workingTreeDiff(
  cwd?: string,
  baseOverride?: string,
  includeStaging = true
): Promise<GitWorkingDiff> {
  const git = gitFor(cwd)
  const root = (await worktreeRoot(cwd)) ?? cwd ?? os.homedir()
  const [branch, head] = await Promise.all([
    git
      .raw(['rev-parse', '--abbrev-ref', 'HEAD'])
      .then((name) => name.trim())
      .catch(() => ''),
    git
      .raw(['rev-parse', '--verify', '--quiet', 'HEAD'])
      .then((sha) => sha.trim())
      .catch(() => '')
  ])

  const base = (baseOverride ?? head) || emptyTree
  const indexFile = path.join(os.tmpdir(), `snow-diff-${process.pid}-${++scratchIndexCount}`)
  const scratch = simpleGit(root, gitOptions)
    .env('GIT_OPTIONAL_LOCKS', '0')
    .env('GIT_INDEX_FILE', indexFile)
  const stagedPaths = includeStaging
    ? git
        .raw(['diff', '--cached', '--name-only', '-z', base])
        .then((out) => new Set(out.split('\0').filter(Boolean)))
        .catch(() => new Set<string>())
    : Promise.resolve(new Set<string>())

  try {
    await scratch.raw(['read-tree', base])
    await scratch.raw(['add', '-A', '-N'])

    const range = ['diff', base, '-M']
    const [numstat, raw, staged] = await Promise.all([
      scratch.raw([...range, '--numstat', '-z']),
      scratch.raw([...range, '--patch', '--no-color']),
      stagedPaths
    ])
    const { patch, truncated } = capPatch(raw)
    const files = parseNumstat(numstat)
    if (includeStaging) {
      for (const file of files) file.staged = staged.has(file.path)
    }

    return {
      branch: branch && branch !== 'HEAD' ? branch : null,
      base,
      files,
      patch,
      truncated
    }
  } finally {
    await fs.promises.rm(indexFile, { force: true })
  }
}

export function capPatch(
  patch: string,
  limit = maxPatchChars
): { patch: string; truncated: boolean } {
  if (patch.length <= limit) return { patch, truncated: false }
  const head = patch.slice(0, limit)
  const boundary = head.lastIndexOf('\ndiff --git ')
  return { patch: boundary > 0 ? head.slice(0, boundary + 1) : '', truncated: true }
}

export function parseNumstat(raw: string): GitCommitFile[] {
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

export function parseBlame(raw: string): GitBlameResult {
  const lines: GitBlame = {}
  const content: string[] = []
  let hash = ''
  let line = 0
  let author = ''
  let time = 0

  for (const text of raw.split('\n')) {
    if (text.startsWith('\t')) {
      if (line > 0) {
        lines[line] = { hash, author, date: time ? new Date(time * 1000).toISOString() : '' }
      }
      content.push(text.slice(1))
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

  const source = content.join('\n')
  return { lines, source: source.length > maxSourceChars ? null : source }
}

export function layout(raw: Omit<GitCommit, 'col' | 'row'>[]): GitLog {
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

export function registerHistoryHandlers(): void {
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
    return workingTreeDiff(cwd)
  })

  ipcMain.handle('git:reviewDiff', async (_event, cwd?: string): Promise<GitReviewDiff> => {
    const git = gitFor(cwd)
    const target = await defaultBranch(cwd, false)
    if (!target) throw new Error('Could not find the remote default branch')

    const candidates = [`${target.remote}/${target.branch}`, target.branch]
    for (const candidate of candidates) {
      try {
        const base = (await git.raw(['merge-base', candidate, 'HEAD'])).trim()
        if (!base) continue
        return {
          ...(await workingTreeDiff(cwd, base, false)),
          target: candidate
        }
      } catch {
        continue
      }
    }

    throw new Error(`Could not find a merge base with ${candidates.join(' or ')}`)
  })

  ipcMain.handle(
    'git:blame',
    async (
      _event,
      cwd: string | undefined,
      rev: string,
      filePath: string
    ): Promise<GitBlameResult> => {
      try {
        return parseBlame(await gitFor(cwd).raw(['blame', '--line-porcelain', rev, '--', filePath]))
      } catch {
        return { lines: {}, source: null }
      }
    }
  )
}
