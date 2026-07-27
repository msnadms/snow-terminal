import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

interface BrowserTabProps {
  id: number
  initialUrl: string
  active: boolean
  onTitle: (title: string) => void
}

function normalizeUrl(input: string): string {
  const value = input.trim()
  if (!value) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  return `https://${value}`
}

function BrowserTab({ id, initialUrl, active, onTitle }: BrowserTabProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef(active)
  const editingRef = useRef(false)
  const onTitleRef = useRef(onTitle)
  const lastTitleRef = useRef<string | null>(null)
  const [address, setAddress] = useState(initialUrl === 'about:blank' ? '' : initialUrl)
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false, loading: false })

  useEffect(() => {
    onTitleRef.current = onTitle
  }, [onTitle])

  const pushBounds = useCallback((): void => {
    const viewport = viewportRef.current
    if (!viewport) return
    const rect = viewport.getBoundingClientRect()
    if (!rect.width || !rect.height) {
      window.api.browser.setBounds(id, { x: 0, y: 0, width: 0, height: 0 }, false)
      return
    }
    window.api.browser.setBounds(
      id,
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      activeRef.current
    )
  }, [id])

  useEffect(() => {
    window.api.browser.create(id, initialUrl)

    const off = window.api.browser.onState(id, (state) => {
      setNav({
        canGoBack: state.canGoBack,
        canGoForward: state.canGoForward,
        loading: state.loading
      })
      const title = state.title || state.url
      if (title !== lastTitleRef.current) {
        lastTitleRef.current = title
        onTitleRef.current(title)
      }
      if (!editingRef.current && state.url && state.url !== 'about:blank') setAddress(state.url)
    })

    const viewport = viewportRef.current
    const observer = new ResizeObserver(() => pushBounds())
    if (viewport) observer.observe(viewport)

    return () => {
      observer.disconnect()
      off()
      window.api.browser.destroy(id)
    }
  }, [id, initialUrl, pushBounds])

  useLayoutEffect(() => {
    activeRef.current = active
    if (!active) {
      window.api.browser.setBounds(id, { x: 0, y: 0, width: 0, height: 0 }, false)
      return
    }
    const raf = requestAnimationFrame(() => pushBounds())
    return () => cancelAnimationFrame(raf)
  }, [active, id, pushBounds])

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    window.api.browser.navigate(id, normalizeUrl(address))
    editingRef.current = false
    viewportRef.current?.focus()
  }

  return (
    <div className="browser-host" style={{ display: active ? 'flex' : 'none' }}>
      <div className="browser-chrome">
        <button
          className="browser-nav"
          onClick={() => window.api.browser.goBack(id)}
          disabled={!nav.canGoBack}
          title="Back"
        >
          {''}
        </button>
        <button
          className="browser-nav"
          onClick={() => window.api.browser.goForward(id)}
          disabled={!nav.canGoForward}
          title="Forward"
        >
          {''}
        </button>
        <button
          className="browser-nav"
          onClick={() =>
            nav.loading ? window.api.browser.stop(id) : window.api.browser.reload(id)
          }
          title={nav.loading ? 'Stop' : 'Reload'}
        >
          {nav.loading ? '' : ''}
        </button>
        <form className="browser-address-form" onSubmit={submit}>
          <input
            className="browser-address"
            value={address}
            placeholder="Enter address"
            onChange={(e) => setAddress(e.target.value)}
            onFocus={() => (editingRef.current = true)}
            onBlur={() => (editingRef.current = false)}
          />
        </form>
      </div>
      <div className="browser-viewport" ref={viewportRef} />
    </div>
  )
}

export default BrowserTab
