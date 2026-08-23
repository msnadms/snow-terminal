import GitDialog from './GitDialog'
import { type WorkflowEntry } from '@renderer/workflowText'
import { type AgentSession } from '@renderer/useAgents'

interface StopWorkflowDialogProps {
  entry: WorkflowEntry
  agents: AgentSession[]
  onCancel: () => void
  onConfirm: () => void
}

function StopWorkflowDialog({
  entry,
  agents,
  onCancel,
  onConfirm
}: StopWorkflowDialogProps): React.JSX.Element {
  return (
    <GitDialog
      title={`Remove ${entry.branch}'s workspace?`}
      detail={[
        `Changes will be parked on ${entry.branch} before its worktree is removed.`,
        '',
        agents.length
          ? `${agents.length} reported agent${agents.length === 1 ? '' : 's'} ${agents.length === 1 ? 'is' : 'are'} associated with this workspace. snow cannot stop their dispatcher, but removing the workspace may terminate its terminals.`
          : 'Its terminal session may need to close before the worktree can be removed.',
        '',
        'Ignored files (for example node_modules, .env, dist, and out) cannot be stashed and will be deleted from that worktree.'
      ].join('\n')}
      onDismiss={onCancel}
    >
      <button className="git-dialog-button" onClick={onCancel}>
        Cancel
      </button>
      <button className="git-dialog-button" onClick={onConfirm}>
        Remove workspace and terminate terminals if needed
      </button>
    </GitDialog>
  )
}

export default StopWorkflowDialog
