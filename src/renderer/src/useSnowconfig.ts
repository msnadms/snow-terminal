import { useCallback, useEffect, useState } from 'react'

type SnowconfigResult = Awaited<ReturnType<typeof window.api.snowconfig.get>>
export type Preset = SnowconfigResult['config']['presets'][number]
export type Layout = NonNullable<SnowconfigResult['config']['layout']>

export function visiblePresetEntries(presets: Preset[]): { preset: Preset; index: number }[] {
  return presets.flatMap((preset, index) => (preset.hidden ? [] : [{ preset, index }]))
}

export function useSnowconfig(): {
  presets: Preset[]
  name: string | null
  startupCommand: string | null
  gradients: boolean
  theme: string | null
  tourSeen: boolean
  hooksPrompted: boolean
  keybinds: Record<string, string>
  layout: Layout
  workspaceOrder: string[]
  setWorkspaceOrder: (order: string[]) => Promise<SnowconfigResult>
  error: string | null
} {
  const [presets, setPresets] = useState<Preset[]>([])
  const [name, setName] = useState<string | null>(null)
  const [startupCommand, setStartupCommand] = useState<string | null>(null)
  const [gradients, setGradients] = useState(true)
  const [theme, setTheme] = useState<string | null>(null)
  const [tourSeen, setTourSeen] = useState(false)
  const [hooksPrompted, setHooksPrompted] = useState(false)
  const [keybinds, setKeybinds] = useState<Record<string, string>>({})
  const [layout, setLayout] = useState<Layout>({})
  const [workspaceOrder, setWorkspaceOrderState] = useState<string[]>([])
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
      setHooksPrompted(result.config.hooksPrompted ?? false)
      setKeybinds(result.config.keybinds ?? {})
      setLayout(result.config.layout ?? {})
      setWorkspaceOrderState(result.config.workspaceOrder ?? [])
    }

    window.api.snowconfig.get().then(receive)
    const offChanged = window.api.snowconfig.onChanged(receive)

    return () => {
      cancelled = true
      offChanged()
    }
  }, [])

  const setWorkspaceOrder = useCallback(async (order: string[]): Promise<SnowconfigResult> => {
    setWorkspaceOrderState(order)
    return window.api.snowconfig.setWorkspaceOrder(order)
  }, [])

  return {
    presets,
    name,
    startupCommand,
    gradients,
    theme,
    tourSeen,
    hooksPrompted,
    keybinds,
    layout,
    workspaceOrder,
    setWorkspaceOrder,
    error
  }
}
