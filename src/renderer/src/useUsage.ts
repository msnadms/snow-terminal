import { useEffect, useState } from 'react'

type UsageResult = Awaited<ReturnType<typeof window.api.usage.get>>

export function useUsage(): UsageResult | null {
  const [usage, setUsage] = useState<UsageResult | null>(null)

  useEffect(() => {
    let active = true
    window.api.usage.get().then((result) => {
      if (active) setUsage(result)
    })
    const off = window.api.usage.onChanged((result) => setUsage(result))
    return () => {
      active = false
      off()
    }
  }, [])

  return usage
}
