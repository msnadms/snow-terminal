import { useEffect, useRef } from 'react'
import type { Failure } from '@renderer/format'

interface FailureDialogProps {
  failure: Failure
  onDismiss: () => void
}

function FailureDialog({ failure, onDismiss }: FailureDialogProps): React.JSX.Element {
  const dismissRef = useRef<HTMLButtonElement>(null)
  const latest = useRef(onDismiss)

  useEffect(() => {
    latest.current = onDismiss
  })

  useEffect(() => {
    dismissRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') latest.current()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="git-dialog-backdrop" onPointerDown={onDismiss}>
      <div className="git-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="git-dialog-title">{failure.title}</div>
        {failure.detail && <pre className="git-dialog-detail">{failure.detail}</pre>}
        <div className="git-dialog-actions">
          <button ref={dismissRef} className="git-dialog-button" onClick={onDismiss}>
            OK
          </button>
        </div>
      </div>
    </div>
  )
}

export default FailureDialog
