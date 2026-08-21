import GitDialog from './GitDialog'

interface DiscardDialogProps {
  path: string
  onCancel: () => void
  onConfirm: () => void
}

function DiscardDialog({ path, onCancel, onConfirm }: DiscardDialogProps): React.JSX.Element {
  return (
    <GitDialog
      title="Discard changes?"
      detail={[
        path,
        '',
        'Goes back to the last commit, staged or not. A file that is not in',
        'that commit is deleted. This cannot be undone.'
      ].join('\n')}
      onDismiss={onCancel}
    >
      <button className="git-dialog-button" onClick={onCancel}>
        Keep
      </button>
      <button className="git-dialog-button" onClick={onConfirm}>
        Discard
      </button>
    </GitDialog>
  )
}

export default DiscardDialog
