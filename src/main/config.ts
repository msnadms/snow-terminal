import { BrowserWindow } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config')
  return path.join(base, 'snow')
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

export function writeDefaultConfig(file: string, contents: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, contents, { flag: 'wx' })
  } catch {
    /* already exists */
  }
}

export function broadcast(channel: string, payload?: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) window.webContents.send(channel, payload)
  }
}

export function watchConfigFile(file: string, onChange: () => void): () => void {
  const name = path.basename(file)
  let timer: NodeJS.Timeout | null = null
  const stopTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  try {
    const watcher = fs.watch(path.dirname(file), (_event, filename) => {
      if (filename && path.basename(filename) !== name) return
      stopTimer()
      timer = setTimeout(() => {
        timer = null
        onChange()
      }, 120)
    })
    watcher.on('error', () => watcher.close())
    return () => {
      watcher.close()
      stopTimer()
    }
  } catch {
    return stopTimer
  }
}
