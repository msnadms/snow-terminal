import { useEffect, useRef } from 'react'

interface GitDialogProps {
  title: React.ReactNode
  detail?: string
  dismissOnEnter?: boolean
  onDismiss: () => void
  children: React.ReactNode
}

function GitDialog({
  title,
  detail,
  dismissOnEnter = false,
  onDismiss,
  children
}: GitDialogProps): React.JSX.Element {
  const actionsRef = useRef<HTMLDivElement>(null)
  const latest = useRef(onDismiss)

  useEffect(() => {
    latest.current = onDismiss
  })

  useEffect(() => {
    actionsRef.current?.querySelector('button')?.focus()

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || (dismissOnEnter && e.key === 'Enter')) latest.current()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dismissOnEnter])

  return (
    <div className="git-dialog-backdrop" onPointerDown={onDismiss}>
      <div className="git-dialog" onPointerDown={(e) => e.stopPropagation()}>
        <div className="git-dialog-title">{title}</div>
        {detail && <pre className="git-dialog-detail">{detail}</pre>}
        <div ref={actionsRef} className="git-dialog-actions">
          {children}
        </div>
      </div>
    </div>
  )
}

export default GitDialog
