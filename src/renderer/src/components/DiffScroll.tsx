import { useRef, useState } from 'react'

interface DiffScrollProps {
  active: boolean
  children: React.ReactNode
}

function DiffScroll({ active, children }: DiffScrollProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [scrolled, setScrolled] = useState(false)

  return (
    <div
      ref={hostRef}
      className="commit-view"
      style={{ display: active ? 'block' : 'none' }}
      onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 160)}
    >
      {scrolled && (
        <div className="commit-totop">
          <button
            className="commit-totop-button"
            title="Back to top"
            onClick={() => hostRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
          >
            ↑ Top
          </button>
        </div>
      )}
      {children}
    </div>
  )
}

export default DiffScroll
