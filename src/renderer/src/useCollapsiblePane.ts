import { useRef, useState } from 'react'

export interface CollapsiblePaneOptions {
  min: number
  collapseAt: number
  defaultSize: number
  savedSize?: number
  savedCollapsed?: boolean
  maxSize: () => number
  persist: (size: number, collapsed: boolean) => void
}

export interface CollapsiblePane {
  size: number
  collapsed: boolean
  onStart: () => void
  onResize: (delta: number) => void
  onEnd: () => void
  restore: () => void
}

export function useCollapsiblePane(opts: CollapsiblePaneOptions): CollapsiblePane {
  const [sizeOverride, setSizeOverride] = useState<number | null>(null)
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null)
  const base = useRef(0)

  const size = sizeOverride ?? opts.savedSize ?? opts.defaultSize
  const collapsed = collapsedOverride ?? opts.savedCollapsed ?? false

  const live = useRef({ size, collapsed })

  const onStart = (): void => {
    base.current = size
    live.current = { size, collapsed }
  }
  const onResize = (delta: number): void => {
    const raw = base.current - delta
    if (raw < opts.collapseAt) {
      live.current = { size, collapsed: true }
      setCollapsedOverride(true)
      return
    }
    const next = Math.max(opts.min, Math.min(opts.maxSize(), raw))
    live.current = { size: next, collapsed: false }
    setSizeOverride(next)
    setCollapsedOverride(false)
  }
  const onEnd = (): void => opts.persist(live.current.size, live.current.collapsed)
  const restore = (): void => {
    setCollapsedOverride(false)
    opts.persist(size, false)
  }

  return { size, collapsed, onStart, onResize, onEnd, restore }
}
