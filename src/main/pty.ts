import { ipcMain, WebContents } from 'electron'
import { spawn, IPty } from 'node-pty'
import os from 'os'
import { shellSpec } from './shellIntegration'

interface PtySession {
  pty: IPty
  webContents: WebContents
}

const sessions = new Map<number, PtySession>()

export function registerPtyHandlers(): void {
  ipcMain.on(
    'pty:spawn',
    (event, { id, cols, rows, cwd }: { id: number; cols: number; rows: number; cwd?: string }) => {
      sessions.get(id)?.pty.kill()

      const spec = shellSpec()
      const pty = spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: cols || 80,
        rows: rows || 24,
        cwd: cwd || os.homedir(),
        env: spec.env
      })

      const webContents = event.sender

      const safeSend = (channel: string, payload: unknown): void => {
        if (webContents.isDestroyed()) return
        try {
          webContents.send(channel, payload)
        } catch {
          // frame torn down mid-send
        }
      }

      pty.onData((data) => {
        safeSend('pty:data', { id, data })
      })

      pty.onExit(({ exitCode }) => {
        safeSend('pty:exit', { id, exitCode })
        sessions.delete(id)
      })

      webContents.once('destroyed', () => {
        sessions.get(id)?.pty.kill()
        sessions.delete(id)
      })

      sessions.set(id, { pty, webContents })
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
  for (const { pty } of sessions.values()) {
    pty.kill()
  }
  sessions.clear()
}
