import { shell } from 'electron'

const allowedProtocols = new Set(['https:', 'http:'])

export function isExternalUrl(raw: string): boolean {
  try {
    return allowedProtocols.has(new URL(raw).protocol)
  } catch {
    return false
  }
}

export async function openExternal(raw: string): Promise<void> {
  if (!isExternalUrl(raw)) throw new Error(`Refusing to open a non-web URL: ${raw}`)
  await shell.openExternal(raw)
}
