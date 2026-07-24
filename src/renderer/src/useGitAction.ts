import { useState } from 'react'
import { failureOf, failureOfError, type Failure } from '@renderer/format'
import { flashClass, useFlash } from '@renderer/useFlash'

export interface GitActionResult {
  ok: boolean
  error?: string
  detail?: string
}

export interface GitActionOptions {
  onFailure?: (failure: Failure) => void
  onSettled?: () => void
}

export interface GitAction<T extends GitActionResult> {
  pending: boolean
  label: string
  className: string
  error: string
  run: (op: () => Promise<T>, label?: string) => Promise<T | null>
}

export function useGitAction<T extends GitActionResult = GitActionResult>({
  onFailure,
  onSettled
}: GitActionOptions = {}): GitAction<T> {
  const [label, setLabel] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [flash, trigger] = useFlash()

  const run = async (op: () => Promise<T>, next = ''): Promise<T | null> => {
    if (pending) return null
    setPending(true)
    setLabel(next)
    setError('')
    let result: T | null = null
    let failure: Failure | null = null
    try {
      result = await op()
      if (!result.ok) failure = failureOf(result)
    } catch (error) {
      failure = failureOfError(error)
    }
    setPending(false)
    setLabel('')

    if (failure) {
      setError(failure.title)
      onFailure?.(failure)
      trigger('error')
    } else {
      trigger('ok')
    }

    onSettled?.()
    return result
  }

  return { pending, label, className: flashClass(flash), error, run }
}
