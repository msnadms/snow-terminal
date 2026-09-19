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
  common: string
}

export interface GitCommitFile {
  path: string
  oldPath: string | null
  additions: number
  deletions: number
  binary: boolean
  staged?: boolean
}

export interface GitBlameLine {
  hash: string
  author: string
  date: string
}

export type GitBlame = Record<number, GitBlameLine>

export interface GitBlameResult {
  lines: GitBlame
  source: string | null
}

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
  base: string
  files: GitCommitFile[]
  patch: string
  truncated: boolean
}

export interface GitReviewDiff extends GitWorkingDiff {
  target: string
}

export interface GitCommitResult {
  ok: boolean
  error?: string
  detail?: string
  blocked?: string[]
}

export type GitFileResult = GitCommitResult

export type CommitIgnored = 'block' | 'unstage' | 'include'

export interface GitCommitMessageResult {
  ok: boolean
  message?: string
  error?: string
  detail?: string
}

export interface GitBranches {
  current: string | null
  branches: string[]
  remotes: string[]
  worktrees: Record<string, string>
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

export type GitSyncAction = 'push' | 'pull' | 'fetch'

export interface GitSyncResult {
  ok: boolean
  action?: GitSyncAction
  branch?: string
  error?: string
  detail?: string
}

export interface GitUndoResult {
  ok: boolean
  subject?: string
  body?: string
  error?: string
  detail?: string
}

export interface GitPullRequestResult {
  ok: boolean
  url?: string
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
  stagedCount: number
  ignoreError: string | null
}
