import { useMemo } from 'react'

const FLAKE_COUNT = 90
const TRAVEL_VH = 115

function makeFlakes(): React.CSSProperties[] {
  return Array.from({ length: FLAKE_COUNT }, () => {
    const u = Math.random()
    const size = 2 + Math.random() * 5
    const duration = 5 + Math.random() * 10
    return {
      '--flake-travel': `${TRAVEL_VH}vh`,
      left: `calc(${u * 100}% + ${(u - 1) * TRAVEL_VH}vh)`,
      top: '-8vh',
      width: `${size}px`,
      height: `${size}px`,
      opacity: 0.2 + Math.random() * 0.6,
      animationDuration: `${duration}s`,
      animationDelay: `-${Math.random() * duration}s`
    } as React.CSSProperties
  })
}

function SnowFall(): React.JSX.Element {
  const flakes = useMemo(() => makeFlakes(), [])

  return (
    <div className="home-snow" aria-hidden="true">
      {flakes.map((style, i) => (
        <span key={i} className="home-snow-flake" style={style} />
      ))}
    </div>
  )
}

export default SnowFall
