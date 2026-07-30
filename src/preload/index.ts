import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type {
  GitBlameResult,
  GitBranches,
  GitCheckoutResult,
  GitCommitDetail,
  GitCommitResult,
  GitLog,
  GitPullRequestResult,
  GitRepo,
  GitStatus,
  GitSyncDefaultResult,
  GitSyncResult,
  GitUndoResult,
  GitUpdateDefaultResult,
  GitWorkingDiff
} from '../main/git'
import type { BrowserBounds, BrowserState } from '../main/browser'
import type { WorkflowList, WorkflowResult } from '../main/workflow'
import type { ThemeResult } from '../main/theme'
import type { SnowignoreResult } from '../main/snowignore'
import type { SnowconfigResult, Layout } from '../main/snowconfig'

function idDispatcher<P extends { id: number }>(
  channel: string
): (id: number | null, callback: (payload: P) => void) => () => void {
  const byId = new Map<number, Set<(payload: P) => void>>()
  const wild = new Set<(payload: P) => void>()
  let attached = false

  const listener = (_e: IpcRendererEvent, payload: P): void => {
    const set = byId.get(payload.id)
    if (set) for (const cb of [...set]) cb(payload)
    if (wild.size) for (const cb of [...wild]) cb(payload)
  }

  return (id, callback) => {
    if (!attached) {
      ipcRenderer.on(channel, listener)
      attached = true
    }
    if (id === null) {
      wild.add(callback)
      return () => wild.delete(callback)
    }
    let set = byId.get(id)
    if (!set) {
      set = new Set()
      byId.set(id, set)
    }
    set.add(callback)
    return () => {
      const current = byId.get(id)
      if (!current) return
      current.delete(callback)
      if (current.size === 0) byId.delete(id)
    }
  }
}

const onPtyData = idDispatcher<{ id: number; data: string }>('pty:data')
const onPtyExit = idDispatcher<{ id: number; exitCode: number }>('pty:exit')
const onBrowserState = idDispatcher<BrowserState>('browser:state')

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
  onData: (id: number, callback: (data: string) => void): (() => void) =>
    onPtyData(id, (payload) => callback(payload.data)),
  onExit: (id: number | null, callback: (id: number, exitCode: number) => void): (() => void) =>
    onPtyExit(id, (payload) => callback(payload.id, payload.exitCode))
}

const browser = {
  create: (id: number, url: string): void => {
    ipcRenderer.send('browser:create', { id, url })
  },
  setBounds: (id: number, bounds: BrowserBounds, visible: boolean): void => {
    ipcRenderer.send('browser:setBounds', { id, bounds, visible })
  },
  navigate: (id: number, url: string): void => {
    ipcRenderer.send('browser:navigate', { id, url })
  },
  goBack: (id: number): void => {
    ipcRenderer.send('browser:goBack', { id })
  },
  goForward: (id: number): void => {
    ipcRenderer.send('browser:goForward', { id })
  },
  reload: (id: number): void => {
    ipcRenderer.send('browser:reload', { id })
  },
  stop: (id: number): void => {
    ipcRenderer.send('browser:stop', { id })
  },
  destroy: (id: number): void => {
    ipcRenderer.send('browser:destroy', { id })
  },
  onState: (id: number, callback: (state: BrowserState) => void): (() => void) =>
    onBrowserState(id, callback)
}

const git = {
  isRepo: (cwd?: string): Promise<boolean> => ipcRenderer.invoke('git:isRepo', cwd),
  blame: (cwd: string | undefined, rev: string, filePath: string): Promise<GitBlameResult> =>
    ipcRenderer.invoke('git:blame', cwd, rev, filePath),
  discover: (cwd?: string): Promise<GitRepo[]> => ipcRenderer.invoke('git:discover', cwd),
  log: (cwd?: string, maxCount?: number): Promise<GitLog> =>
    ipcRenderer.invoke('git:log', cwd, maxCount),
  show: (cwd: string | undefined, hash: string): Promise<GitCommitDetail> =>
    ipcRenderer.invoke('git:show', cwd, hash),
  diff: (cwd?: string): Promise<GitWorkingDiff> => ipcRenderer.invoke('git:diff', cwd),
  status: (cwd?: string): Promise<GitStatus> => ipcRenderer.invoke('git:status', cwd),
  branches: (cwd?: string): Promise<GitBranches> => ipcRenderer.invoke('git:branches', cwd),
  defaultBranch: (cwd?: string): Promise<string | null> =>
    ipcRenderer.invoke('git:defaultBranch', cwd),
  checkout: (cwd: string | undefined, branch: string): Promise<GitCheckoutResult> =>
    ipcRenderer.invoke('git:checkout', cwd, branch),
  checkoutRemote: (cwd: string | undefined, ref: string): Promise<GitCheckoutResult> =>
    ipcRenderer.invoke('git:checkoutRemote', cwd, ref),
  parkPreview: (cwd?: string): Promise<{ branch: string; files: number } | null> =>
    ipcRenderer.invoke('git:parkPreview', cwd),
  createBranch: (
    cwd: string | undefined,
    branch: string,
    carry: boolean
  ): Promise<GitCheckoutResult> => ipcRenderer.invoke('git:createBranch', cwd, branch, carry),
  commit: (cwd: string | undefined, message: string): Promise<GitCommitResult> =>
    ipcRenderer.invoke('git:commit', cwd, message),
  syncDefault: (cwd?: string): Promise<GitSyncDefaultResult> =>
    ipcRenderer.invoke('git:syncDefault', cwd),
  updateFromDefault: (cwd?: string): Promise<GitUpdateDefaultResult> =>
    ipcRenderer.invoke('git:updateFromDefault', cwd),
  sync: (cwd?: string): Promise<GitSyncResult> => ipcRenderer.invoke('git:sync', cwd),
  undoCommit: (cwd?: string): Promise<GitUndoResult> => ipcRenderer.invoke('git:undoCommit', cwd),
  openPullRequest: (cwd?: string): Promise<GitPullRequestResult> =>
    ipcRenderer.invoke('git:openPullRequest', cwd),
  watch: (cwd?: string): Promise<void> => ipcRenderer.invoke('git:watch', cwd),
  unwatch: (cwd?: string): Promise<void> => ipcRenderer.invoke('git:unwatch', cwd),
  onChanged: (callback: (cwd: string | null) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, cwd: string | null): void => callback(cwd)
    ipcRenderer.on('git:changed', listener)
    return () => ipcRenderer.removeListener('git:changed', listener)
  }
}

const workflow = {
  list: (cwd?: string): Promise<WorkflowList> => ipcRenderer.invoke('workflow:list', cwd),
  register: (cwd: string | undefined, branch?: string): Promise<WorkflowResult> =>
    ipcRenderer.invoke('workflow:register', cwd, branch),
  unregister: (cwd: string | undefined, branch: string): Promise<WorkflowResult> =>
    ipcRenderer.invoke('workflow:unregister', cwd, branch),
  switch: (cwd: string | undefined, branch: string): Promise<WorkflowResult> =>
    ipcRenderer.invoke('workflow:switch', cwd, branch),
  create: (cwd: string | undefined, branch: string): Promise<WorkflowResult> =>
    ipcRenderer.invoke('workflow:create', cwd, branch),
  onChanged: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('workflow:changed', listener)
    return () => ipcRenderer.removeListener('workflow:changed', listener)
  }
}

const theme = {
  get: (): Promise<ThemeResult> => ipcRenderer.invoke('theme:get'),
  list: (): Promise<string[]> => ipcRenderer.invoke('theme:list'),
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
  addPreset: (preset: {
    name: string
    cwd: string
    startupCommand?: string
  }): Promise<SnowconfigResult> => ipcRenderer.invoke('snowconfig:addPreset', preset),
  setDefault: (index: number): Promise<SnowconfigResult> =>
    ipcRenderer.invoke('snowconfig:setDefault', index),
  removePreset: (index: number): Promise<SnowconfigResult> =>
    ipcRenderer.invoke('snowconfig:removePreset', index),
  addCommand: (presetIndex: number, command: string): Promise<SnowconfigResult> =>
    ipcRenderer.invoke('snowconfig:addCommand', presetIndex, command),
  removeCommand: (presetIndex: number, index: number): Promise<SnowconfigResult> =>
    ipcRenderer.invoke('snowconfig:removeCommand', presetIndex, index),
  setStartupCommand: (presetIndex: number, command: string): Promise<SnowconfigResult> =>
    ipcRenderer.invoke('snowconfig:setStartupCommand', presetIndex, command),
  addSplit: (presetIndex: number, name: string): Promise<SnowconfigResult> =>
    ipcRenderer.invoke('snowconfig:addSplit', presetIndex, name),
  removeSplit: (presetIndex: number): Promise<SnowconfigResult> =>
    ipcRenderer.invoke('snowconfig:removeSplit', presetIndex),
  chooseDir: (): Promise<string | null> => ipcRenderer.invoke('snowconfig:chooseDir'),
  setTheme: (theme: string): Promise<SnowconfigResult> =>
    ipcRenderer.invoke('snowconfig:setTheme', theme),
  setTourSeen: (): Promise<SnowconfigResult> => ipcRenderer.invoke('snowconfig:setTourSeen'),
  setLayout: (patch: Partial<Layout>): Promise<SnowconfigResult> =>
    ipcRenderer.invoke('snowconfig:setLayout', patch),
  onChanged: (callback: (result: SnowconfigResult) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, result: SnowconfigResult): void => callback(result)
    ipcRenderer.on('snowconfig:changed', listener)
    return () => ipcRenderer.removeListener('snowconfig:changed', listener)
  }
}

const api = { terminal, browser, git, workflow, theme, snowignore, snowconfig }

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
