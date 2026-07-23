import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  GitBlame,
  GitBranches,
  GitCheckoutResult,
  GitCommitDetail,
  GitCommitPushResult,
  GitLog,
  GitRepo,
  GitStatus,
  GitSyncDefaultResult
} from '../main/git'
import type { ThemeResult } from '../main/theme'
import type { SnowignoreResult } from '../main/snowignore'
import type { SnowconfigResult } from '../main/snowconfig'

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
  blame: (cwd: string | undefined, rev: string, filePath: string): Promise<GitBlame> =>
    ipcRenderer.invoke('git:blame', cwd, rev, filePath),
  discover: (cwd?: string): Promise<GitRepo[]> => ipcRenderer.invoke('git:discover', cwd),
  log: (cwd?: string, maxCount?: number): Promise<GitLog> =>
    ipcRenderer.invoke('git:log', cwd, maxCount),
  show: (cwd: string | undefined, hash: string): Promise<GitCommitDetail> =>
    ipcRenderer.invoke('git:show', cwd, hash),
  status: (cwd?: string): Promise<GitStatus> => ipcRenderer.invoke('git:status', cwd),
  branches: (cwd?: string): Promise<GitBranches> => ipcRenderer.invoke('git:branches', cwd),
  checkout: (cwd: string | undefined, branch: string): Promise<GitCheckoutResult> =>
    ipcRenderer.invoke('git:checkout', cwd, branch),
  createBranch: (cwd: string | undefined, branch: string): Promise<GitCheckoutResult> =>
    ipcRenderer.invoke('git:createBranch', cwd, branch),
  commitPush: (cwd: string | undefined, message: string): Promise<GitCommitPushResult> =>
    ipcRenderer.invoke('git:commitPush', cwd, message),
  syncDefault: (cwd?: string): Promise<GitSyncDefaultResult> =>
    ipcRenderer.invoke('git:syncDefault', cwd),
  watch: (cwd?: string): Promise<void> => ipcRenderer.invoke('git:watch', cwd),
  unwatch: (cwd?: string): Promise<void> => ipcRenderer.invoke('git:unwatch', cwd),
  onChanged: (callback: (cwd: string | null) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, cwd: string | null): void => callback(cwd)
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

const snowignore = {
  get: (): Promise<SnowignoreResult> => ipcRenderer.invoke('snowignore:get'),
  onChanged: (callback: (result: SnowignoreResult) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, result: SnowignoreResult): void => callback(result)
    ipcRenderer.on('snowignore:changed', listener)
    return () => ipcRenderer.removeListener('snowignore:changed', listener)
  }
}

const snowconfig = {
  get: (): Promise<SnowconfigResult> => ipcRenderer.invoke('snowconfig:get'),
  addPreset: (preset: { name: string; cwd: string }): Promise<SnowconfigResult> =>
    ipcRenderer.invoke('snowconfig:addPreset', preset),
  setDefault: (index: number): Promise<SnowconfigResult> =>
    ipcRenderer.invoke('snowconfig:setDefault', index),
  chooseDir: (): Promise<string | null> => ipcRenderer.invoke('snowconfig:chooseDir'),
  onChanged: (callback: (result: SnowconfigResult) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, result: SnowconfigResult): void => callback(result)
    ipcRenderer.on('snowconfig:changed', listener)
    return () => ipcRenderer.removeListener('snowconfig:changed', listener)
  }
}

const api = { terminal, git, theme, snowignore, snowconfig }

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
