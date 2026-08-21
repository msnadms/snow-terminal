import GitDialog from './GitDialog'

interface BlockedCommitDialogProps {
  paths: string[]
  onCancel: () => void
  onUnstage: () => void
  onInclude: () => void
}

function BlockedCommitDialog({
  paths,
  onCancel,
  onUnstage,
  onInclude
}: BlockedCommitDialogProps): React.JSX.Element {
  const subject = paths.length === 1 ? 'A staged file is' : `${paths.length} staged files are`

  return (
    <GitDialog
      title={`${subject} skipped by .snowignore`}
      detail={[
        ...paths,
        '',
        'Unstage and commit leaves these in the worktree exactly as they are now',
        'and commits the rest of the index.',
        '',
        'Commit anyway commits them too, .snowignore and all.'
      ].join('\n')}
      onDismiss={onCancel}
    >
      <button className="git-dialog-button" onClick={onCancel}>
        Cancel
      </button>
      <button className="git-dialog-button" onClick={onUnstage}>
        Unstage and commit
      </button>
      <button className="git-dialog-button" onClick={onInclude}>
        Commit anyway
      </button>
    </GitDialog>
  )
}

export default BlockedCommitDialog
