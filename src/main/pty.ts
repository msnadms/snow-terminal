import { ipcMain, WebContents } from 'electron'
import { spawn, IPty } from 'node-pty'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { shellSpec } from './shellIntegration'
import { log } from './log'
import { agentOwner, releaseTerminal, retainTerminal, retireTerminal } from './agents'

interface PtySession {
  pty: IPty
  webContents: WebContents
  cwd: string
  agentTerminal: string
  promptReports: number
}

const sessions = new Map<number, PtySession>()
const destroyHooked = new WeakSet<WebContents>()

function killSession(id: number, session: PtySession): void {
  try {
    session.pty.kill()
  } finally {
    releaseTerminal(session.agentTerminal)
    if (sessions.get(id)?.pty === session.pty) sessions.delete(id)
  }
}

function disposePtyFor(wcId: number): void {
  for (const [id, session] of sessions) {
    if (session.webContents.id !== wcId) continue
    killSession(id, session)
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

// eslint-disable-next-line no-control-regex -- an OSC sequence is delimited by ESC and BEL by definition
const osc7 = /\u001b]7;file:\/\/[^/]*([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g

/**
 * Track the shell's live directory from the OSC 7 reports `shellSpec` makes every prompt. The
 * spawn cwd alone is not enough for `closePtysInDirectory`: a shell started elsewhere that `cd`s
 * into a worktree holds that directory open just as firmly, and is exactly what makes
 * `git worktree remove` fail on Windows.
 */
function trackCwd(id: number, data: string): void {
  const session = sessions.get(id)
  if (!session) return
  let match: RegExpExecArray | null
  let latest: string | null = null
  let reports = 0
  osc7.lastIndex = 0
  while ((match = osc7.exec(data))) {
    latest = match[1]
    reports += 1
  }
  if (!latest) return
  // Snow's shell integration emits OSC 7 from the prompt. The first report belongs to the shell
  // starting up; any later report means its foreground command (including Claude) has exited. A
  // force-killed Claude cannot fire SessionEnd, so retire the record tied to this exact terminal.
  session.promptReports += reports
  if (session.promptReports > 1) retireTerminal(session.agentTerminal)
  try {
    const decoded = decodeURIComponent(latest)
    // A Windows report is `/C:/path`; POSIX reports are already absolute.
    session.cwd = path.resolve(/^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded)
  } catch {
    // a partially received escape sequence is not worth acting on
  }
}

/**
 * Stop terminals rooted in a worktree before Git removes it. Windows cannot delete a directory
 * while a shell (or Git itself) has that directory as its current working directory.
 */
export async function closePtysInDirectory(directory: string): Promise<void> {
  const targets = [...sessions.values()].filter((session) => isInside(session.cwd, directory))
  for (const session of targets) releaseTerminal(session.agentTerminal)
  await Promise.all(
    targets.map(
      (session) =>
        new Promise<void>((resolve) => {
          let done = false
          const finish = (): void => {
            if (done) return
            done = true
            clearTimeout(timeout)
            exit.dispose()
            resolve()
          }
          const exit = session.pty.onExit(finish)
          const timeout = setTimeout(finish, 2000)
          try {
            session.pty.kill()
          } catch {
            finish()
          }
        })
    )
  )
}

export function registerPtyHandlers(): void {
  ipcMain.on(
    'pty:spawn',
    (
      event,
      {
        id,
        cols,
        rows,
        cwd,
        startupCommand,
        ownerId
      }: {
        id: number
        cols: number
        rows: number
        cwd?: string
        startupCommand?: string
        ownerId?: number
      }
    ) => {
      const existing = sessions.get(id)
      if (existing) killSession(id, existing)

      const spec = shellSpec()
      // Per spawn, not per id: a respawn of the same pane must not inherit the token whose records
      // the outgoing pty's own exit is about to delete.
      const agentTerminal = randomUUID()
      retainTerminal(agentTerminal, ownerId ?? id)
      let pty: IPty
      try {
        pty = spawn(spec.file, spec.args, {
          name: 'xterm-256color',
          cols: cols || 80,
          rows: rows || 24,
          cwd: cwd || os.homedir(),
          env: {
            ...spec.env,
            SNOW_AGENT_BINDING: agentTerminal,
            SNOW_AGENT_OWNER: agentOwner
          }
        })
      } catch (error) {
        releaseTerminal(agentTerminal)
        log('error', 'pty', 'spawn failed', { id, cwd: cwd || os.homedir(), error })
        if (!event.sender.isDestroyed()) event.sender.send('pty:exit', { id, exitCode: 1 })
        return
      }

      log('info', 'pty', 'spawn', {
        id,
        pid: pty.pid,
        file: spec.file,
        cwd: cwd || os.homedir(),
        cols: cols || 80,
        rows: rows || 24,
        startupCommand
      })

      if (startupCommand) {
        pty.write(`${startupCommand}\r`)
      }

      const webContents = event.sender

      const safeSend = (channel: string, payload: unknown): void => {
        if (webContents.isDestroyed()) return
        try {
          webContents.send(channel, payload)
        } catch {
          // frame torn down mid-send
        }
      }

      let buffer = ''
      let flushTimer: NodeJS.Timeout | null = null
      const flush = (): void => {
        if (flushTimer) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
        if (!buffer) return
        const data = buffer
        buffer = ''
        safeSend('pty:data', { id, data })
      }

      pty.onData((data) => {
        trackCwd(id, data)
        buffer += data
        if (!flushTimer) flushTimer = setTimeout(flush, 4)
      })

      pty.onExit(({ exitCode }) => {
        flush()
        log('info', 'pty', 'exit', { id, pid: pty.pid, exitCode })
        safeSend('pty:exit', { id, exitCode })
        releaseTerminal(agentTerminal)
        if (sessions.get(id)?.pty === pty) sessions.delete(id)
      })

      sessions.set(id, {
        pty,
        webContents,
        cwd: cwd || os.homedir(),
        agentTerminal,
        promptReports: 0
      })

      if (!destroyHooked.has(webContents)) {
        destroyHooked.add(webContents)
        const wcId = webContents.id
        webContents.once('destroyed', () => disposePtyFor(wcId))
      }
    }
  )

  ipcMain.on('pty:write', (_event, { id, data }: { id: number; data: string }) => {
    const session = sessions.get(id)
    if (!session) return
    // Ctrl+C and Escape are the two interruption keys the renderer recognizes. Persist the same
    // decision here so a stale busy record cannot reappear after the renderer or app restarts.
    if (data === '\u0003' || data === '\x1b') retireTerminal(session.agentTerminal)
    session.pty.write(data)
  })

  ipcMain.on(
    'pty:resize',
    (_event, { id, cols, rows }: { id: number; cols: number; rows: number }) => {
      const session = sessions.get(id)
      if (session && cols > 0 && rows > 0) {
        session.pty.resize(cols, rows)
      }
    }
  )

  ipcMain.on('pty:kill', (_event, { id }: { id: number }) => {
    const session = sessions.get(id)
    if (session) killSession(id, session)
  })
}

export function disposeAllPty(): void {
  // `will-quit` beats every asynchronous exit event, so releasing here rather than leaving it to
  // `onExit` is what keeps the next launch from seeing this run's records as live.
  for (const { pty, agentTerminal } of sessions.values()) {
    pty.kill()
    releaseTerminal(agentTerminal)
  }
  sessions.clear()
}
