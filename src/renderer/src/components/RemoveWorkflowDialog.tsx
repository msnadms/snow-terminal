import GitDialog from './GitDialog'
import { parkedStay, type WorkflowEntry } from '@renderer/workflowText'

interface RemoveWorkflowDialogProps {
  entry: WorkflowEntry
  onCancel: () => void
  onConfirm: () => void
}

function RemoveWorkflowDialog({
  entry,
  onCancel,
  onConfirm
}: RemoveWorkflowDialogProps): React.JSX.Element {
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
