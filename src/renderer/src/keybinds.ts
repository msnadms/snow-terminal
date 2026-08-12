import { useEffect, useRef } from 'react'

export type KeybindAction =
  | 'newTab'
  | 'closeTab'
  | 'nextTab'
  | 'prevTab'
  | 'newSplit'
  | 'diffSplit'
  | 'runCommand'
  | 'switchRepo'
  | 'focusCommit'
  | 'aiCommit'
  | 'pushRemote'
  | 'focusLeft'
  | 'focusDown'
  | 'focusUp'
  | 'focusRight'

export const defaultKeybinds: Record<KeybindAction, string> = {
  newTab: 'Mod+Shift+T',
  closeTab: 'Mod+Shift+W',
  nextTab: 'Mod+Shift+}',
  prevTab: 'Mod+Shift+{',
  newSplit: 'Mod+Shift+~',
  diffSplit: 'Mod+Shift+G',
  runCommand: 'Mod+Shift+Q',
  switchRepo: 'Mod+Shift+?',
  focusCommit: 'Mod+Shift+M',
  aiCommit: 'Mod+Shift+Enter',
  pushRemote: 'Mod+Shift+P',
  focusLeft: 'Mod+Shift+H',
  focusDown: 'Mod+Shift+J',
  focusUp: 'Mod+Shift+K',
  focusRight: 'Mod+Shift+L'
}

export type PresetDigitAction = 'splitPreset' | 'openPreset'

const defaultDigitModifiers: Record<PresetDigitAction, string> = {
  splitPreset: 'Mod+Shift',
  openPreset: 'Mod+Alt'
}

const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
const isMac = /mac/i.test(uaData?.platform ?? navigator.userAgent)

function normalizeKey(raw: string): string {
  const key = raw.toLowerCase()
  if (key === ' ' || key === 'spacebar') return 'space'
  if (key === 'return') return 'enter'
  if (key === 'escape') return 'esc'
  return key
}

function tokens(binding: string): string[] {
  return binding
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
}

function modifiersMatch(e: KeyboardEvent, mods: string[]): boolean {
  const set = new Set(mods)
  const wantMod = set.has('mod') || set.has('cmdorctrl')
  const wantCtrl = set.has('ctrl') || set.has('control') || (wantMod && !isMac)
  const wantMeta = set.has('cmd') || set.has('command') || set.has('meta') || (wantMod && isMac)
  const wantAlt = set.has('alt') || set.has('option')
  const wantShift = set.has('shift')
  return (
    e.ctrlKey === wantCtrl &&
    e.metaKey === wantMeta &&
    e.altKey === wantAlt &&
    e.shiftKey === wantShift
  )
}

export function matchKeybind(e: KeyboardEvent, binding: string): boolean {
  const parts = tokens(binding)
  if (parts.length === 0) return false
  const key = normalizeKey(parts[parts.length - 1])
  return modifiersMatch(e, parts.slice(0, -1)) && normalizeKey(e.key) === key
}

export function splitPresetIndex(e: KeyboardEvent, modifier: string): number | null {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)
  if (!match) return null
  if (!modifiersMatch(e, tokens(modifier))) return null
  return Number(match[1]) - 1
}

type KeydownRef = { current: (e: KeyboardEvent) => boolean }

const registry = new Set<KeydownRef>()
let listening = false

function dispatch(e: KeyboardEvent): void {
  if (e.isComposing) return
  for (const ref of registry) {
    if (ref.current(e)) return
  }
}

function useCaptureKeydown(handler: (e: KeyboardEvent) => boolean): void {
  const ref = useRef(handler)
  useEffect(() => {
    ref.current = handler
  })
  useEffect(() => {
    registry.add(ref)
    if (!listening) {
      listening = true
      window.addEventListener('keydown', dispatch, true)
    }
    return () => {
      registry.delete(ref)
    }
  }, [])
}

export function useKeybinds(
  binds: Record<string, string>,
  handlers: Partial<Record<KeybindAction, (() => void) | undefined>>
): void {
  useCaptureKeydown((e) => {
    for (const action of Object.keys(handlers) as KeybindAction[]) {
      const handler = handlers[action]
      if (!handler) continue
      const binding = binds[action] ?? defaultKeybinds[action]
      if (!binding) continue
      if (matchKeybind(e, binding)) {
        e.preventDefault()
        e.stopPropagation()
        handler()
        return true
      }
    }
    return false
  })
}

export function usePresetDigitKeybind(
  binds: Record<string, string>,
  action: PresetDigitAction,
  onPreset: ((index: number) => void) | undefined
): void {
  const modifier = binds[action] ?? defaultDigitModifiers[action]
  useCaptureKeydown((e) => {
    if (!onPreset) return false
    const index = splitPresetIndex(e, modifier)
    if (index === null) return false
    e.preventDefault()
    e.stopPropagation()
    onPreset(index)
    return true
  })
}
