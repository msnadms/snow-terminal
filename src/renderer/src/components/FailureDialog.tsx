import GitDialog from './GitDialog'
import type { Failure } from '@renderer/format'

interface FailureDialogProps {
  failure: Failure
  onDismiss: () => void
}

function FailureDialog({ failure, onDismiss }: FailureDialogProps): React.JSX.Element {
  return (
    <GitDialog title={failure.title} detail={failure.detail} dismissOnEnter onDismiss={onDismiss}>
      <button className="git-dialog-button" onClick={onDismiss}>
        OK
      </button>
    </GitDialog>
  )
}

export default FailureDialog
