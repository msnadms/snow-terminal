import { useCallback, useEffect, useRef } from 'react'

export function useLatestRun(): () => () => boolean {
  const latest = useRef(0)

  useEffect(
    () => () => {
      latest.current++
    },
    []
  )

  return useCallback(() => {
    const mine = ++latest.current
    return () => mine === latest.current
  }, [])
}
