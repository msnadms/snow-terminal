import { useEffect, useRef, useState } from 'react'
import FailureDialog from './FailureDialog'
import { type Failure } from '@renderer/format'
import { useGitAction } from '@renderer/useGitAction'
import { useLatestRun } from '@renderer/useLatestRun'

type WorkflowList = Awaited<ReturnType<typeof window.api.workflow.list>>
type WorkflowEntry = WorkflowList['workflows'][number]
type WorkflowResult = Awaited<ReturnType<typeof window.api.workflow.switch>>

interface WorkflowSelectProps {
  cwd?: string
  onOpenWorktree?: (cwd: string) => void
  onCloseWorktree?: (cwd: string) => void
}

function parkedCount(files: number | null): string {
  return files === null ? 'Parked changes' : `${files} parked file${files === 1 ? '' : 's'}`
}

function parkedStay(files: number | null): string {
  if (files === null) return 'Its parked changes stay in the stash.'
  return `Its ${files} parked file${files === 1 ? '' : 's'} ${files === 1 ? 'stays' : 'stay'} in the stash.`
}

function usable(entry: WorkflowEntry): boolean {
  return !!entry.worktree && !!entry.worktreeExists && entry.worktreeLinked !== false
}

function staleTitle(entry: WorkflowEntry): string {
  return entry.worktreeExists
    ? `${entry.branch}'s worktree directory is left over - prune, then delete it by hand`
    : `${entry.branch}'s worktree is missing - prune the stale git entry`
}

function parkedTitle(entry: WorkflowEntry): string {
  if (!entry.parked) return `No parked changes on ${entry.branch}`
  const files = parkedCount(entry.parked.files)
  const when = entry.parked.date ? new Date(entry.parked.date).toLocaleString() : ''
  return when ? `${files} - ${when}` : files
}

function WorkflowSelect({
  cwd,
  onOpenWorktree,
  onCloseWorktree
}: WorkflowSelectProps): React.JSX.Element | null {
  const [list, setList] = useState<WorkflowList | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [removing, setRemoving] = useState<WorkflowEntry | null>(null)
  const [demoting, setDemoting] = useState<WorkflowEntry | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const latestRun = useLatestRun()
  const [refreshKey, setRefreshKey] = useState(0)

  const action = useGitAction<WorkflowResult>({
    onFailure: setFailure,
    onSettled: () => setRefreshKey((key) => key + 1)
  })

  useEffect(() => {
    const load = async (): Promise<void> => {
      if (!cwd) return
      const isCurrent = latestRun()
      const result = await window.api.workflow.list(cwd)
      if (!isCurrent()) return
      if (result.error) console.error(`snow: failed to read workflows: ${result.error}`)
      setList(result)
    }

    load()
    const offGit = window.api.git.onChanged(() => load())
    const offWorkflow = window.api.workflow.onChanged(() => load())

    return () => {
      offGit()
      offWorkflow()
    }
  }, [cwd, refreshKey, latestRun])

  useEffect(() => {
    if (!open) return

    searchRef.current?.focus()

    const onPointerDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!list || !list.current) return null

  const { current, defaultBranch, workflows, error: readError } = list
  const registered = workflows.some((entry) => entry.current)

  const toggle = (): void => {
    setQuery('')
    setOpen((prev) => !prev)
  }

  const switchTo = (entry: WorkflowEntry): void => {
    if (action.pending || !entry.exists) return
    setOpen(false)
    if (entry.worktree) {
      if (!usable(entry)) {
        setFailure({
          title: entry.worktreeExists
            ? `${entry.branch}'s worktree is no longer registered with git`
            : `${entry.branch}'s worktree directory is missing`,
          detail: entry.worktree
        })
        return
      }
      onOpenWorktree?.(entry.worktree)
      return
    }
    if (entry.current) return
    action.run(() => window.api.workflow.switch(cwd, entry.branch), 'Switching…')
  }

  const promote = (entry: WorkflowEntry): void => {
    if (action.pending || entry.current || !entry.exists) return
    setOpen(false)
    action.run(async () => {
      const result = await window.api.workflow.promote(cwd, entry.branch)
      if (result.worktree) onOpenWorktree?.(result.worktree)
      return result
    }, 'Starting parallel session…')
  }

  const demote = (): void => {
    const entry = demoting
    setDemoting(null)
    if (!entry || action.pending) return
    action.run(async () => {
      const result = await window.api.workflow.demote(cwd, entry.branch)
      if (result.worktree) onCloseWorktree?.(result.worktree)
      return result
    }, 'Stopping parallel session…')
  }

  const prune = (): void => {
    if (action.pending) return
    action.run(() => window.api.workflow.prune(cwd), 'Pruning…')
  }

  const create = (e: React.FormEvent): void => {
    e.preventDefault()
    const name = newName.trim()
    if (!name || action.pending) return
    setNewName('')
    setOpen(false)
    action.run(() => window.api.workflow.create(cwd, name), 'Creating…')
  }

  const register = (): void => {
    if (action.pending) return
    setOpen(false)
    action.run(() => window.api.workflow.register(cwd), 'Registering…')
  }

  const unregister = (): void => {
    const entry = removing
    setRemoving(null)
    if (!entry || action.pending) return
    action.run(() => window.api.workflow.unregister(cwd, entry.branch), 'Removing…')
  }

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? workflows.filter((entry) => entry.branch.toLowerCase().includes(needle))
    : workflows

  return (
    <div className="picker-select picker-workflow" ref={rootRef}>
      <button
        className={`picker-button${action.className}`}
        disabled={action.pending}
        onClick={toggle}
        title={
          action.error ||
          (readError && `Could not read your workflows - ${readError}`) ||
          (registered
            ? `Workflow: ${current}`
            : `${current} is not a registered workflow - snow leaves it alone`)
        }
      >
        <span className="picker-icon">{''}</span>
        <span className={`picker-name${registered ? '' : ' workflow-unregistered'}`}>
          {action.label || (registered ? current : 'Workflows')}
        </span>
        <span className="picker-caret">▾</span>
      </button>
      {open && (
        <div className="picker-menu">
          {readError && (
            <div className="workflow-error">
              Could not read your workflows. Branch switches will not park or restore until this is
              fixed.
              {'\n'}
              {readError}
            </div>
          )}
          {workflows.length > 3 && (
            <input
              ref={searchRef}
              className="picker-search"
              placeholder="Search workflows…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <div className="picker-list">
            {visible.length === 0 && (
              <div className="picker-none">
                {workflows.length === 0 ? 'No workflows registered' : 'No matches'}
              </div>
            )}
            {visible.map((entry) => (
              <div key={entry.branch} className="workflow-row">
                <button
                  className={`picker-item workflow-item${entry.current ? ' picker-item-current' : ''}${
                    entry.exists ? '' : ' workflow-missing'
                  }`}
                  title={
                    usable(entry)
                      ? `Open ${entry.branch}'s session`
                      : entry.worktree
                        ? staleTitle(entry)
                        : entry.exists
                          ? parkedTitle(entry)
                          : `Branch ${entry.branch} no longer exists${
                              entry.parked ? '; its parked changes are still stashed' : ''
                            }`
                  }
                  onClick={() => switchTo(entry)}
                >
                  <span className="workflow-label">
                    {entry.worktree ? '▸ ' : ''}
                    {entry.branch}
                  </span>
                  {usable(entry) && <span className="workflow-live">⧖ live</span>}
                  {entry.parked && (
                    <span className="workflow-parked">● {entry.parked.files ?? '?'}</span>
                  )}
                </button>
                {!entry.worktree && entry.exists && !entry.current && (
                  <button
                    className="workflow-drop"
                    title={`Run ${entry.branch} in parallel`}
                    onClick={() => promote(entry)}
                  >
                    ⧖
                  </button>
                )}
                {usable(entry) && (
                  <button
                    className="workflow-drop"
                    title={`Stop ${entry.branch}'s parallel session`}
                    onClick={() => setDemoting(entry)}
                  >
                    ∥
                  </button>
                )}
                {entry.worktree && !usable(entry) && (
                  <button className="workflow-drop" title={staleTitle(entry)} onClick={prune}>
                    ⟳
                  </button>
                )}
                <button
                  className="workflow-drop"
                  title={`Remove ${entry.branch} from your workflows`}
                  onClick={() => setRemoving(entry)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          {!registered && (
            <button className="workflow-register" onClick={register}>
              Register {current}
            </button>
          )}
          <form className="picker-create" onSubmit={create}>
            <input
              className="picker-create-input"
              placeholder="New workflow…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button className="picker-create-button" type="submit" disabled={!newName.trim()}>
              +
            </button>
          </form>
          <div className="workflow-base">
            {defaultBranch ? `Branches from origin/${defaultBranch}` : 'Branches from HEAD'}
          </div>
        </div>
      )}
      {removing && (
        <div className="git-dialog-backdrop" onPointerDown={() => setRemoving(null)}>
          <div className="git-dialog" onPointerDown={(e) => e.stopPropagation()}>
            <div className="git-dialog-title">Remove workflow {removing.branch}?</div>
            <pre className="git-dialog-detail">
              {[
                `The branch ${removing.branch} is not deleted - snow just stops tracking it as a workflow.`,
                removing.parked
                  ? `\n${parkedStay(removing.parked.files)} Recover them with:\n  git stash list\n  git stash pop <entry>`
                  : ''
              ].join('')}
            </pre>
            <div className="git-dialog-actions">
              <button className="git-dialog-button" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button className="git-dialog-button" onClick={unregister}>
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
      {demoting && (
        <div className="git-dialog-backdrop" onPointerDown={() => setDemoting(null)}>
          <div className="git-dialog" onPointerDown={(e) => e.stopPropagation()}>
            <div className="git-dialog-title">Stop {demoting.branch}&apos;s parallel session?</div>
            <pre className="git-dialog-detail">
              {[
                `Changes will be parked on ${demoting.branch} before its worktree is removed.`,
                '',
                'Its terminal session will close. Ignored files (for example node_modules, .env, dist, and out) cannot be stashed and will be deleted from that worktree.'
              ].join('\n')}
            </pre>
            <div className="git-dialog-actions">
              <button className="git-dialog-button" onClick={() => setDemoting(null)}>
                Cancel
              </button>
              <button className="git-dialog-button" onClick={demote}>
                Stop session and delete ignored files
              </button>
            </div>
          </div>
        </div>
      )}
      {failure && <FailureDialog failure={failure} onDismiss={() => setFailure(null)} />}
    </div>
  )
}

export default WorkflowSelect
