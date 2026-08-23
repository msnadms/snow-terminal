import { ipcMain } from 'electron'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import {
  defaultBranch,
  errorDetail,
  errorText,
  gitFor,
  isStaged,
  markerPrefix,
  newestStash,
  parkedFiles,
  stashEntries,
  switchBranch,
  unparkBranch,
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
  /** Marker stashes on this branch. More than one means an earlier pop conflicted and was kept. */
  count: number
}

/** Review state for a workflow that has a working tree to report on, from `detail` reads only. */
export interface WorkflowReview {
  changed: number
  staged: number
  ahead: number | null
}

export interface WorkflowEntry {
  branch: string
  current: boolean
  exists: boolean
  parked: WorkflowParked | null
  worktree?: string
  worktreeExists?: boolean
  worktreeLinked?: boolean
  review?: WorkflowReview
}

export interface WorkflowList {
  /** The main worktree root, so a renderer can tell whether a `git:changed` is worth reloading for. */
  repo: string | null
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

/**
 * Sanitizing collapses distinct branches onto one directory - `feature/login` and `feature-login`
 * both want `feature-login`. A short digest of the original name, added only when sanitizing
 * actually changed something, keeps them apart while leaving path-safe branches reading plainly.
 */
function worktreeDirectory(repo: string, branch: string): string {
  const safeBranch = branch.replace(/[\\/:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow'
  const suffix =
    safeBranch === branch ? '' : `-${createHash('sha1').update(branch).digest('hex').slice(0, 7)}`
  return path.join(worktreeContainer(repo), `${safeBranch}${suffix}`)
}

function recordFor(records: WorkflowRecord[], branch: string): WorkflowRecord | undefined {
  return records.find((record) => record.branch === branch)
}

async function stillLinked(repo: string, branch: string, directory: string): Promise<boolean> {
  const linked = (await worktreeMap(repo)).get(branch)
  return !!linked && samePath(linked, directory)
}

function emptyList(error: string | null = null, repo: string | null = null): WorkflowList {
  return { repo, current: null, defaultBranch: null, workflows: [], error }
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

async function aheadOf(directory: string, bases: string[]): Promise<number | null> {
  for (const base of bases) {
    try {
      const raw = await gitFor(directory).raw(['rev-list', '--count', `${base}..HEAD`])
      const value = Number(raw.trim())
      if (Number.isFinite(value)) return value
    } catch {
      continue
    }
  }
  return null
}

/**
 * `status.ahead` counts against the branch's upstream, which `workflow:create` deliberately does not
 * set (`--no-track`), so review distance is measured against the default branch instead - the remote
 * ref first, then the local one for a repo with no remote.
 */
async function reviewOf(directory: string, bases: string[]): Promise<WorkflowReview | null> {
  try {
    const status = await gitFor(directory).status()
    return {
      changed: status.files.length,
      staged: status.files.filter((file) => isStaged(file.index)).length,
      ahead: await aheadOf(directory, bases)
    }
  } catch {
    return null
  }
}

async function describeWorkflows(
  cwd: string | undefined,
  repo: string | null,
  records: WorkflowRecord[],
  error: string | null,
  detail = false
): Promise<WorkflowList> {
  const [summary, entries, target, checkedOut] = await Promise.all([
    gitFor(cwd)
      .branchLocal()
      .catch(() => null),
    stashEntries(cwd),
    defaultBranch(cwd, false),
    worktreeMap(cwd)
  ])
  if (!summary) return emptyList(error, repo)

  const current = summary.current || null
  const bases = target ? [`${target.remote}/${target.branch}`, target.branch] : []
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
      const reviewDir =
        absoluteWorktree && worktreeExists && worktreeLinked !== false
          ? absoluteWorktree
          : branch === current
            ? (repo ?? cwd ?? null)
            : null
      return {
        branch,
        current: branch === current,
        exists: summary.all.includes(branch),
        parked: entry
          ? {
              files: await parkedFiles(cwd, entry.selector),
              date: entry.date,
              count: entries.filter((candidate) => candidate.branch === branch).length
            }
          : null,
        worktree: absoluteWorktree,
        worktreeExists,
        worktreeLinked,
        review: detail && reviewDir ? ((await reviewOf(reviewDir, bases)) ?? undefined) : undefined
      }
    })
  )

  return { repo, current, defaultBranch: target?.branch ?? null, workflows, error }
}

async function describeRepo(
  repo: string,
  records: WorkflowRecord[],
  detail: boolean
): Promise<WorkflowRepo> {
  const root = await mainWorktreeRoot(repo)
  if (root)
    return {
      name: path.basename(root),
      unreachable: false,
      ...(await describeWorkflows(root, root, filterByRepo(records, root), null, detail)),
      repo: root
    }

  return {
    name: path.basename(repo),
    unreachable: true,
    ...emptyList(null, repo),
    workflows: filterByRepo(records, repo).map(missingEntry),
    repo
  }
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
    async (_event, detail?: boolean): Promise<WorkflowOverview> => {
      const { records, error } = readRecords()
      if (error) return { repos: [], error }

      const roots: string[] = []
      for (const record of records) {
        const absolute = expandHome(record.repo)
        if (!roots.some((known) => samePath(known, absolute))) roots.push(absolute)
      }

      const repos = await Promise.all(
        roots.map((root) => describeRepo(root, records, detail === true))
      )
      return { repos: repos.sort((a, b) => a.name.localeCompare(b.name)), error: null }
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
      if (registeredWorktree && (await stillLinked(repo, name, expandHome(registeredWorktree))))
        return {
          ok: false,
          error: `Stop ${name}'s parallel session before removing it from workflows`
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
            error: `${name}'s worktree directory already has files in it`,
            detail: [
              collapseHome(destination),
              '',
              `snow will not check ${name} out over it. Move or delete that directory, then start the parallel session again.`
            ].join('\n')
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
            await gitFor(directory).raw(['stash', 'push', '-u', '-m', `${markerPrefix}${name}`])
            parked = true
          }
          // Removal deletes the directory whole, ignored files included, with or without --force;
          // the renderer confirms that. --force covers what the stash above could not take.
          //
          // Run from the main worktree: invoking this from the target worktree itself also keeps
          // that directory as Git's current working directory, which prevents its removal on Windows.
          //
          // Try once with the session still running. Killing the user's shells is the destructive
          // part of stopping a workflow and it is only needed on Windows, where an open shell holds
          // the directory - so it is worth finding out whether removal needs it before paying it.
          try {
            await gitFor(repo).raw(['worktree', 'remove', '--force', directory])
          } catch (first) {
            if (!(await stillLinked(repo, name, directory))) throw first
            await closePtysInDirectory(directory)
            terminalsClosed = true
            await gitFor(repo).raw(['worktree', 'remove', '--force', directory])
          }
          if (samePath(path.dirname(directory), worktreeContainer(repo)))
            await fs.promises.rmdir(worktreeContainer(repo)).catch(() => {})
        } catch (error) {
          // `worktree remove` deletes its bookkeeping even when it cannot delete every file, and
          // says so: "there's no going back from here". Retrying then only ever reports "is not a
          // working tree", so the registry entry has to be cleared here or the workflow is stranded.
          if (await stillLinked(repo, name, directory)) {
            // Nothing was removed, so the park has to come back out: leaving the session's work in
            // the stash would empty a worktree that is still very much alive.
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
