import { memo, useEffect, useMemo, useRef } from 'react'
import { useTheme } from '../themeStore'

const FLAKE_COUNT = 540
const TRAVEL_VH = 115

const COL_STEP = 4
const CAP_FRACTION = 0.35
const FILL_SECONDS = 180
const DEPOSIT_AMOUNT = 1.5
const PILE_SPACING = 220

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

function resample(from: Float32Array, count: number): Float32Array {
  const next = new Float32Array(count)
  if (from.length === 0) return next
  for (let i = 0; i < count; i++) {
    const t = (i / Math.max(1, count - 1)) * (from.length - 1)
    const lo = Math.floor(t)
    const hi = Math.min(from.length - 1, lo + 1)
    next[i] = from[lo] + (from[hi] - from[lo]) * (t - lo)
  }
  return next
}

function smooth(h: Float32Array): void {
  let prev = h[0]
  for (let i = 0; i < h.length; i++) {
    const cur = h[i]
    const next = i + 1 < h.length ? h[i + 1] : cur
    h[i] = cur * 0.74 + (prev + next) * 0.13
    prev = cur
  }
}

function gaussian(): number {
  return Math.random() + Math.random() + Math.random() - 1.5
}

function SnowFall({ active }: { active: boolean }): React.JSX.Element {
  const flakes = useMemo(() => makeFlakes(), [])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const theme = useTheme()
  const colorRef = useRef('#cdd6f4')
  const redrawRef = useRef(0)
  const kickRef = useRef<() => void>(() => {})
  const activeRef = useRef(active)

  useEffect(() => {
    colorRef.current = theme?.ui.snow ?? '#cdd6f4'
    redrawRef.current += 1
    kickRef.current()
  }, [theme])

  useEffect(() => {
    activeRef.current = active
    if (active) kickRef.current()
  }, [active])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let width = 0
    let height = 0
    let cap = 0
    let heights: Float32Array = new Float32Array(0)
    let centers: number[] = []
    let centersFrac: number[] | null = null
    let spread = 1
    let full = false
    let dirty = true

    const fit = (): void => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w === 0 || h === 0) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const prevHeight = height
      width = w
      height = h
      cap = h * CAP_FRACTION
      const cols = Math.max(2, Math.ceil(w / COL_STEP) + 1)
      heights = resample(heights, cols)
      const vScale = prevHeight > 0 ? h / prevHeight : 1
      full = true
      for (let i = 0; i < heights.length; i++) {
        heights[i] = Math.min(cap, heights[i] * vScale)
        if (heights[i] < cap) full = false
      }
      if (!centersFrac) {
        const pileCount = Math.max(2, Math.round(w / PILE_SPACING))
        centersFrac = Array.from(
          { length: pileCount },
          (_, i) => (i + 0.5 + (Math.random() - 0.5) * 0.6) / pileCount
        )
      }
      centers = centersFrac.map((f) => Math.min(cols - 1, Math.max(0, Math.round(f * (cols - 1)))))
      spread = (cols / centersFrac.length) * 0.4
      dirty = true
      kick()
    }

    let raf = 0
    let last = performance.now()
    let seenRedraw = redrawRef.current

    const frame = (now: number): void => {
      if (!activeRef.current) {
        raf = 0
        return
      }
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now

      if (redrawRef.current !== seenRedraw) {
        seenRedraw = redrawRef.current
        dirty = true
      }

      if (heights.length > 1 && cap > 0) {
        if (!full) {
          const perSecond = (cap * heights.length) / (FILL_SECONDS * DEPOSIT_AMOUNT)
          let deposits = perSecond * dt
          while (deposits > 0) {
            if (deposits < 1 && Math.random() > deposits) break
            const center = centers[Math.floor(Math.random() * centers.length)]
            const c = Math.round(center + gaussian() * spread)
            if (c >= 0 && c < heights.length) {
              const next = Math.min(cap, heights[c] + DEPOSIT_AMOUNT)
              heights[c] = next
              if (next >= cap) full = true
            }
            deposits -= 1
          }
          smooth(heights)
          dirty = true
        }

        if (dirty) {
          dirty = false

          ctx.clearRect(0, 0, width, height)
          ctx.beginPath()
          ctx.moveTo(0, height)
          for (let i = 0; i < heights.length; i++) {
            const x = (i / (heights.length - 1)) * width
            ctx.lineTo(x, height - heights[i])
          }
          ctx.lineTo(width, height)
          ctx.closePath()
          ctx.fillStyle = colorRef.current
          ctx.fill()
        }
      }

      if (full && !dirty) {
        raf = 0
        return
      }
      raf = requestAnimationFrame(frame)
    }

    const kick = (): void => {
      if (raf !== 0) return
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }

    kickRef.current = kick
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(canvas)
    kick()

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      kickRef.current = () => {}
    }
  }, [])

  return (
    <div className="home-snow" aria-hidden="true">
      <canvas ref={canvasRef} className="home-snow-pile" />
      {flakes.map((style, i) => (
        <span key={i} className="home-snow-flake" style={style} />
      ))}
    </div>
  )
}

export default memo(SnowFall)
