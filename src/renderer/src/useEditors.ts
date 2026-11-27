import { useSyncExternalStore } from 'react'

export type EditorAvailability = Awaited<ReturnType<typeof window.api.editor.available>>

const none: EditorAvailability = { vscode: false, visualStudio: false }
const listeners = new Set<() => void>()
let current: EditorAvailability = none
let loaded = false
let lookup: Promise<void> | null = null

function refresh(): void {
  if (lookup) return
  lookup = window.api.editor
    .available()
    .then(
      (result) => {
        loaded = true
        if (result.vscode === current.vscode && result.visualStudio === current.visualStudio) return
        current = result
        for (const listener of listeners) listener()
      },
      (error) => console.error('editor lookup failed:', error)
    )
    .finally(() => {
      lookup = null
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) window.addEventListener('focus', refresh)
  if (!loaded) refresh()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('focus', refresh)
  }
}

function snapshot(): EditorAvailability {
  return current
}

export function hasEditor(editors: EditorAvailability): boolean {
  return editors.vscode || editors.visualStudio
}

export function useEditors(): EditorAvailability {
  return useSyncExternalStore(subscribe, snapshot)
}
