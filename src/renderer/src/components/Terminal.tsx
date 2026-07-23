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
}

function Terminal({ cwd, onCwd, startupCommand }: TerminalProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const onCwdRef = useRef(onCwd)

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
      try {
        fitAddon.fit()
        window.api.terminal.resize(id, term.cols, term.rows)
      } catch {
        // fit() can throw on a detached element
      }
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(container)

    term.focus()

    return () => {
      resizeObserver.disconnect()
      oscDisposable.dispose()
      offData()
      offExit()
      inputDisposable.dispose()
      window.api.terminal.kill(id)
      term.dispose()
    }
  }, [cwd, startupCommand])

  return <div className="terminal-pane" ref={containerRef} />
}

export default Terminal
