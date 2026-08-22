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

export function usable(entry: WorkflowEntry): boolean {
  return !!entry.worktree && !!entry.worktreeExists && entry.worktreeLinked !== false
}

export function isRegistered(workflows: WorkflowEntry[]): boolean {
  return workflows.some((entry) => entry.current)
}

export function launchLabel(entry: WorkflowEntry): string {
  if (usable(entry) || entry.current) return 'Open'
  return 'Launch'
}

export function stateLabel(entry: WorkflowEntry): string {
  if (usable(entry)) return 'live'
  if (entry.worktree) return 'stale'
  if (!entry.exists) return 'missing'
  if (entry.current) return 'checked out'
  return ''
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
  return when ? `${files} - ${when}` : files
}
