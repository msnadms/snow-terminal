import type { GitCheckoutResult } from './gitTypes'

export interface WorkflowParked {
  files: number | null
  date: string
  count: number
}

export interface WorkflowReview {
  changed: number
  staged: number
  ahead: number | null
}

export type OverlapSource = 'committed' | 'working' | 'parked'

export type OverlapVerdict = 'conflict' | 'overlap' | 'clean'

export interface WorkflowClaimant {
  branch: string
  source: OverlapSource
}

export interface WorkflowOverlap {
  path: string
  verdict: OverlapVerdict
  source: OverlapSource
  branches: WorkflowClaimant[]
}

export interface WorkflowOverlapReport {
  overlaps: WorkflowOverlap[]
  overlapTotals: Record<OverlapVerdict, number>
}

export interface WorkflowEntry {
  branch: string
  current: boolean
  exists: boolean
  parked: WorkflowParked | null
  worktree?: string
  worktreeExists?: boolean
  worktreeLinked?: boolean
  merged?: boolean | null
  review?: WorkflowReview
  overlaps?: WorkflowOverlap[]
  overlapTotals?: Record<OverlapVerdict, number>
}

export interface WorkflowOrphan {
  branch: string
  directory: string
  merged: boolean | null
  changed: number | null
  inContainer: boolean
}

export interface WorkflowList {
  repo: string | null
  current: string | null
  defaultBranch: string | null
  workflows: WorkflowEntry[]
  orphans?: WorkflowOrphan[]
  error: string | null
}

export interface WorkflowRepo extends WorkflowList {
  repo: string
  name: string
  unreachable: boolean
}

export interface WorkflowSessionComparison extends WorkflowOverlapReport {
  directory: string
  repo: string | null
  branch: string | null
  defaultBranch: string | null
}

export interface WorkflowOverview {
  repos: WorkflowRepo[]
  comparisons: WorkflowSessionComparison[]
  error: string | null
}

export type WorkflowResult = GitCheckoutResult & { worktree?: string }
