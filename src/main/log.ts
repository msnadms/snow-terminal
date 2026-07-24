import { app, ipcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import fs from 'fs'
import path from 'path'
import { configDir } from './config'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const maxBytes = 100_000
const maxValueChars = 400
const quietChannels = new Set(['pty:write', 'pty:resize'])
const redactedChannels = new Set([
  'git:blame',
  'git:show',
  'workflow:list',
  'workflow:register',
  'workflow:unregister',
  'workflow:switch',
  'workflow:create',
  'snowconfig:get',
  'snowconfig:addPreset',
  'snowconfig:setDefault',
  'snowconfig:chooseDir'
])

let stream: fs.WriteStream | null = null
let bytes = 0

export function logPath(): string {
  return path.join(configDir(), 'snow.log')
}

function openStream(): void {
  const file = logPath()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    bytes = fs.statSync(file).size
  } catch {
    bytes = 0
  }
  try {
    const opened = fs.createWriteStream(file, { flags: 'a' })
    opened.on('error', () => {
      stream = null
    })
    stream = opened
  } catch {
    stream = null
  }
}

function reset(): void {
  stream?.end()
  stream = null
  try {
    fs.unlinkSync(logPath())
  } catch {
    /* empty */
  }
  openStream()
}

function truncate(text: string): string {
  return text.length > maxValueChars ? `${text.slice(0, maxValueChars)}…` : text
}

function format(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return truncate(value)
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  try {
    return truncate(JSON.stringify(value) ?? String(value))
  } catch {
    return String(value)
  }
}

export function log(level: LogLevel, scope: string, ...parts: unknown[]): void {
  if (!stream) return
  if (bytes >= maxBytes) reset()
  if (!stream) return
  const body = parts.map(format).join(' ')
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${body}\n`
  bytes += Buffer.byteLength(line)
  stream.write(line)
}

function patchConsole(): void {
  const levels: Record<'log' | 'info' | 'warn' | 'error' | 'debug', LogLevel> = {
    log: 'info',
    info: 'info',
    warn: 'warn',
    error: 'error',
    debug: 'debug'
  }
  for (const method of Object.keys(levels) as (keyof typeof levels)[]) {
    const original = console[method].bind(console)
    console[method] = (...args: unknown[]): void => {
      original(...args)
      log(levels[method], 'console', ...args)
    }
  }
}

function instrumentIpc(): void {
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown
  ): void => {
    handle(channel, async (event, ...args) => {
      const started = Date.now()
      const redacted = redactedChannels.has(channel)
      try {
        const result = await listener(event, ...(args as never[]))
        const detail = redacted ? [] : [{ args, result }]
        log('debug', 'ipc', `${channel} ${Date.now() - started}ms`, ...detail)
        return result
      } catch (error) {
        const detail = redacted ? [] : [{ args }]
        log('error', 'ipc', `${channel} threw after ${Date.now() - started}ms`, ...detail, error)
        throw error
      }
    })
  }

  const on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel: string, listener: (event: IpcMainEvent, ...args: never[]) => void) => {
    return on(channel, (event, ...args) => {
      if (!quietChannels.has(channel)) log('debug', 'ipc', channel, { args })
      try {
        listener(event, ...(args as never[]))
      } catch (error) {
        log('error', 'ipc', `${channel} threw`, error)
        throw error
      }
    })
  }
}

export function watchRenderer(webContents: WebContents): void {
  const levels: Record<string, LogLevel> = {
    debug: 'debug',
    info: 'info',
    warning: 'warn',
    error: 'error'
  }
  webContents.on('console-message', (details) => {
    const where = details.sourceId ? ` (${details.sourceId}:${details.lineNumber})` : ''
    log(levels[details.level] ?? 'info', 'renderer', `${details.message}${where}`)
  })
  webContents.on('render-process-gone', (_event, details) =>
    log('error', 'renderer', 'process gone', details)
  )
  webContents.on('did-fail-load', (_event, code, description, url) =>
    log('error', 'renderer', 'load failed', { code, description, url })
  )
  webContents.on('preload-error', (_event, preloadPath, error) =>
    log('error', 'preload', preloadPath, error)
  )
}

export function initLogging(): void {
  openStream()
  patchConsole()
  instrumentIpc()

  process.on('uncaughtException', (error) => log('error', 'main', 'uncaught exception', error))
  process.on('unhandledRejection', (reason) => log('error', 'main', 'unhandled rejection', reason))

  log('info', 'app', 'start', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    pid: process.pid
  })
}

export function closeLogging(): void {
  log('info', 'app', 'quit')
  stream?.end()
  stream = null
}
