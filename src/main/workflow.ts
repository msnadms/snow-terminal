import { ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  defaultBranch,
  errorDetail,
  errorText,
  gitFor,
  newestStash,
  parkedFiles,
  stashEntries,
  switchBranch,
  withRepoLock,
  mainWorktreeRoot,
  worktreeMap,
  type GitCheckoutResult
} from './git'
import { collapseHome, expandHome, samePath } from './config'
import { closePtysInDirectory } from './pty'
import {
  addRecord,
  filterByRepo,
  readRecords,
  recordsFor,
  removeRecord,
  setWorktree,
  workflowsPath,
  type WorkflowRecord
} from './registry'

export interface WorkflowParked {
  files: number | null
  date: string
}

export interface WorkflowEntry {
  branch: string
  current: boolean
  exists: boolean
  parked: WorkflowParked | null
  worktree?: string
  worktreeExists?: boolean
  worktreeLinked?: boolean
}

export interface WorkflowList {
  current: string | null
  defaultBranch: string | null
  workflows: WorkflowEntry[]
  error: string | null
}

export interface WorkflowRepo extends WorkflowList {
  repo: string
  name: string
  unreachable: boolean
}

export interface WorkflowOverview {
  repos: WorkflowRepo[]
  error: string | null
}

export type WorkflowResult = GitCheckoutResult & { worktree?: string }

function worktreeContainer(repo: string): string {
  return path.join(path.dirname(repo), `${path.basename(repo)}-worktrees`)
}

function worktreeDirectory(repo: string, branch: string): string {
  const safeBranch = branch.replace(/[\\/:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow'
  return path.join(worktreeContainer(repo), safeBranch)
}

function recordFor(records: WorkflowRecord[], branch: string): WorkflowRecord | undefined {
  return records.find((record) => record.branch === branch)
}

function emptyList(error: string | null = null): WorkflowList {
  return { current: null, defaultBranch: null, workflows: [], error }
}

function missingEntry({ branch, worktree }: WorkflowRecord): WorkflowEntry {
  return {
    branch,
    current: false,
    exists: false,
    parked: null,
    worktree: worktree ? expandHome(worktree) : undefined,
    worktreeExists: worktree ? false : undefined,
    worktreeLinked: worktree ? false : undefined
  }
}

async function describeWorkflows(
  cwd: string | undefined,
  records: WorkflowRecord[],
  error: string | null
): Promise<WorkflowList> {
  const [summary, entries, target, checkedOut] = await Promise.all([
    gitFor(cwd)
      .branchLocal()
      .catch(() => null),
    stashEntries(cwd),
    defaultBranch(cwd, false),
    worktreeMap(cwd)
  ])
  if (!summary) return emptyList(error)

  const current = summary.current || null
  const workflows = await Promise.all(
    records.map(async ({ branch, worktree }): Promise<WorkflowEntry> => {
      const entry = newestStash(entries, branch)
      const absoluteWorktree = worktree ? expandHome(worktree) : undefined
      const worktreeExists = absoluteWorktree
        ? await fs.promises
            .access(absoluteWorktree)
            .then(() => true)
            .catch(() => false)
        : undefined
      const linked = checkedOut.get(branch)
      const worktreeLinked = absoluteWorktree
        ? !!linked && samePath(linked, absoluteWorktree)
        : undefined
      return {
        branch,
        current: branch === current,
        exists: summary.all.includes(branch),
        parked: entry ? { files: await parkedFiles(cwd, entry.selector), date: entry.date } : null,
        worktree: absoluteWorktree,
        worktreeExists,
        worktreeLinked
      }
    })
  )

  return { current, defaultBranch: target?.branch ?? null, workflows, error }
}

async function describeRepo(repo: string, records: WorkflowRecord[]): Promise<WorkflowRepo> {
  const root = await mainWorktreeRoot(repo)
  if (root)
    return {
      repo: root,
      name: path.basename(root),
      unreachable: false,
      ...(await describeWorkflows(root, filterByRepo(records, root), null))
    }

  return {
    repo,
    name: path.basename(repo),
    unreachable: true,
    ...emptyList(),
    workflows: filterByRepo(records, repo).map(missingEntry)
  }
}

export function registerWorkflowHandlers(): void {
  ipcMain.handle('workflow:list', async (_event, cwd?: string): Promise<WorkflowList> => {
    const repo = await mainWorktreeRoot(cwd)
    if (!repo) return emptyList()
    const { records, error } = recordsFor(repo)
    return describeWorkflows(cwd, records, error)
  })

  ipcMain.handle('workflow:overview', async (): Promise<WorkflowOverview> => {
    const { records, error } = readRecords()
    if (error) return { repos: [], error }

    const roots: string[] = []
    for (const record of records) {
      const absolute = expandHome(record.repo)
      if (!roots.some((known) => samePath(known, absolute))) roots.push(absolute)
    }

    const repos = await Promise.all(roots.map((root) => describeRepo(root, records)))
    return { repos: repos.sort((a, b) => a.name.localeCompare(b.name)), error: null }
  })

  ipcMain.handle(
    'workflow:register',
    async (_event, cwd: string | undefined, branch?: string): Promise<WorkflowResult> => {
      const repo = await mainWorktreeRoot(cwd)
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

      const repo = await mainWorktreeRoot(cwd)
      if (!repo) return { ok: false, error: 'Not a git repository' }

      const { records, error } = recordsFor(repo)
      if (error) return { ok: false, error: `Could not read ${workflowsPath()}`, detail: error }
      const registeredWorktree = recordFor(records, name)?.worktree
      if (registeredWorktree) {
        const linked = (await worktreeMap(cwd)).get(name)
        if (linked && samePath(linked, expandHome(registeredWorktree)))
          return {
            ok: false,
            error: `Stop ${name}'s parallel session before removing it from workflows`
          }
      }

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
      return withRepoLock(cwd, () => switchBranch(cwd, name, (git) => git.checkout(name))).catch(
        (error) => ({ ok: false, error: errorText(error), detail: errorDetail(error) })
      )
    }
  )

  ipcMain.handle(
    'workflow:create',
    async (_event, cwd: string | undefined, branch: string): Promise<WorkflowResult> => {
      const name = (branch ?? '').trim()
      if (!name) return { ok: false, error: 'Workflow name required' }

      const repo = await mainWorktreeRoot(cwd)
      if (!repo) return { ok: false, error: 'Not a git repository' }

      return withRepoLock(cwd, async () => {
        try {
          const existing = await gitFor(cwd).branchLocal()
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
      }).catch((error) => ({ ok: false, error: errorText(error), detail: errorDetail(error) }))
    }
  )

  ipcMain.handle(
    'workflow:promote',
    async (_event, cwd: string | undefined, branch: string): Promise<WorkflowResult> => {
      const name = (branch ?? '').trim()
      if (!name) return { ok: false, error: 'Workflow required' }

      return withRepoLock(cwd, async () => {
        const repo = await mainWorktreeRoot(cwd)
        if (!repo) return { ok: false, error: 'Not a git repository' }
        const { records, error } = recordsFor(repo)
        if (error) return { ok: false, error: `Could not read ${workflowsPath()}`, detail: error }
        const record = recordFor(records, name)
        if (!record) return { ok: false, error: `${name} is not a registered workflow` }
        if (record.worktree)
          return {
            ok: false,
            error: `${name} already runs in a worktree`,
            worktree: expandHome(record.worktree)
          }

        const checkedOut = await worktreeMap(cwd)
        const active = checkedOut.get(name)
        if (active && samePath(active, repo)) {
          return {
            ok: false,
            error: `Cannot run ${name} in parallel while it is checked out in the main worktree`,
            detail: 'Switch the main session to another branch first.'
          }
        }
        if (active)
          return {
            ok: false,
            error: `${name} is already checked out`,
            detail: collapseHome(active)
          }

        // `git worktree add` happily checks out into an existing *empty* directory - only a
        // non-empty one is actually a conflict (e.g. a previous `remove` that unregistered the
        // worktree but couldn't delete a locked file). An empty leftover is common: `remove`
        // deletes its own directory tree but can still leave an empty parent behind on Windows.
        const destination = worktreeDirectory(repo, name)
        const remaining = await fs.promises
          .readdir(destination)
          .catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))
        if (remaining.length > 0) {
          return {
            ok: false,
            error: 'Worktree directory already exists',
            detail: collapseHome(destination)
          }
        }

        let created = false
        try {
          await gitFor(cwd).raw(['worktree', 'add', destination, name])
          created = true
          const entry = newestStash(await stashEntries(destination), name)
          if (entry) await gitFor(destination).raw(['stash', 'pop', entry.selector])
        } catch (error) {
          if (created) {
            const failed = setWorktree(repo, name, destination)
            return {
              ok: false,
              error: errorText(error),
              detail: [
                errorDetail(error),
                failed
                  ? `The worktree was created but could not be registered: ${failed}`
                  : `The worktree was created at ${collapseHome(destination)}. Open it to resolve the problem.`
              ].join('\n\n'),
              worktree: destination
            }
          }
          return { ok: false, error: errorText(error), detail: errorDetail(error) }
        }

        const failed = setWorktree(repo, name, destination)
        if (failed) {
          return {
            ok: false,
            error: `Created ${name}'s worktree, but could not update ${workflowsPath()}`,
            detail: failed,
            worktree: destination
          }
        }
        return { ok: true, branch: name, worktree: destination }
      }).catch((error) => ({ ok: false, error: errorText(error), detail: errorDetail(error) }))
    }
  )

  ipcMain.handle(
    'workflow:demote',
    async (_event, cwd: string | undefined, branch: string): Promise<WorkflowResult> => {
      const name = (branch ?? '').trim()
      if (!name) return { ok: false, error: 'Workflow required' }

      return withRepoLock(cwd, async () => {
        const repo = await mainWorktreeRoot(cwd)
        if (!repo) return { ok: false, error: 'Not a git repository' }
        const { records, error } = recordsFor(repo)
        if (error) return { ok: false, error: `Could not read ${workflowsPath()}`, detail: error }
        const record = recordFor(records, name)
        const directory = record?.worktree ? expandHome(record.worktree) : null
        if (!record || !directory) return { ok: false, error: `${name} is not a worktree workflow` }

        let terminalsClosed = false
        let parked = false
        try {
          const status = await gitFor(directory).status()
          if (status.conflicted.length > 0) {
            return {
              ok: false,
              error: `Resolve conflicts in ${name} before stopping its parallel session`,
              detail: status.conflicted.join('\n')
            }
          }
          if (status.files.length > 0) {
            await gitFor(directory).raw(['stash', 'push', '-u', '-m', `snow-wf:${name}`])
            parked = true
          }
          // Removal deletes the directory whole, ignored files included, with or without --force;
          // the renderer confirms that. --force covers what the stash above could not take.
          await closePtysInDirectory(directory)
          terminalsClosed = true
          // Run from the main worktree: invoking this from the target worktree itself also keeps
          // that directory as Git's current working directory, which prevents its removal on Windows.
          await gitFor(repo).raw(['worktree', 'remove', '--force', directory])
          if (samePath(path.dirname(directory), worktreeContainer(repo)))
            await fs.promises.rmdir(worktreeContainer(repo)).catch(() => {})
        } catch (error) {
          // `worktree remove` deletes its bookkeeping even when it cannot delete every file, and
          // says so: "there's no going back from here". Retrying then only ever reports "is not a
          // working tree", so the registry entry has to be cleared here or the workflow is stranded.
          const linked = (await worktreeMap(repo)).get(name)
          if (linked && samePath(linked, directory)) {
            return {
              ok: false,
              error: errorText(error),
              detail: errorDetail(error),
              worktree: terminalsClosed ? directory : undefined
            }
          }

          const failed = setWorktree(repo, name, null)
          return {
            ok: false,
            error: `Released ${name}'s worktree, but could not delete its directory`,
            detail: [
              errorDetail(error),
              '',
              `Git has already released the worktree, so ${name} is a normal workflow again${
                parked ? ', and its changes are parked in the stash' : ''
              }.`,
              `${collapseHome(directory)} still holds files snow could not delete - a program may still have them open. Delete it by hand once it is free.`,
              failed ? `\nCould not update ${workflowsPath()}: ${failed}` : ''
            ]
              .filter(Boolean)
              .join('\n'),
            worktree: terminalsClosed ? directory : undefined
          }
        }

        const failed = setWorktree(repo, name, null)
        if (failed)
          return {
            ok: false,
            error: `Stopped ${name}'s worktree, but could not update ${workflowsPath()}`,
            detail: failed,
            worktree: directory
          }
        return { ok: true, branch: name, worktree: directory }
      }).catch((error) => ({ ok: false, error: errorText(error), detail: errorDetail(error) }))
    }
  )

  ipcMain.handle('workflow:prune', async (_event, cwd?: string): Promise<WorkflowResult> => {
    try {
      await withRepoLock(cwd, async () => {
        await gitFor(cwd).raw(['worktree', 'prune'])
        const repo = await mainWorktreeRoot(cwd)
        if (!repo) return
        const { records, error } = recordsFor(repo)
        if (error) throw new Error(error)
        const live = await worktreeMap(cwd)
        for (const record of records) {
          if (record.worktree && !live.has(record.branch)) {
            const failed = setWorktree(repo, record.branch, null)
            if (failed) throw new Error(failed)
          }
        }
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: errorText(error), detail: errorDetail(error) }
    }
  })
}
