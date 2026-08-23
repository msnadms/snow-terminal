import { ipcMain, WebContents } from 'electron'
import { spawn, IPty } from 'node-pty'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { shellSpec } from './shellIntegration'
import { log } from './log'
import { removeAgentsForTerminals } from './agents'

interface PtySession {
  pty: IPty
  webContents: WebContents
  cwd: string
  agentTerminal: string
}

const sessions = new Map<number, PtySession>()
const destroyHooked = new WeakSet<WebContents>()

function disposePtyFor(wcId: number): void {
  for (const [id, session] of sessions) {
    if (session.webContents.id !== wcId) continue
    session.pty.kill()
    sessions.delete(id)
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
  osc7.lastIndex = 0
  while ((match = osc7.exec(data))) latest = match[1]
  if (!latest) return
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
        startupCommand
      }: { id: number; cols: number; rows: number; cwd?: string; startupCommand?: string }
    ) => {
      sessions.get(id)?.pty.kill()

      const spec = shellSpec()
      // Per spawn, not per id: a respawn of the same pane must not inherit the token whose records
      // the outgoing pty's own exit is about to delete.
      const agentTerminal = randomUUID()
      let pty: IPty
      try {
        pty = spawn(spec.file, spec.args, {
          name: 'xterm-256color',
          cols: cols || 80,
          rows: rows || 24,
          cwd: cwd || os.homedir(),
          env: { ...spec.env, SNOW_AGENT_TERMINAL: agentTerminal }
        })
      } catch (error) {
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
        removeAgentsForTerminals(new Set([agentTerminal]))
        if (sessions.get(id)?.pty === pty) sessions.delete(id)
      })

      sessions.set(id, { pty, webContents, cwd: cwd || os.homedir(), agentTerminal })

      if (!destroyHooked.has(webContents)) {
        destroyHooked.add(webContents)
        const wcId = webContents.id
        webContents.once('destroyed', () => disposePtyFor(wcId))
      }
    }
  )

  ipcMain.on('pty:write', (_event, { id, data }: { id: number; data: string }) => {
    sessions.get(id)?.pty.write(data)
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
    sessions.get(id)?.pty.kill()
    sessions.delete(id)
  })
}

export function disposeAllPty(): void {
  // `will-quit` beats every asynchronous exit event, so this is the one teardown that has to sweep
  // the records itself - one pass for every pane rather than one per pane.
  const terminals = new Set<string>()
  for (const { pty, agentTerminal } of sessions.values()) {
    pty.kill()
    terminals.add(agentTerminal)
  }
  removeAgentsForTerminals(terminals)
  sessions.clear()
}
