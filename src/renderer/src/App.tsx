import { useMemo, useRef, useState } from 'react'
import ActionBar from './components/ActionBar'
import GitPanel from './components/GitPanel'
import Session from './components/Session'
import TabBar from './components/TabBar'
import HomePage from './components/HomePage'
import { useSnowconfig } from './useSnowconfig'

type ActiveId = number | 'home'

interface SessionMeta {
  id: number
  cwd?: string
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function App(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeId, setActiveId] = useState<ActiveId>('home')
  const [cwds, setCwds] = useState<Record<number, string | undefined>>({})
  const nextIdRef = useRef(1)
  const presets = useSnowconfig()

  const cwd = typeof activeId === 'number' ? cwds[activeId] : undefined

  const labels = useMemo(() => {
    const result: Record<number, string> = {}
    for (const { id } of sessions) {
      const dir = cwds[id]
      if (dir) result[id] = basename(dir)
    }
    return result
  }, [sessions, cwds])

  const addSession = (cwd?: string): void => {
    const id = nextIdRef.current++
    setSessions((prev) => [...prev, { id, cwd }])
    if (cwd) setCwds((prev) => ({ ...prev, [id]: cwd }))
    setActiveId(id)
  }

  const closeSession = (id: number): void => {
    const index = sessions.findIndex((s) => s.id === id)
    if (index === -1) return
    const remaining = sessions.filter((s) => s.id !== id)
    if (activeId === id) {
      const neighbor = remaining[index - 1] ?? remaining[index]
      setActiveId(neighbor ? neighbor.id : 'home')
    }
    setSessions(remaining)
    setCwds((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  return (
    <div className="app">
      <ActionBar cwd={cwd} />
      <div className="content">
        <div className="terminal-area">
          <TabBar
            sessions={sessions}
            activeId={activeId}
            labels={labels}
            onSelect={setActiveId}
            onClose={closeSession}
            onAdd={() => addSession(presets.find((p) => p.default)?.cwd)}
          />
          <div className="terminal-stack">
            {activeId === 'home' && (
              <HomePage presets={presets} onOpenPreset={(dir) => addSession(dir)} />
            )}
            {sessions.map(({ id, cwd }) => (
              <Session
                key={id}
                active={activeId === id}
                cwd={cwd}
                onCwd={(next) => setCwds((prev) => ({ ...prev, [id]: next }))}
              />
            ))}
          </div>
        </div>
        <GitPanel cwd={cwd} />
      </div>
    </div>
  )
}

export default App
