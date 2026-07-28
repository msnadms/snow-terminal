import { useSyncExternalStore } from 'react'

type ThemeResult = Awaited<ReturnType<typeof window.api.theme.get>>
export type Theme = ThemeResult['theme']
export type GitColors = Theme['git']

const cssVars: Record<Exclude<keyof GitColors, 'lanes'>, string> = {
  background: '--git-bg',
  panelBackground: '--git-panel-bg',
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

function applyCssVars(theme: Theme): void {
  const root = document.documentElement
  for (const [key, name] of Object.entries(cssVars)) {
    root.style.setProperty(name, theme.git[key as keyof typeof cssVars])
  }
  for (const [key, value] of Object.entries(theme.ui)) {
    root.style.setProperty(`--ui-${kebab(key)}`, value)
  }
  for (const [key, value] of Object.entries(theme.syntax)) {
    root.style.setProperty(`--syntax-${kebab(key)}`, value)
  }
}

let current: Theme | null = null
let started = false
const listeners = new Set<() => void>()

function set(result: ThemeResult): void {
  if (result.error) console.error(`snow: failed to read ${result.path}: ${result.error}`)
  current = result.theme
  applyCssVars(result.theme)
  for (const listener of listeners) listener()
}

function start(): void {
  if (started) return
  started = true
  const refetch = (): void => {
    window.api.theme.get().then(set)
  }
  refetch()
  window.api.theme.onChanged(set)
  window.api.snowconfig.onChanged(refetch)
}

export function subscribeTheme(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getTheme(): Theme | null {
  return current
}

export function useTheme(): Theme | null {
  return useSyncExternalStore(subscribeTheme, getTheme, getTheme)
}
