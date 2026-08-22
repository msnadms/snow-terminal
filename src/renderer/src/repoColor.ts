import { normalizePath } from '@renderer/format'
import { fallbackLanes } from '@renderer/useGitColors'

function hash(key: string): number {
  let value = 2166136261
  for (let i = 0; i < key.length; i++) {
    value ^= key.charCodeAt(i)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

function repoKey(path: string): string {
  return normalizePath(path).toLowerCase()
}

export function repoColor(path: string, lanes?: string[]): string {
  const palette = lanes?.length ? lanes : fallbackLanes
  return palette[hash(repoKey(path)) % palette.length]
}
