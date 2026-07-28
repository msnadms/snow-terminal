import { useEffect, useState } from 'react'

type SnowconfigResult = Awaited<ReturnType<typeof window.api.snowconfig.get>>
export type Preset = SnowconfigResult['config']['presets'][number]

export function useSnowconfig(): {
  presets: Preset[]
  name: string | null
  startupCommand: string | null
  gradients: boolean
  theme: string | null
  tourSeen: boolean
  error: string | null
} {
  const [presets, setPresets] = useState<Preset[]>([])
  const [name, setName] = useState<string | null>(null)
  const [startupCommand, setStartupCommand] = useState<string | null>(null)
  const [gradients, setGradients] = useState(true)
  const [theme, setTheme] = useState<string | null>(null)
  const [tourSeen, setTourSeen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const receive = (result: SnowconfigResult): void => {
      if (cancelled) return
      if (result.error) console.error(`snow: failed to read ${result.path}: ${result.error}`)
      setError(result.error ? `${result.path}: ${result.error}` : null)
      setPresets(result.config.presets)
      setName(result.config.name ?? null)
      setStartupCommand(result.config.startupCommand ?? null)
      setGradients(result.config.gradients ?? true)
      setTheme(result.config.theme ?? null)
      setTourSeen(result.config.tourSeen ?? false)
    }

    window.api.snowconfig.get().then(receive)
    const offChanged = window.api.snowconfig.onChanged(receive)

    return () => {
      cancelled = true
      offChanged()
    }
  }, [])

  return { presets, name, startupCommand, gradients, theme, tourSeen, error }
}
