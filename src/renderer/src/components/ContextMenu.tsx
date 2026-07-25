import { useEffect, useLayoutEffect, useRef } from 'react'

interface ContextMenuProps {
  x: number
  y: number
  onClose: () => void
  children: React.ReactNode
}

function ContextMenu({ x, y, onClose, children }: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    el.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width))}px`
    el.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height))}px`
  }, [x, y])

  return (
    <div className="context-menu" ref={ref}>
      {children}
    </div>
  )
}

export default ContextMenu
