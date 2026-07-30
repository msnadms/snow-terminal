import { useEffect, useRef } from 'react'

interface ResizeHandleProps {
  axis: 'x' | 'y'
  className?: string
  onStart?: () => void
  onResize: (delta: number) => void
  onEnd?: () => void
}

function ResizeHandle({
  axis,
  className,
  onStart,
  onResize,
  onEnd
}: ResizeHandleProps): React.JSX.Element {
  const cbs = useRef({ onStart, onResize, onEnd })
  useEffect(() => {
    cbs.current = { onStart, onResize, onEnd }
  })

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const prop = axis === 'x' ? 'clientX' : 'clientY'
    const origin = e[prop]
    cbs.current.onStart?.()
    let frame = 0
    let delta = 0
    const flush = (): void => {
      frame = 0
      cbs.current.onResize(delta)
    }
    const move = (ev: PointerEvent): void => {
      delta = ev[prop] - origin
      if (!frame) frame = requestAnimationFrame(flush)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (frame) {
        cancelAnimationFrame(frame)
        flush()
      }
      document.body.classList.remove('resizing', `resizing-${axis}`)
      cbs.current.onEnd?.()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.classList.add('resizing', `resizing-${axis}`)
  }

  return (
    <div
      className={`resize-handle resize-handle-${axis}${className ? ` ${className}` : ''}`}
      onPointerDown={onPointerDown}
    />
  )
}

export default ResizeHandle
