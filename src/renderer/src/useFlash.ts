import { useEffect, useRef, useState } from 'react'

export type Flash = 'ok' | 'error'

export function flashClass(flash: Flash | null): string {
  return flash ? ` flash-${flash}` : ''
}

export function useFlash(duration = 1400): [Flash | null, (next: Flash) => void] {
  const [flash, setFlash] = useState<Flash | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const trigger = (next: Flash): void => {
    clearTimeout(timer.current)
    setFlash(next)
    timer.current = setTimeout(() => setFlash(null), duration)
  }

  return [flash, trigger]
}
