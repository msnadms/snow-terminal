import GitDialog from './GitDialog'
import { parkedStay, usable, type WorkflowEntry } from '@renderer/workflowText'

interface RemoveWorkflowDialogProps {
  entry: WorkflowEntry
  onCancel: () => void
  onConfirm: () => void
}

/**
 * A live parallel session is the one case `workflow:unregister` refuses, so say so here instead of
 * promising a removal and answering with a failure dialog.
 */
function RemoveWorkflowDialog({
  entry,
  onCancel,
  onConfirm
}: RemoveWorkflowDialogProps): React.JSX.Element {
  if (usable(entry))
    return (
      <GitDialog
        title={`${entry.branch} is running in parallel`}
        detail={[
          `${entry.branch} has its own worktree, so snow keeps tracking it while that session is live.`,
          '',
          `Stop the parallel session first - the pause button on this row - and then remove it.`
        ].join('\n')}
        onDismiss={onCancel}
      >
        <button className="git-dialog-button" onClick={onCancel}>
          Close
        </button>
      </GitDialog>
    )

  return (
    <GitDialog
      title={`Remove workflow ${entry.branch}?`}
      detail={[
        `The branch ${entry.branch} is not deleted - snow just stops tracking it as a workflow.`,
        entry.parked
          ? `\n${parkedStay(entry.parked.files)} Recover them with:\n  git stash list\n  git stash pop <entry>`
          : ''
      ].join('')}
      onDismiss={onCancel}
    >
      <button className="git-dialog-button" onClick={onCancel}>
        Cancel
      </button>
      <button className="git-dialog-button" onClick={onConfirm}>
        Remove
      </button>
    </GitDialog>
  )
}

export default RemoveWorkflowDialog
