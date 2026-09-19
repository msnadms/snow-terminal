import fs from 'fs'
import path from 'path'
import { expandHome, samePath } from './config'
import { defaultBranch, gitFor, isStaged, mainWorktreeRoot, worktreeMap } from './gitCore'
import {
  claimsOf,
  resolveOverlaps,
  workingClaims,
  type DescribedWorkflow,
  type PathClaim
} from './overlaps'
import { newestStash, parkedFilePaths, parkedFiles, stashEntries } from './park'
import { filterByRepo, type WorkflowRecord } from './registry'
import type { WorkflowEntry, WorkflowList, WorkflowRepo, WorkflowReview } from './workflowTypes'
import {
  aheadOf,
  branchHeads,
  committedPaths,
  mergedInto,
  orphansOf,
  resolveBase
} from './worktrees'

interface WorkflowReviewState {
  review: WorkflowReview
  claims: PathClaim[]
}

export function emptyList(error: string | null = null, repo: string | null = null): WorkflowList {
  return { repo, current: null, defaultBranch: null, workflows: [], error }
}

function missingEntry({ branch, worktree }: WorkflowRecord): WorkflowEntry {
  return {
    branch,
    current: false,
    exists: false,
    parked: null,
    worktree: worktree ? expandHome(worktree) : undefined,
    worktreeExists: worktree ? false : undefined,
    worktreeLinked: worktree ? false : undefined
  }
}

async function reviewOf(directory: string, bases: string[]): Promise<WorkflowReviewState | null> {
  try {
    const status = await gitFor(directory).status()
    const [committed, ahead] = await Promise.all([
      committedPaths(directory, bases),
      aheadOf(directory, bases)
    ])
    return {
      review: {
        changed: status.files.length,
        staged: status.files.filter((file) => isStaged(file.index)).length,
        ahead
      },
      claims: [...claimsOf(committed, 'committed'), ...workingClaims(status)]
    }
  } catch {
    return null
  }
}

export async function describeWorkflows(
  cwd: string | undefined,
  repo: string | null,
  records: WorkflowRecord[],
  error: string | null,
  detail = false
): Promise<WorkflowList> {
  const [summary, entries, target, checkedOut, heads] = await Promise.all([
    gitFor(cwd)
      .branchLocal()
      .catch(() => null),
    stashEntries(cwd),
    defaultBranch(cwd, false),
    worktreeMap(cwd),
    detail ? branchHeads(cwd) : new Map<string, string>()
  ])
  if (!summary) return emptyList(error, repo)

  const current = summary.current || null
  const bases = target ? [`${target.remote}/${target.branch}`, target.branch] : []
  const baseSha = detail && bases.length > 0 ? await resolveBase(cwd, bases) : null
  const described = await Promise.all(
    records.map(async ({ branch, worktree }): Promise<DescribedWorkflow> => {
      const entry = newestStash(entries, branch)
      const absoluteWorktree = worktree ? expandHome(worktree) : undefined
      const worktreeExists = absoluteWorktree
        ? await fs.promises
            .access(absoluteWorktree)
            .then(() => true)
            .catch(() => false)
        : undefined
      const linked = checkedOut.get(branch)
      const worktreeLinked = absoluteWorktree
        ? !!linked && samePath(linked, absoluteWorktree)
        : undefined
      const reviewDir =
        absoluteWorktree && worktreeExists && worktreeLinked !== false
          ? absoluteWorktree
          : branch === current
            ? (repo ?? cwd ?? null)
            : null
      const [review, parkedPaths, merged] = await Promise.all([
        detail && reviewDir ? reviewOf(reviewDir, bases) : null,
        detail && entry ? parkedFilePaths(cwd, entry.selector) : null,
        detail && summary.all.includes(branch)
          ? mergedInto(cwd, branch, baseSha, heads.get(branch) ?? null)
          : null
      ])
      return {
        entry: {
          branch,
          current: branch === current,
          exists: summary.all.includes(branch),
          parked: entry
            ? {
                files: detail
                  ? (parkedPaths?.length ?? null)
                  : await parkedFiles(cwd, entry.selector),
                date: entry.date,
                count: entries.filter((candidate) => candidate.branch === branch).length
              }
            : null,
          worktree: absoluteWorktree,
          worktreeExists,
          worktreeLinked,
          merged,
          review: review?.review
        },
        claims: [...(review?.claims ?? []), ...claimsOf(parkedPaths, 'parked')],
        head: heads.get(branch) ?? null
      }
    })
  )

  const [workflows, orphans] = await Promise.all([
    detail
      ? resolveOverlaps(cwd, repo, described, current, baseSha, target?.branch ?? null)
      : described.map(({ entry }) => entry),
    detail
      ? orphansOf(cwd, repo, checkedOut, new Set(records.map((r) => r.branch)), baseSha, heads)
      : undefined
  ])

  return { repo, current, defaultBranch: target?.branch ?? null, workflows, orphans, error }
}

export async function describeRepo(
  repo: string,
  records: WorkflowRecord[],
  detail: boolean
): Promise<WorkflowRepo> {
  const root = await mainWorktreeRoot(repo)
  if (root)
    return {
      name: path.basename(root),
      unreachable: false,
      ...(await describeWorkflows(root, root, filterByRepo(records, root), null, detail)),
      repo: root
    }

  return {
    name: path.basename(repo),
    unreachable: true,
    ...emptyList(null, repo),
    workflows: filterByRepo(records, repo).map(missingEntry),
    repo
  }
}
