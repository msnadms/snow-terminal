import { useState } from 'react'
import { failureOf, type Failure } from '@renderer/format'
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
    let result: T
    try {
      result = await op()
    } finally {
      setPending(false)
      setLabel('')
    }

    if (result.ok) {
      trigger('ok')
    } else {
      const failure = failureOf(result)
      setError(failure.title)
      onFailure?.(failure)
      trigger('error')
    }

    onSettled?.()
    return result
  }

  return { pending, label, className: flashClass(flash), error, run }
}
