import { memo, useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { nextTerminalId } from '../terminalId'
import { subscribeTheme, getTheme } from '../themeStore'
import type { Theme } from '../themeStore'

const searchOptions = {
  decorations: {
    matchBackground: '#585b70',
    matchBorder: '#585b70',
    matchOverviewRuler: '#f9e2af',
    activeMatchBackground: '#f9e2af',
    activeMatchBorder: '#f9e2af',
    activeMatchColorOverviewRuler: '#f38ba8'
  }
}

function xtermTheme(ui: Theme['ui']): { background: string; foreground: string } {
  return { background: ui.terminalBackground, foreground: ui.text }
}

function parseOsc7(payload: string): string | null {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(payload)
  if (!match) return null
  let path = decodeURIComponent(match[1])
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
  return path
}

const IDLE_MS = 1000
const BUSY_MS = 1000
const QUIET_MS = 2500

interface TerminalProps {
  cwd?: string
  onCwd?: (cwd: string) => void
  onStatus?: (status: 'busy' | 'idle') => void
  onTitle?: (title: string) => void
  startupCommand?: string
  active?: boolean
  focusOnActivate?: boolean
}

function Terminal({
  cwd,
  onCwd,
  onStatus,
  onTitle,
  startupCommand,
  active = true,
  focusOnActivate
}: TerminalProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const onCwdRef = useRef(onCwd)
  const onStatusRef = useRef(onStatus)
  const onTitleRef = useRef(onTitle)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const idRef = useRef<number | null>(null)
  const quietUntilRef = useRef(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState({ index: 0, count: 0 })

  useEffect(() => {
    onCwdRef.current = onCwd
  }, [onCwd])

  useEffect(() => {
    onStatusRef.current = onStatus
  }, [onStatus])

  useEffect(() => {
    onTitleRef.current = onTitle
  }, [onTitle])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const id = nextTerminalId()

    const term = new XTerm({
      cursorBlink: true,
      allowProposedApi: true,
      fontFamily:
        '"Hack Nerd Font Mono", "Hack Nerd Font", Menlo, Consolas, "Cascadia Code", monospace',
      fontSize: 13,
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc'
      }
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    term.open(container)
    fitAddon.fit()

    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon
    termRef.current = term
    idRef.current = id

    const searchResults = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultCount ? resultIndex + 1 : 0, count: resultCount })
    )

    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && (event.ctrlKey || event.metaKey) && event.key === 'f') {
        setSearchOpen(true)
        requestAnimationFrame(() => searchInputRef.current?.select())
        return false
      }
      return true
    })

    window.api.terminal.spawn(id, term.cols, term.rows, cwd, startupCommand)

    const oscDisposable = term.parser.registerOscHandler(7, (payload) => {
      const next = parseOsc7(payload)
      if (next) onCwdRef.current?.(next)
      return true
    })

    const titleDisposable = term.onTitleChange((title) => onTitleRef.current?.(title))

    const bumpQuiet = (): void => {
      quietUntilRef.current = Date.now() + QUIET_MS
    }
    term.element?.addEventListener('wheel', bumpQuiet, { passive: true })
    term.textarea?.addEventListener('focus', bumpQuiet)
    term.textarea?.addEventListener('blur', bumpQuiet)

    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let busy = false
    let burstStart = 0
    const settle = (): void => {
      idleTimer = null
      if (busy) {
        busy = false
        onStatusRef.current?.('idle')
      }
    }
    const offData = window.api.terminal.onData(id, (data) => {
      term.write(data)
      if (!onStatusRef.current) return
      if (!idleTimer && Date.now() < quietUntilRef.current) return
      if (!idleTimer) burstStart = Date.now()
      else clearTimeout(idleTimer)
      if (!busy && Date.now() - burstStart >= BUSY_MS) {
        busy = true
        onStatusRef.current('busy')
      }
      idleTimer = setTimeout(settle, IDLE_MS)
    })

    const offExit = window.api.terminal.onExit(id, () => {
      term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
    })

    const inputDisposable = term.onData((data) => {
      window.api.terminal.write(id, data)
    })

    const resize = (): void => {
      if (!container.clientWidth || !container.clientHeight) return
      try {
        fitAddon.fit()
        window.api.terminal.resize(id, term.cols, term.rows)
        bumpQuiet()
      } catch {
        // fit() can throw on a detached element
      }
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)

    const applyTheme = (): void => {
      const theme = getTheme()
      if (theme) term.options.theme = { ...term.options.theme, ...xtermTheme(theme.ui) }
    }
    applyTheme()
    const offTheme = subscribeTheme(applyTheme)

    return () => {
      offTheme()
      resizeObserver.disconnect()
      oscDisposable.dispose()
      titleDisposable.dispose()
      searchResults.dispose()
      term.element?.removeEventListener('wheel', bumpQuiet)
      term.textarea?.removeEventListener('focus', bumpQuiet)
      term.textarea?.removeEventListener('blur', bumpQuiet)
      if (idleTimer) clearTimeout(idleTimer)
      offData()
      offExit()
      inputDisposable.dispose()
      window.api.terminal.kill(id)
      term.dispose()
      fitAddonRef.current = null
      searchAddonRef.current = null
      termRef.current = null
      idRef.current = null
    }
  }, [cwd, startupCommand])

  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      const fit = fitAddonRef.current
      const term = termRef.current
      const id = idRef.current
      const container = containerRef.current
      if (!fit || !term || id == null || !container) return
      if (!container.clientWidth || !container.clientHeight) return
      try {
        fit.fit()
        window.api.terminal.resize(id, term.cols, term.rows)
        quietUntilRef.current = Date.now() + QUIET_MS
        if (focusOnActivate) term.focus()
      } catch {
        // pane detached
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [active, focusOnActivate])

  const runSearch = (value: string, direction: 'next' | 'prev'): void => {
    const search = searchAddonRef.current
    if (!search) return
    if (!value) {
      search.clearDecorations()
      setResults({ index: 0, count: 0 })
      return
    }
    if (direction === 'prev') search.findPrevious(value, searchOptions)
    else search.findNext(value, searchOptions)
  }

  const closeSearch = (): void => {
    setSearchOpen(false)
    searchAddonRef.current?.clearDecorations()
    setResults({ index: 0, count: 0 })
    termRef.current?.focus()
  }

  return (
    <div className="terminal-wrap">
      <div className="terminal-pane" ref={containerRef} />
      {searchOpen && (
        <div className="terminal-search">
          <input
            ref={searchInputRef}
            className="terminal-search-input"
            autoFocus
            value={query}
            placeholder="Find"
            onChange={(e) => {
              setQuery(e.target.value)
              runSearch(e.target.value, 'next')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch()
              else if (e.key === 'Enter') runSearch(query, e.shiftKey ? 'prev' : 'next')
            }}
          />
          <span className="terminal-search-count">
            {results.count ? `${results.index}/${results.count}` : query ? '0/0' : ''}
          </span>
          <button
            className="terminal-search-nav"
            onClick={() => runSearch(query, 'prev')}
            title="Previous match"
          >
            ↑
          </button>
          <button
            className="terminal-search-nav"
            onClick={() => runSearch(query, 'next')}
            title="Next match"
          >
            ↓
          </button>
          <button className="terminal-search-nav" onClick={closeSearch} title="Close">
            ✕
          </button>
        </div>
      )}
    </div>
  )
}

export default memo(Terminal)
