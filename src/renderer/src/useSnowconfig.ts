import { useEffect, useState } from 'react'

type SnowconfigResult = Awaited<ReturnType<typeof window.api.snowconfig.get>>
export type Preset = SnowconfigResult['config']['presets'][number]

export function useSnowconfig(): Preset[] {
  const [presets, setPresets] = useState<Preset[]>([])

  useEffect(() => {
    let cancelled = false

    const receive = (result: SnowconfigResult): void => {
      if (cancelled) return
      if (result.error) console.error(`snow: failed to read ${result.path}: ${result.error}`)
      setPresets(result.config.presets)
    }

    window.api.snowconfig.get().then(receive)
    const offChanged = window.api.snowconfig.onChanged(receive)

    return () => {
      cancelled = true
      offChanged()
    }
  }, [])

  return presets
}
