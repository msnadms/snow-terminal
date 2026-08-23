import { useEffect, useState } from 'react'

type HooksState = Awaited<ReturnType<typeof window.api.hooks.state>>

interface HooksPromptProps {
  prompted: boolean
}

/**
 * The offer snow makes exactly once. `snow hooks install` stays the real entry point - this only
 * fixes its discoverability, since nothing in the UI would otherwise say the feature exists. The
 * answer is recorded either way: the flag means "asked", not "declined", so a later `snow hooks
 * remove` does not bring the offer back.
 */
function HooksPrompt({ prompted }: HooksPromptProps): React.JSX.Element | null {
  const [state, setState] = useState<HooksState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    const load = (): void => {
      window.api.hooks.state().then((next) => {
        if (active) setState(next)
      })
    }
    load()
    const off = window.api.hooks.onChanged(load)
    return () => {
      active = false
      off()
    }
  }, [])

  const answer = async (install: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (install) {
        const result = await window.api.hooks.run('install')
        if (!result.ok) return
      }
      await window.api.snowconfig.setHooksPrompted()
    } finally {
      setBusy(false)
    }
  }

  if (!state || state.error || !state.available) return null
  if (state.installed) return null
  if (prompted || busy) return null

  return (
    <div className="home-hooks">
      <div className="home-hooks-title">Let Claude Code report its own status?</div>
      <div className="home-hooks-detail">
        {'snow currently guesses whether a pane is busy from terminal output, which cannot see a '}
        {'session waiting on a permission prompt. Installing hooks adds an entry to '}
        <span className="home-hooks-path">{state.settings}</span>
        {' that reports it directly. Undo any time with '}
        <span className="home-hooks-path">snow hooks remove</span>.
        {' Shared-stash protection starts in deny mode; change it with '}
        <span className="home-hooks-path">snow hooks protection deny|warn|off</span>
        {' to choose its behavior.'}
      </div>
      <div className="home-hooks-actions">
        <button className="home-hooks-button home-hooks-accept" onClick={() => answer(true)}>
          Install hooks
        </button>
        <button className="home-hooks-button" onClick={() => answer(false)}>
          Not now
        </button>
      </div>
    </div>
  )
}

export default HooksPrompt
