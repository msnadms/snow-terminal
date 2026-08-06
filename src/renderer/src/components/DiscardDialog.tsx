import { useEffect, useRef } from 'react'

interface DiscardDialogProps {
  path: string
  onCancel: () => void
  onConfirm: () => void
}

function DiscardDialog({ path, onCancel, onConfirm }: DiscardDialogProps): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const latest = useRef(onCancel)

  useEffect(() => {
    latest.current = onCancel
  })

  useEffect(() => {
    cancelRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') latest.current()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="git-dialog-backdrop" onPointerDown={onCancel}>
      <div className="git-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="git-dialog-title">Discard changes?</div>
        <pre className="git-dialog-detail">
          {[
            path,
            '',
            'Goes back to the last commit, staged or not. A file that is not in',
            'that commit is deleted. This cannot be undone.'
          ].join('\n')}
        </pre>
        <div className="git-dialog-actions">
          <button ref={cancelRef} className="git-dialog-button" onClick={onCancel}>
            Keep
          </button>
          <button className="git-dialog-button" onClick={onConfirm}>
            Discard
          </button>
        </div>
      </div>
    </div>
  )
}

export default DiscardDialog
