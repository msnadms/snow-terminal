import { useEffect, useRef, useState } from 'react'
import { useFind } from '@renderer/useFind'
import type { Find } from '@renderer/useFind'

interface DiffScrollProps {
  active: boolean
  onClose?: () => void
  children: React.ReactNode
}

function FindBar({
  query,
  count,
  index,
  capped,
  inputRef,
  setQuery,
  step,
  close
}: Find): React.JSX.Element {
  const status = query
    ? count === 0
      ? 'no results'
      : `${index + 1}/${count}${capped ? '+' : ''}`
    : ''

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        className="find-input"
        placeholder="Find"
        spellCheck={false}
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          step(event.shiftKey ? -1 : 1)
        }}
      />
      <span className="find-count">{status}</span>
      <button className="find-button" title="Previous match" onClick={() => step(-1)}>
        ↑
      </button>
      <button className="find-button" title="Next match" onClick={() => step(1)}>
        ↓
      </button>
      <button className="find-button" title="Close" onClick={close}>
        ✕
      </button>
    </div>
  )
}

function DiffScroll({ active, onClose, children }: DiffScrollProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const toolsRef = useRef<HTMLDivElement | null>(null)
  const [scrolled, setScrolled] = useState(false)
  const find = useFind(hostRef, active)

  useEffect(() => {
    const host = hostRef.current
    const tools = toolsRef.current
    if (!host || !tools) return

    const padding = parseFloat(getComputedStyle(host).paddingRight)
    const observer = new ResizeObserver(() => {
      const edge = host.getBoundingClientRect().right - padding
      const inset = Math.max(0, Math.ceil(edge - tools.getBoundingClientRect().left))
      host.style.setProperty('--diff-tools-inset', `${inset}px`)
    })
    observer.observe(tools)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={hostRef}
      className="commit-view"
      style={{ display: active ? 'block' : 'none' }}
      onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 160)}
    >
      <div className="commit-tools">
        <div ref={toolsRef} className="commit-tools-row">
          {onClose && (
            <button
              className="terminal-close commit-close-button"
              title="Close diff"
              onClick={onClose}
            >
              
            </button>
          )}
          {find.open && <FindBar {...find} />}
          {scrolled && (
            <button
              className="commit-totop-button"
              title="Back to top"
              onClick={() => hostRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            >
              ↑ Top
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  )
}

export default DiffScroll
