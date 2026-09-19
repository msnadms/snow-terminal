import { ipcMain } from 'electron'
import { collapseHome, expandHome, samePath } from './config'
import {
  defaultBranch,
  errorDetail,
  errorText,
  gitFor,
  mainWorktreeRoot,
  worktreeMap
} from './gitCore'
import { describeSessionComparisons } from './overlaps'
import { markerPrefix, newestStash, stashEntries, switchBranch, unparkBranch } from './park'
import {
  addRecord,
  readRecords,
  recordsFor,
  removeRecord,
  setWorktree,
  workflowsPath,
  type WorkflowRecord
} from './registry'
import { withRepoLock } from './repoLock'
import { withSharedStashLock } from './stashLock'
import { describeRepo, describeWorkflows, emptyList } from './workflowDescribe'
import type {
  WorkflowList,
  WorkflowOverview,
  WorkflowResult,
  WorkflowSessionComparison
} from './workflowTypes'
import {
  closedTerminals,
  occupiedWorktree,
  removeLinkedWorktree,
  stillLinked,
  worktreeDirectory
} from './worktrees'

function recordFor(records: WorkflowRecord[], branch: string): WorkflowRecord | undefined {
  return records.find((record) => record.branch === branch)
}

function failed(error: unknown): WorkflowResult {
  return { ok: false, error: errorText(error), detail: errorDetail(error) }
}

export function registerWorkflowHandlers(): void {
  ipcMain.handle(
    'workflow:list',
    async (_event, cwd?: string, detail?: boolean): Promise<WorkflowList> => {
      const repo = await mainWorktreeRoot(cwd)
      if (!repo) return emptyList()
      const { records, error } = recordsFor(repo)
      return describeWorkflows(cwd, repo, records, error, detail === true)
    }
  )

  ipcMain.handle(
    'workflow:overview',
    async (_event, detail?: boolean, directories: string[] = []): Promise<WorkflowOverview> => {
      const { records, error } = readRecords()
      const comparisons = detail
        ? describeSessionComparisons(directories)
        : Promise.resolve<WorkflowSessionComparison[]>([])
      if (error) return { repos: [], comparisons: await comparisons, error }

      const roots: string[] = []
      for (const record of records) {
        const absolute = expandHome(record.repo)
        if (!roots.some((known) => samePath(known, absolute))) roots.push(absolute)
      }

      const [repos, compared] = await Promise.all([
        Promise.all(roots.map((root) => describeRepo(root, records, detail === true))),
        comparisons
      ])
      return {
        repos: repos.sort((a, b) => a.name.localeCompare(b.name)),
        comparisons: compared,
        error: null
      }
    }
  )

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
          return failed(error)
        }
      }
      if (!name) return { ok: false, error: 'HEAD is detached' }

      const failure = addRecord(repo, name)
      if (failure)
        return { ok: false, error: `Could not update ${workflowsPath()}`, detail: failure }
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
      if (registeredWorktree && (await stillLinked(repo, name, expandHome(registeredWorktree))))
        return {
          ok: false,
          error: `Remove ${name}'s workspace before removing its workspace record`
        }

      const failure = removeRecord(repo, name)
      if (failure)
        return { ok: false, error: `Could not update ${workflowsPath()}`, detail: failure }
      return { ok: true, branch: name }
    }
  )

  ipcMain.handle(
    'workflow:switch',
    async (_event, cwd: string | undefined, branch: string): Promise<WorkflowResult> => {
      const name = (branch ?? '').trim()
      if (!name) return { ok: false, error: 'Workflow required' }
      return withRepoLock(cwd, () => switchBranch(cwd, name, (git) => git.checkout(name))).catch(
        failed
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

      return withRepoLock(cwd, async (): Promise<WorkflowResult> => {
        try {
          const existing = await gitFor(cwd).branchLocal()
          if (existing.all.includes(name)) return { ok: false, error: 'Branch already exists' }
        } catch (error) {
          return failed(error)
        }

        const destination = worktreeDirectory(repo, name)
        const blocked = await occupiedWorktree(destination, name, 'create')
        if (blocked) return blocked

        const target = await defaultBranch(cwd)
        const base = target ? `${target.remote}/${target.branch}` : 'HEAD'

        try {
          await gitFor(cwd).raw(['worktree', 'add', '-b', name, '--no-track', destination, base])
        } catch (error) {
          return failed(error)
        }

        const failure = addRecord(repo, name, destination)
        if (failure)
          return {
            ok: false,
            error: `Created ${name}'s workspace, but could not register it in ${workflowsPath()}`,
            detail: failure,
            worktree: destination
          }

        return { ok: true, branch: name, worktree: destination }
      }).catch(failed)
    }
  )

  ipcMain.handle(
    'workflow:promote',
    async (_event, cwd: string | undefined, branch: string): Promise<WorkflowResult> => {
      const name = (branch ?? '').trim()
      if (!name) return { ok: false, error: 'Workflow required' }

      return withRepoLock(cwd, async (): Promise<WorkflowResult> => {
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

        const destination = worktreeDirectory(repo, name)
        const blocked = await occupiedWorktree(destination, name, 'open')
        if (blocked) return blocked

        let created = false
        try {
          await gitFor(cwd).raw(['worktree', 'add', destination, name])
          created = true
          await withSharedStashLock(destination, async () => {
            const entry = newestStash(await stashEntries(destination), name)
            if (!entry) return
            try {
              await gitFor(destination).raw(['stash', 'pop', '--index', entry.selector])
            } catch (error) {
              if (!/conflicts in index\. Try without --index/i.test(errorText(error))) throw error
              await gitFor(destination).raw(['stash', 'pop', entry.selector])
            }
          })
        } catch (error) {
          if (!created) return failed(error)
          const failure = setWorktree(repo, name, destination)
          return {
            ok: false,
            error: errorText(error),
            detail: [
              errorDetail(error),
              failure
                ? `The worktree was created but could not be registered: ${failure}`
                : `The worktree was created at ${collapseHome(destination)}. Open it to resolve the problem.`
            ].join('\n\n'),
            worktree: destination
          }
        }

        const failure = setWorktree(repo, name, destination)
        if (failure) {
          return {
            ok: false,
            error: `Created ${name}'s worktree, but could not update ${workflowsPath()}`,
            detail: failure,
            worktree: destination
          }
        }
        return { ok: true, branch: name, worktree: destination }
      }).catch(failed)
    }
  )

  ipcMain.handle(
    'workflow:demote',
    async (_event, cwd: string | undefined, branch: string): Promise<WorkflowResult> => {
      const name = (branch ?? '').trim()
      if (!name) return { ok: false, error: 'Workflow required' }

      return withRepoLock(cwd, async (): Promise<WorkflowResult> => {
        const repo = await mainWorktreeRoot(cwd)
        if (!repo) return { ok: false, error: 'Not a git repository' }
        const { records, error } = recordsFor(repo)
        if (error) return { ok: false, error: `Could not read ${workflowsPath()}`, detail: error }
        const record = recordFor(records, name)
        const directory = record?.worktree ? expandHome(record.worktree) : null
        if (!record || !directory) return { ok: false, error: `${name} is not a worktree workflow` }

        let parked = false
        try {
          const status = await gitFor(directory).status()
          if (status.conflicted.length > 0) {
            return {
              ok: false,
              error: `Resolve conflicts in ${name} before removing its workspace`,
              detail: status.conflicted.join('\n')
            }
          }
          if (status.files.length > 0) {
            await withSharedStashLock(directory, () =>
              gitFor(directory).raw(['stash', 'push', '-u', '-m', `${markerPrefix}${name}`])
            )
            parked = true
          }
          await removeLinkedWorktree(repo, name, directory)
        } catch (error) {
          const terminalsClosed = closedTerminals(error)
          if (await stillLinked(repo, name, directory)) {
            const unpark = parked ? await unparkBranch(directory, name) : null
            return {
              ok: false,
              error: errorText(error),
              detail: [
                errorDetail(error),
                parked && !unpark
                  ? `\n${name}'s worktree is untouched and its changes have been put back.`
                  : '',
                unpark
                  ? `\n${name}'s worktree is untouched, but its changes could not be taken back out of the stash: ${unpark}\nRecover them in ${collapseHome(directory)} with: git stash pop`
                  : '',
                terminalsClosed
                  ? `\nIts terminals were closed to try to free the directory. Launch ${name} again to reopen them.`
                  : ''
              ]
                .filter(Boolean)
                .join('\n'),
              worktree: terminalsClosed ? directory : undefined
            }
          }

          const failure = setWorktree(repo, name, null)
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
              failure ? `\nCould not update ${workflowsPath()}: ${failure}` : ''
            ]
              .filter(Boolean)
              .join('\n'),
            worktree: terminalsClosed ? directory : undefined
          }
        }

        const failure = setWorktree(repo, name, null)
        if (failure)
          return {
            ok: false,
            error: `Stopped ${name}'s worktree, but could not update ${workflowsPath()}`,
            detail: failure,
            worktree: directory
          }
        return { ok: true, branch: name, worktree: directory }
      }).catch(failed)
    }
  )

  ipcMain.handle(
    'workflow:removeWorktree',
    async (_event, cwd: string | undefined, directory: string): Promise<WorkflowResult> => {
      const target = (directory ?? '').trim()
      if (!target) return { ok: false, error: 'Worktree required' }

      return withRepoLock(cwd, async (): Promise<WorkflowResult> => {
        const repo = await mainWorktreeRoot(cwd)
        if (!repo) return { ok: false, error: 'Not a git repository' }
        if (samePath(target, repo))
          return { ok: false, error: 'That is the repository itself, not a linked worktree' }

        const { records, error } = recordsFor(repo)
        if (error) return { ok: false, error: `Could not read ${workflowsPath()}`, detail: error }
        const owner = records.find(
          (record) => record.worktree && samePath(expandHome(record.worktree), target)
        )
        if (owner)
          return {
            ok: false,
            error: `${owner.branch} is a registered workspace`,
            detail: 'Remove its workspace instead, so its uncommitted work is parked first.'
          }

        const [worktrees, changed] = await Promise.all([
          worktreeMap(repo),
          gitFor(target)
            .status()
            .then((status) => status.files.length)
            .catch(() => 0)
        ])
        const branch = [...worktrees].find(([, dir]) => samePath(dir, target))?.[0]
        if (!branch)
          return { ok: false, error: 'That directory is not a linked worktree of this repository' }

        if (changed > 0)
          return {
            ok: false,
            error: `${branch}'s worktree has uncommitted changes`,
            detail: `${changed} changed file${changed === 1 ? '' : 's'} in ${collapseHome(target)}.\nsnow does not park work it was never asked to track - commit or discard it first.`
          }

        try {
          await removeLinkedWorktree(repo, branch, target)
        } catch (err) {
          const terminalsClosed = closedTerminals(err)
          return {
            ok: false,
            error: errorText(err),
            detail: [
              errorDetail(err),
              terminalsClosed
                ? `\nIts terminals were closed to try to free ${collapseHome(target)}.`
                : ''
            ]
              .filter(Boolean)
              .join('\n'),
            worktree: terminalsClosed ? target : undefined
          }
        }
        return { ok: true, branch, worktree: target }
      }).catch(failed)
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
            const failure = setWorktree(repo, record.branch, null)
            if (failure) throw new Error(failure)
          }
        }
      })
      return { ok: true }
    } catch (error) {
      return failed(error)
    }
  })
}
