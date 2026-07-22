import { ipcMain } from 'electron'
import os from 'os'
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
  const path = cwd || os.homedir()
  let git = gitByPath.get(path)
  if (!git) {
    git = simpleGit(path)
    gitByPath.set(path, git)
  }
  return git
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
}
