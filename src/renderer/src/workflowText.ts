import { isInside, normalizePath } from '@renderer/format'

export type WorkflowList = Awaited<ReturnType<typeof window.api.workflow.list>>
export type WorkflowEntry = WorkflowList['workflows'][number]
export type WorkflowRepo = Awaited<ReturnType<typeof window.api.workflow.overview>>['repos'][number]
export type WorkflowResult = Awaited<ReturnType<typeof window.api.workflow.switch>>

function parkedCount(files: number | null): string {
  return files === null ? 'Parked changes' : `${files} parked file${files === 1 ? '' : 's'}`
}

export function parkedStay(files: number | null): string {
  if (files === null) return 'Its parked changes stay in the stash.'
  return `Its ${files} parked file${files === 1 ? '' : 's'} ${files === 1 ? 'stays' : 'stay'} in the stash.`
}

/**
 * Every directory whose git activity can change this repo's workflows. The stash is shared across
 * a repository, so a linked worktree's writes matter here even though it lives outside the root.
 */
export function repoScope(repo: string | null, workflows: WorkflowEntry[]): string[] {
  const dirs = workflows.map((entry) => entry.worktree).filter((dir): dir is string => !!dir)
  return (repo ? [repo, ...dirs] : dirs).map(normalizePath)
}

export function inScope(changed: string | null, scope: string[]): boolean {
  if (!changed) return false
  const path = normalizePath(changed)
  return scope.some((dir) => isInside(path, dir) || isInside(dir, path))
}

export function usable(entry: WorkflowEntry): boolean {
  return !!entry.worktree && !!entry.worktreeExists && entry.worktreeLinked !== false
}

export function isRegistered(workflows: WorkflowEntry[]): boolean {
  return workflows.some((entry) => entry.current)
}

export function launchLabel(entry: WorkflowEntry): string {
  if (usable(entry) || entry.current) return 'Open workspace'
  return 'Create workspace'
}

export function stateLabel(entry: WorkflowEntry): string {
  if (usable(entry)) return 'live'
  if (entry.worktree) return 'stale'
  if (!entry.exists) return 'missing'
  if (entry.current) return 'checked out'
  return ''
}

/** A label with a space in it would otherwise emit two class names, one of them stray. */
export function stateSlug(state: string): string {
  return state.replace(/\s+/g, '-')
}

/** The `● N` badge, with a multiplier when earlier parks were kept by a conflicting pop. */
export function parkedBadge(parked: NonNullable<WorkflowEntry['parked']>): string {
  return `● ${parked.files ?? '?'}${parked.count > 1 ? ` ×${parked.count}` : ''}`
}

type Review = NonNullable<WorkflowEntry['review']>

/** `3 ~ 1 + ↑2`: changed files, staged files, commits ahead of the default branch. */
export function reviewBadge(review: Review): string {
  const parts = [`${review.changed} ~`]
  if (review.staged > 0) parts.push(`${review.staged} +`)
  if (review.ahead) parts.push(`↑${review.ahead}`)
  return parts.join(' ')
}

export function reviewTitle(entry: WorkflowEntry, review: Review): string {
  const lines = [
    `${review.changed} changed file${review.changed === 1 ? '' : 's'}${
      review.staged > 0 ? `, ${review.staged} staged` : ''
    }`
  ]
  if (review.ahead !== null)
    lines.push(`${review.ahead} commit${review.ahead === 1 ? '' : 's'} ahead of the default branch`)
  if (review.changed > 0) lines.push('', `Open ${entry.branch}'s working diff`)
  return lines.join('\n')
}

export function staleTitle(entry: WorkflowEntry): string {
  return entry.worktreeExists
    ? `${entry.branch}'s worktree directory is left over - prune, then delete it by hand`
    : `${entry.branch}'s worktree is missing - prune the stale git entry`
}

export function parkedTitle(entry: WorkflowEntry): string {
  if (!entry.parked) return `No parked changes on ${entry.branch}`
  const files = parkedCount(entry.parked.files)
  const when = entry.parked.date ? new Date(entry.parked.date).toLocaleString() : ''
  const newest = when ? `${files} - ${when}` : files
  if (entry.parked.count < 2) return newest
  return [
    `${newest} (newest of ${entry.parked.count} parks)`,
    '',
    `An earlier restore on ${entry.branch} conflicted, so git kept its stash. snow restores the newest;`,
    'the older ones are still in `git stash list` under the same name.'
  ].join('\n')
}
