import { useEffect, useState } from 'react'
import { failureOf, type Failure } from './format'
import type { ThemeInstallResult } from '../../main/themeInstall'
import type { HooksResult } from '../../main/hooks'

export function useAppNotices(): [Failure | null, (notice: Failure | null) => void] {
  const [notice, setNotice] = useState<Failure | null>(null)

  useEffect(() => {
    const installed = (result: ThemeInstallResult): void => {
      if (result.error) setNotice(failureOf({ error: result.error, detail: result.detail }))
    }
    void window.api.theme.pendingInstall().then((result) => {
      if (result) installed(result)
    })
    return window.api.theme.onInstalled(installed)
  }, [])

  useEffect(() => {
    const ran = (result: HooksResult): void => {
      setNotice(
        result.error
          ? failureOf({ error: result.error, detail: result.detail })
          : { title: result.message, detail: result.detail }
      )
    }
    void window.api.hooks.pending().then((result) => {
      if (result) ran(result)
    })
    return window.api.hooks.onChanged(ran)
  }, [])

  return [notice, setNotice]
}
