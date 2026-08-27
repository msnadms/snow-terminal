import { isInside, normalizePath } from '@renderer/format'

export type WorkflowList = Awaited<ReturnType<typeof window.api.workflow.list>>
export type WorkflowEntry = WorkflowList['workflows'][number]
export type WorkflowRepo = Awaited<ReturnType<typeof window.api.workflow.overview>>['repos'][number]
export type WorkflowComparison = Awaited<
  ReturnType<typeof window.api.workflow.overview>
>['comparisons'][number]
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
  if (usable(entry) || entry.current) return 'Open'
  return 'Create'
}

export function stateLabel(entry: WorkflowEntry): string {
  if (usable(entry)) return ''
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

export type WorkflowOverlap = NonNullable<WorkflowEntry['overlaps']>[number]
export type WorkflowOverlapReport = Pick<WorkflowEntry, 'overlaps' | 'overlapTotals'>

export interface OverlapCounts {
  conflict: number
  unproven: number
  clean: number
  total: number
}

/**
 * Counted per verdict, because one number cannot carry them: a workspace whose every shared path
 * merges cleanly would otherwise wear the same warning badge as one nothing could prove. Totals come
 * from the pre-cap `overlapTotals` so the badge reports the workspace rather than however much of it
 * the panel can show. Drift against the default branch needs no special case here - main reports it
 * as ordinary `conflict` rows.
 */
export function overlapCounts(entry: WorkflowOverlapReport): OverlapCounts {
  const totals = entry.overlapTotals ?? { conflict: 0, overlap: 0, clean: 0 }
  return {
    conflict: totals.conflict,
    unproven: totals.overlap,
    clean: totals.clean,
    total: totals.conflict + totals.overlap + totals.clean
  }
}

type OverlapUnit = Exclude<keyof OverlapCounts, 'total'>

const overlapUnits: [OverlapUnit, string][] = [
  ['conflict', 'will not merge'],
  ['unproven', 'not proven to merge'],
  ['clean', 'merge cleanly']
]

function overlapPhrases(
  entry: WorkflowOverlapReport,
  render: (count: number, phrase: string) => string
): string[] {
  const counts = overlapCounts(entry)
  return overlapUnits
    .filter(([key]) => counts[key] > 0)
    .map(([key, phrase]) => render(counts[key], phrase))
}

/** How many claimed paths the capped `overlaps` array leaves unshown. */
export function overlapHidden(entry: WorkflowOverlapReport): number {
  return overlapCounts(entry).total - (entry.overlaps?.length ?? 0)
}

export function overlapSummary(entry: WorkflowOverlapReport): string {
  return overlapPhrases(entry, (count, phrase) => `${count} ${phrase}`).join(', ')
}

export function overlapTitle(entry: WorkflowOverlapReport): string {
  const lines = overlapPhrases(
    entry,
    (count, phrase) => `${count} shared file${count === 1 ? '' : 's'} ${phrase}`
  )
  lines.push('', 'Show the files')
  return lines.join('\n')
}

const sourceLabel: Record<WorkflowOverlap['source'], string> = {
  committed: 'committed',
  working: 'uncommitted',
  parked: 'parked'
}

const verdictLabel: Record<WorkflowOverlap['verdict'], string> = {
  conflict: 'will not merge',
  overlap: 'unproven',
  clean: 'merges cleanly'
}

/**
 * The verdict half of a row, rendered in its own span so color can carry the distinction - three
 * greys would not. When every claim *was* committed and the verdict is still unproven, the merge
 * itself failed to evaluate, which is a different thing to say than "someone has work in flight".
 */
export function overlapVerdict(overlap: WorkflowOverlap): string {
  const allCommitted =
    overlap.source === 'committed' && overlap.branches.every((c) => c.source === 'committed')
  const label =
    overlap.verdict === 'overlap' && allCommitted
      ? 'could not evaluate'
      : verdictLabel[overlap.verdict]
  return overlap.source === 'committed' ? label : `${label} (${sourceLabel[overlap.source]})`
}

/**
 * `fix-login (uncommitted)`. An unproven path this workspace committed reads as a contradiction
 * unless the row says whose claim could not be merged, so every claimant carries its own source and
 * only a committed one goes unlabelled.
 */
export function overlapClaimants(overlap: WorkflowOverlap): string {
  return overlap.branches
    .map((c) => (c.source === 'committed' ? c.branch : `${c.branch} (${sourceLabel[c.source]})`))
    .join(', ')
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

export interface InboxSignal {
  tier: number
  label: string
  slug: string
}

/**
 * One ordering for the whole screen, most blocking to the operator first. The evaluation order is
 * deliberately not the sort order: an agent still working suppresses "ready to review", because a
 * tree being edited is not a tree to review - but a branch that IS ready outranks one that is
 * merely working, since fan-out runs itself and fan-in is what waits on a human.
 */
export function inboxSignal(
  entry: WorkflowEntry,
  agents: { waiting: number; working: number },
  finished = false
): InboxSignal {
  if (agents.waiting > 0) {
    const waiting = agents.waiting === 1 ? 'needs input' : `${agents.waiting} need input`
    const working = agents.working > 0 ? ` · ${agents.working} working` : ''
    return {
      tier: 4,
      label: `${waiting}${working}`,
      slug: 'input'
    }
  }
  if (agents.working > 0)
    return {
      tier: 2,
      label: agents.working === 1 ? 'working' : `${agents.working} working`,
      slug: 'working'
    }
  if (entry.review && (entry.review.changed > 0 || (entry.review.ahead ?? 0) > 0))
    return { tier: 3, label: 'review', slug: 'review' }
  if (finished) return { tier: 3, label: 'finished', slug: 'finished' }
  if (entry.worktree && !usable(entry)) return { tier: 1, label: '', slug: '' }
  return { tier: 0, label: '', slug: '' }
}

/** The rows worth a glance: an agent is blocked, or there is work to fan back in. */
export function needsOperator(signal: InboxSignal): boolean {
  return signal.tier >= 3
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
