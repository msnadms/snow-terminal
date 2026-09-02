import { useMemo, useState } from 'react'
import GitDialog from './GitDialog'
import { cleanupScope, type CleanupTarget } from '@renderer/workflowText'

interface CleanupDialogProps {
  targets: CleanupTarget[]
  onCancel: () => void
  onConfirm: (selected: CleanupTarget[]) => void
}

function keyOf(target: CleanupTarget): string {
  return `${target.repo}\n${target.kind}\n${target.branch}`
}

const kindLabel: Record<CleanupTarget['kind'], string> = {
  workspace: 'workspace',
  stale: 'stale record',
  orphan: 'not registered'
}

/**
 * The headline is derived rather than fixed: a stale record is offered on bookkeeping grounds alone,
 * so claiming every row has landed on its default branch would be false for one of the three kinds.
 */
function headline(targets: CleanupTarget[]): { title: string; detail: string } {
  const count = `${targets.length} workspace${targets.length === 1 ? '' : 's'}`
  const landed = targets.filter((target) => target.kind !== 'stale').length
  if (landed === 0)
    return {
      title: `Clean up ${count}?`,
      detail:
        'These records point at worktrees git no longer links. Branches and parked stashes are never touched.'
    }
  if (landed === targets.length)
    return {
      title: `Clean up ${count} already merged?`,
      detail:
        'Everything listed is already contained in its default branch. Branches and parked stashes are never touched.'
    }
  return {
    title: `Clean up ${count}?`,
    detail: `${landed} of these are already contained in their default branch; the rest are records pointing at worktrees git no longer links. Branches and parked stashes are never touched.`
  }
}

function CleanupDialog({ targets, onCancel, onConfirm }: CleanupDialogProps): React.JSX.Element {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(targets.filter((target) => target.suggested).map(keyOf))
  )

  const groups = useMemo(() => {
    const byRepo = new Map<string, { name: string; rows: CleanupTarget[] }>()
    for (const target of targets) {
      const group = byRepo.get(target.repo) ?? { name: target.repoName, rows: [] }
      group.rows.push(target)
      byRepo.set(target.repo, group)
    }
    return [...byRepo]
  }, [targets])

  const toggle = (key: string): void =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const selected = targets.filter((target) => checked.has(keyOf(target)))
  const { title, detail } = headline(targets)

  return (
    <GitDialog
      title={title}
      detail={detail}
      onDismiss={onCancel}
      body={
        <div className="wfm-cleanup-list">
          {groups.map(([repo, group]) => (
            <div key={repo} className="wfm-cleanup-group">
              <div className="wfm-cleanup-repo">{group.name}</div>
              {group.rows.map((target) => {
                const key = keyOf(target)
                return (
                  <label key={key} className="wfm-cleanup-row" title={cleanupScope(target.kind)}>
                    <input
                      type="checkbox"
                      checked={checked.has(key)}
                      onChange={() => toggle(key)}
                    />
                    <span className="wfm-cleanup-branch">{target.branch}</span>
                    <span className="wfm-cleanup-why">
                      {[kindLabel[target.kind], ...target.reasons].join(' · ')}
                    </span>
                    {target.directory && (
                      <span className="wfm-cleanup-path" title={target.directory}>
                        {target.directory}
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
          ))}
        </div>
      }
    >
      <button className="git-dialog-button" onClick={onCancel}>
        Cancel
      </button>
      <button
        className="git-dialog-button"
        disabled={selected.length === 0}
        onClick={() => onConfirm(selected)}
      >
        Clean up {selected.length}
      </button>
    </GitDialog>
  )
}

export default CleanupDialog
