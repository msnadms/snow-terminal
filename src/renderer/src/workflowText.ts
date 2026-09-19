import { isInside, normalizePath } from '@renderer/format'
import type { AgentSession, AgentSummary } from '@renderer/useAgents'

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
  if (!usable(entry)) {
    if (entry.worktree) return 'stale'
    if (!entry.exists) return 'missing'
  }
  if (entry.merged === true) return 'merged'
  if (usable(entry)) return ''
  if (entry.current) return 'checked out'
  return ''
}

export function stateSlug(state: string): string {
  return state.replace(/\s+/g, '-')
}

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

export function overlapVerdict(overlap: WorkflowOverlap): string {
  const allCommitted =
    overlap.source === 'committed' && overlap.branches.every((c) => c.source === 'committed')
  const label =
    overlap.verdict === 'overlap' && allCommitted
      ? 'could not evaluate'
      : verdictLabel[overlap.verdict]
  return overlap.source === 'committed' ? label : `${label} (${sourceLabel[overlap.source]})`
}

export function overlapClaimants(overlap: WorkflowOverlap): string {
  return overlap.branches
    .map((c) => (c.source === 'committed' ? c.branch : `${c.branch} (${sourceLabel[c.source]})`))
    .join(', ')
}

type Review = NonNullable<WorkflowEntry['review']>

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

export type WorkflowOrphan = NonNullable<WorkflowRepo['orphans']>[number]

export type CleanupKind = 'workspace' | 'stale' | 'orphan'

type CleanupBase = {
  repo: string
  repoName: string
  branch: string
  reasons: string[]
  suggested: boolean
}

export type CleanupTarget = CleanupBase &
  (
    | { kind: 'orphan'; directory: string }
    | { kind: 'workspace' | 'stale'; directory: string | null }
  )

export function cleanupCandidate(
  entry: WorkflowEntry,
  activity: { agents: AgentSession[]; summary: AgentSummary }
): boolean {
  return (
    entry.merged === true &&
    !entry.current &&
    !entry.parked &&
    (entry.review?.changed ?? 0) === 0 &&
    activity.agents.length === 0 &&
    activity.summary.waiting === 0 &&
    activity.summary.working === 0
  )
}

export function cleanupStale(entry: WorkflowEntry): boolean {
  return !!entry.worktree && !usable(entry) && !entry.parked
}

export function cleanupOrphan(orphan: WorkflowOrphan): boolean {
  return orphan.merged === true && orphan.changed === 0
}

export function cleanupReasons(entry: WorkflowEntry): string[] {
  return entry.review ? ['merged', 'no changes', 'nothing parked'] : ['merged', 'nothing parked']
}

export function cleanupScope(kind: CleanupKind): string {
  if (kind === 'stale') return 'Removes the workspace record. Nothing is on disk to delete.'
  if (kind === 'orphan') return 'Removes the worktree directory. The branch stays.'
  return 'Removes the worktree directory and the workspace record. The branch stays.'
}
