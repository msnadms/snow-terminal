import { useCallback, useEffect, useState } from 'react'
import type { CommandItem } from './appModel'
import { nextTerminalId } from './terminalId'

function without(prev: Record<string, number>, key: string): Record<string, number> {
  const next = { ...prev }
  delete next[key]
  return next
}

export function useRunningCommands(): {
  running: Record<string, number>
  toggleCommand: (item: CommandItem) => void
} {
  const [running, setRunning] = useState<Record<string, number>>({})

  const toggleCommand = useCallback(
    (item: CommandItem): void => {
      const existing = running[item.runKey]
      if (existing != null) {
        window.api.terminal.kill(existing)
        setRunning((prev) => without(prev, item.runKey))
        return
      }
      const id = nextTerminalId()
      window.api.terminal.spawn(id, 80, 24, item.cwd, `${item.command}; exit`)
      setRunning((prev) => ({ ...prev, [item.runKey]: id }))
    },
    [running]
  )

  useEffect(() => {
    return window.api.terminal.onExit(null, (id) => {
      setRunning((prev) => {
        const command = Object.keys(prev).find((key) => prev[key] === id)
        return command === undefined ? prev : without(prev, command)
      })
    })
  }, [])

  return { running, toggleCommand }
}
