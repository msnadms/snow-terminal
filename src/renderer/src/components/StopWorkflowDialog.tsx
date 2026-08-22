import GitDialog from './GitDialog'
import { type WorkflowEntry } from '@renderer/workflowText'

interface StopWorkflowDialogProps {
  entry: WorkflowEntry
  onCancel: () => void
  onConfirm: () => void
}

function StopWorkflowDialog({
  entry,
  onCancel,
  onConfirm
}: StopWorkflowDialogProps): React.JSX.Element {
  return (
    <GitDialog
      title={`Stop ${entry.branch}'s parallel session?`}
      detail={[
        `Changes will be parked on ${entry.branch} before its worktree is removed.`,
        '',
        'Its terminal session will close. Ignored files (for example node_modules, .env, dist, and out) cannot be stashed and will be deleted from that worktree.'
      ].join('\n')}
      onDismiss={onCancel}
    >
      <button className="git-dialog-button" onClick={onCancel}>
        Cancel
      </button>
      <button className="git-dialog-button" onClick={onConfirm}>
        Stop session and delete ignored files
      </button>
    </GitDialog>
  )
}

export default StopWorkflowDialog
