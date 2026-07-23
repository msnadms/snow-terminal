import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { GitLog, GitStatus } from '../main/git'
import type { ThemeResult } from '../main/theme'

const terminal = {
  spawn: (id: number, cols: number, rows: number, cwd?: string, startupCommand?: string): void => {
    ipcRenderer.send('pty:spawn', { id, cols, rows, cwd, startupCommand })
  },
  write: (id: number, data: string): void => {
    ipcRenderer.send('pty:write', { id, data })
  },
  resize: (id: number, cols: number, rows: number): void => {
    ipcRenderer.send('pty:resize', { id, cols, rows })
  },
  kill: (id: number): void => {
    ipcRenderer.send('pty:kill', { id })
  },
  onData: (callback: (id: number, data: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { id: number; data: string }): void =>
      callback(payload.id, payload.data)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },
  onExit: (callback: (id: number, exitCode: number) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { id: number; exitCode: number }): void =>
      callback(payload.id, payload.exitCode)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  }
}

const git = {
  isRepo: (cwd?: string): Promise<boolean> => ipcRenderer.invoke('git:isRepo', cwd),
  log: (cwd?: string): Promise<GitLog> => ipcRenderer.invoke('git:log', cwd),
  status: (cwd?: string): Promise<GitStatus> => ipcRenderer.invoke('git:status', cwd),
  watch: (cwd?: string): Promise<void> => ipcRenderer.invoke('git:watch', cwd),
  onChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('git:changed', listener)
    return () => ipcRenderer.removeListener('git:changed', listener)
  }
}

const theme = {
  get: (): Promise<ThemeResult> => ipcRenderer.invoke('theme:get'),
  onChanged: (callback: (result: ThemeResult) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, result: ThemeResult): void => callback(result)
    ipcRenderer.on('theme:changed', listener)
    return () => ipcRenderer.removeListener('theme:changed', listener)
  }
}

const api = { terminal, git, theme }

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
