import { useEffect, useState } from 'react'

type ThemeResult = Awaited<ReturnType<typeof window.api.theme.get>>
export type GitColors = ThemeResult['theme']['git']

const cssVars: Record<Exclude<keyof GitColors, 'lanes'>, string> = {
  background: '--git-bg',
  border: '--git-border',
  text: '--git-text',
  strongText: '--git-strong-text',
  accent: '--git-accent',
  buttonBorder: '--git-button-border',
  buttonBorderHover: '--git-button-border-hover',
  muted: '--git-muted',
  repo: '--git-repo',
  branch: '--git-branch',
  track: '--git-track',
  dirty: '--git-dirty',
  author: '--git-author',
  hash: '--git-hash',
  hashHover: '--git-hash-hover',
  tooltipBackground: '--git-tooltip-bg',
  tooltipBorder: '--git-tooltip-border',
  tooltipText: '--git-tooltip-text',
  tooltipMuted: '--git-tooltip-muted',
  diffAddBackground: '--git-diff-add-bg',
  diffDeleteBackground: '--git-diff-del-bg',
  diffAddGutter: '--git-diff-add-gutter',
  diffDeleteGutter: '--git-diff-del-gutter',
  diffAddText: '--git-diff-add-text',
  diffDeleteText: '--git-diff-del-text'
}

const kebab = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

function applyCssVars(theme: ThemeResult['theme']): void {
  const root = document.documentElement
  for (const [key, name] of Object.entries(cssVars)) {
    root.style.setProperty(name, theme.git[key as keyof typeof cssVars])
  }
  for (const [key, value] of Object.entries(theme.syntax)) {
    root.style.setProperty(`--syntax-${kebab(key)}`, value)
  }
}

export function useGitColors(): GitColors | null {
  const [colors, setColors] = useState<GitColors | null>(null)

  useEffect(() => {
    let cancelled = false

    const receive = (result: ThemeResult): void => {
      if (cancelled) return
      if (result.error) console.error(`snow: failed to read ${result.path}: ${result.error}`)
      applyCssVars(result.theme)
      setColors(result.theme.git)
    }

    window.api.theme.get().then(receive)
    const offChanged = window.api.theme.onChanged(receive)

    return () => {
      cancelled = true
      offChanged()
    }
  }, [])

  return colors
}
