import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

let nextTerminalId = 1

function parseOsc7(payload: string): string | null {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(payload)
  if (!match) return null
  let path = decodeURIComponent(match[1])
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
  return path
}

interface TerminalProps {
  cwd?: string
  onCwd?: (cwd: string) => void
  startupCommand?: string
  active?: boolean
  focusOnActivate?: boolean
}

function Terminal({
  cwd,
  onCwd,
  startupCommand,
  active = true,
  focusOnActivate
}: TerminalProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const onCwdRef = useRef(onCwd)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const termRef = useRef<XTerm | null>(null)
  const idRef = useRef<number | null>(null)

  useEffect(() => {
    onCwdRef.current = onCwd
  }, [onCwd])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const id = nextTerminalId++

    const term = new XTerm({
      cursorBlink: true,
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
    term.open(container)
    fitAddon.fit()

    fitAddonRef.current = fitAddon
    termRef.current = term
    idRef.current = id

    window.api.terminal.spawn(id, term.cols, term.rows, cwd, startupCommand)

    const oscDisposable = term.parser.registerOscHandler(7, (payload) => {
      const next = parseOsc7(payload)
      if (next) onCwdRef.current?.(next)
      return true
    })

    const offData = window.api.terminal.onData((incomingId, data) => {
      if (incomingId === id) term.write(data)
    })

    const offExit = window.api.terminal.onExit((incomingId) => {
      if (incomingId === id) {
        term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
      }
    })

    const inputDisposable = term.onData((data) => {
      window.api.terminal.write(id, data)
    })

    const resize = (): void => {
      if (!container.clientWidth || !container.clientHeight) return
      try {
        fitAddon.fit()
        window.api.terminal.resize(id, term.cols, term.rows)
      } catch {
        // fit() can throw on a detached element
      }
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      oscDisposable.dispose()
      offData()
      offExit()
      inputDisposable.dispose()
      window.api.terminal.kill(id)
      term.dispose()
      fitAddonRef.current = null
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
        if (focusOnActivate) term.focus()
      } catch {
        // pane detached
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [active, focusOnActivate])

  return <div className="terminal-pane" ref={containerRef} />
}

export default Terminal
