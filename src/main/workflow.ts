import { ipcMain } from 'electron'
import {
  defaultBranch,
  errorDetail,
  errorText,
  gitFor,
  newestStash,
  parkedFiles,
  stashEntries,
  switchBranch,
  worktreeRoot,
  type GitCheckoutResult
} from './git'
import { addRecord, registeredFor, removeRecord, workflowsPath } from './registry'

export interface WorkflowParked {
  files: number | null
  date: string
}

export interface WorkflowEntry {
  branch: string
  current: boolean
  exists: boolean
  parked: WorkflowParked | null
}

export interface WorkflowList {
  current: string | null
  defaultBranch: string | null
  workflows: WorkflowEntry[]
  error: string | null
}

export type WorkflowResult = GitCheckoutResult

export function registerWorkflowHandlers(): void {
  ipcMain.handle('workflow:list', async (_event, cwd?: string): Promise<WorkflowList> => {
    const empty: WorkflowList = {
      current: null,
      defaultBranch: null,
      workflows: [],
      error: null
    }

    const repo = await worktreeRoot(cwd)
    if (!repo) return empty

    const { branches: registered, error } = registeredFor(repo)

    const [summary, entries, target] = await Promise.all([
      gitFor(cwd)
        .branchLocal()
        .catch(() => null),
      stashEntries(cwd),
      defaultBranch(cwd, false)
    ])
    if (!summary) return { ...empty, error }

    const current = summary.current || null
    const workflows = await Promise.all(
      registered.map(async (branch): Promise<WorkflowEntry> => {
        const entry = newestStash(entries, branch)
        return {
          branch,
          current: branch === current,
          exists: summary.all.includes(branch),
          parked: entry ? { files: await parkedFiles(cwd, entry.selector), date: entry.date } : null
        }
      })
    )

    return { current, defaultBranch: target?.branch ?? null, workflows, error }
  })

  ipcMain.handle(
    'workflow:register',
    async (_event, cwd: string | undefined, branch?: string): Promise<WorkflowResult> => {
      const repo = await worktreeRoot(cwd)
      if (!repo) return { ok: false, error: 'Not a git repository' }

      let name = (branch ?? '').trim()
      if (!name) {
        try {
          name = (await gitFor(cwd).status()).current ?? ''
        } catch (error) {
          return { ok: false, error: errorText(error), detail: errorDetail(error) }
        }
      }
      if (!name) return { ok: false, error: 'HEAD is detached' }

      const failed = addRecord(repo, name)
      if (failed) return { ok: false, error: `Could not update ${workflowsPath()}`, detail: failed }
      return { ok: true, branch: name }
    }
  )

  ipcMain.handle(
    'workflow:unregister',
    async (_event, cwd: string | undefined, branch: string): Promise<WorkflowResult> => {
      const name = (branch ?? '').trim()
      if (!name) return { ok: false, error: 'Workflow required' }

      const repo = await worktreeRoot(cwd)
      if (!repo) return { ok: false, error: 'Not a git repository' }

      const failed = removeRecord(repo, name)
      if (failed) return { ok: false, error: `Could not update ${workflowsPath()}`, detail: failed }
      return { ok: true, branch: name }
    }
  )

  ipcMain.handle(
    'workflow:switch',
    async (_event, cwd: string | undefined, branch: string): Promise<WorkflowResult> => {
      const name = (branch ?? '').trim()
      if (!name) return { ok: false, error: 'Workflow required' }
      return switchBranch(cwd, name, (git) => git.checkout(name))
    }
  )

  ipcMain.handle(
    'workflow:create',
    async (_event, cwd: string | undefined, branch: string): Promise<WorkflowResult> => {
      const name = (branch ?? '').trim()
      if (!name) return { ok: false, error: 'Workflow name required' }

      const repo = await worktreeRoot(cwd)
      if (!repo) return { ok: false, error: 'Not a git repository' }

      const git = gitFor(cwd)
      try {
        const existing = await git.branchLocal()
        if (existing.all.includes(name)) return { ok: false, error: 'Branch already exists' }
      } catch (error) {
        return { ok: false, error: errorText(error), detail: errorDetail(error) }
      }

      const target = await defaultBranch(cwd)
      const base = target ? `${target.remote}/${target.branch}` : 'HEAD'

      const result = await switchBranch(cwd, name, (g) =>
        g.raw(['checkout', '-b', name, '--no-track', base])
      )
      if (!result.ok) return result

      const failed = addRecord(repo, name)
      if (failed)
        return {
          ...result,
          ok: false,
          error: `Switched to ${name}, but could not register it in ${workflowsPath()}`,
          detail: failed
        }

      return result
    }
  )
}
