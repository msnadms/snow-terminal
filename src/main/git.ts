import { ipcMain } from 'electron'
import fs from 'fs'
import path from 'path'
import type { SimpleGit, StatusResult } from 'simple-git'
import { filterPaths } from './snowignore'
import { activeCommitAgent } from './snowconfig'
import { samePath } from './config'
import { isExternalUrl } from './external'
import { commitAgentCommand, generateCommitMessage } from './commitMessage'
import { pullRequestUrl, webUrl } from './forge'
import {
  conflictedIn,
  defaultBranch,
  errorDetail,
  errorText,
  fail,
  gitDir,
  gitFor,
  isStaged,
  remoteName,
  strictlyInside,
  worktreeMap,
  worktreeRoot
} from './gitCore'
import { registerHistoryHandlers } from './gitHistory'
import { registerWatchHandlers } from './gitWatch'
import { carryToNewBranch, parkPreview, switchBranch } from './park'
import { withRepoLock } from './repoLock'
import type {
  CommitIgnored,
  GitBranches,
  GitCheckoutResult,
  GitCommitMessageResult,
  GitCommitResult,
  GitFileResult,
  GitPullRequestResult,
  GitStatus,
  GitSyncAction,
  GitSyncDefaultResult,
  GitSyncResult,
  GitUndoResult,
  GitUpdateDefaultResult
} from './gitTypes'

export { disposeGitWatchers } from './gitWatch'

interface BlockedFile {
  path: string
  targets: string[]
}

interface CommitTargets {
  staged: boolean
  targets: string[]
  blocked: BlockedFile[]
}

async function resolveCommitTargets(
  cwd: string | undefined,
  pending: StatusResult
): Promise<CommitTargets | null> {
  const stagedFiles = pending.files.filter((f) => isStaged(f.index))
  const staged = stagedFiles.length > 0
  const scope = (staged ? stagedFiles : pending.files).map((f) => ({
    label: f.from ? `${f.from} -> ${f.path}` : f.path,
    paths: [f.path, f.from].filter((p): p is string => !!p)
  }))
  const keep = new Set(filterPaths(scope.flatMap((f) => f.paths)))

  const allowed: string[] = []
  const refused: typeof scope = []
  for (const file of scope) {
    if (file.paths.every((p) => keep.has(p))) allowed.push(...file.paths)
    else if (staged) refused.push(file)
  }
  if (allowed.length === 0 && !staged) return null

  const root = !staged || refused.length > 0 ? await worktreeRoot(cwd) : null
  const resolve = (p: string): string => (root ? path.join(root, p) : p)

  return {
    staged,
    targets: staged && refused.length === 0 ? [] : allowed.map(resolve),
    blocked: refused.map((f) => ({ path: f.label, targets: f.paths.map(resolve) }))
  }
}

function blockedResult(blocked: BlockedFile[]): GitCommitResult {
  const paths = blocked.map((f) => f.path)
  return {
    ok: false,
    error: `${paths.length} staged file${paths.length === 1 ? ' is' : 's are'} skipped by .snowignore`,
    blocked: paths
  }
}

interface FileTarget {
  rel: string
  full: string
}

async function fileTargets(
  cwd: string | undefined,
  filePath: string,
  oldPath?: string | null
): Promise<FileTarget[] | null> {
  const found = await worktreeRoot(cwd)
  if (!found) return null
  const root = path.resolve(found)
  const targets: FileTarget[] = []

  for (const rel of [filePath, oldPath]) {
    if (!rel) continue
    const full = path.resolve(root, rel)
    if (!strictlyInside(root, full)) return null
    if (targets.some((t) => t.full === full)) continue
    targets.push({ rel, full })
  }

  return targets.length > 0 ? targets : null
}

async function stagedDiff(
  cwd: string | undefined
): Promise<GitCommitMessageResult & { diff?: string }> {
  const git = gitFor(cwd)
  let pending: StatusResult
  try {
    pending = await git.status()
  } catch (error) {
    return fail(error)
  }
  if (pending.conflicted.length > 0) {
    return { ok: false, error: 'Resolve conflicts before generating a message' }
  }

  const resolved = await resolveCommitTargets(cwd, pending)
  if (!resolved) return { ok: false, error: 'Nothing to commit' }
  try {
    if (resolved.staged) {
      const scoped = resolved.blocked.length > 0
      if (scoped && resolved.targets.length === 0) return { ok: false, error: 'Nothing to commit' }
      const range = ['diff', '--cached', '-M', '--no-color']
      if (scoped) range.push('--', ...resolved.targets)
      return { ok: true, diff: await git.raw(range) }
    }
    await git.raw(['add', '-N', '--', ...resolved.targets])
    try {
      return {
        ok: true,
        diff: await git.raw(['diff', '-M', '--no-color', '--', ...resolved.targets])
      }
    } finally {
      await git.raw(['reset', '--', ...resolved.targets]).catch(() => {})
    }
  } catch (error) {
    return fail(error)
  }
}

export function registerGitHandlers(): void {
  registerHistoryHandlers()
  registerWatchHandlers()

  ipcMain.handle('git:status', async (_event, cwd?: string): Promise<GitStatus> => {
    const status = await gitFor(cwd).status()
    let stageable: string[]
    let ignoreError: string | null = null
    try {
      stageable = filterPaths(status.files.map((f) => f.path))
    } catch (error) {
      stageable = []
      ignoreError = errorText(error)
    }
    const keep = new Set(stageable)
    return {
      current: status.current,
      tracking: status.tracking,
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged,
      modified: status.modified,
      not_added: status.not_added,
      conflicted: status.conflicted,
      files: status.files.map((f) => ({
        path: f.path,
        from: f.from ?? null,
        index: f.index,
        working_dir: f.working_dir,
        ignored: !keep.has(f.path)
      })),
      changed: status.files.length,
      stageable: stageable.length,
      stagedCount: status.files.filter((f) => isStaged(f.index)).length,
      ignoreError
    }
  })

  ipcMain.handle('git:branches', async (_event, cwd?: string): Promise<GitBranches> => {
    const git = gitFor(cwd)
    let current: string | null = null
    let branches: string[] = []
    let remotes: string[] = []

    try {
      const summary = await git.branchLocal()
      current = summary.current || null
      branches = summary.all
    } catch {
      return { current: null, branches: [], remotes: [], worktrees: {} }
    }

    try {
      const summary = await git.branch(['-r'])
      remotes = summary.all.filter((name) => !name.includes('->'))
    } catch {
      remotes = []
    }

    const currentRoot = await worktreeRoot(cwd)
    const worktrees = Object.fromEntries(
      [...(await worktreeMap(cwd))].filter(([, dir]) => !currentRoot || !samePath(dir, currentRoot))
    )
    return { current, branches, remotes, worktrees }
  })

  ipcMain.handle('git:defaultBranch', async (_event, cwd?: string): Promise<string | null> => {
    const target = await defaultBranch(cwd, false)
    return target?.branch ?? null
  })

  ipcMain.handle(
    'git:checkout',
    async (_event, cwd: string | undefined, branch: string): Promise<GitCheckoutResult> => {
      if (!branch) return { ok: false, error: 'Branch required' }
      return withRepoLock(cwd, () =>
        switchBranch(cwd, branch, (git) => git.checkout(branch))
      ).catch(fail)
    }
  )

  ipcMain.handle(
    'git:checkoutRemote',
    async (_event, cwd: string | undefined, ref: string): Promise<GitCheckoutResult> => {
      const remoteRef = (ref ?? '').trim()
      if (!remoteRef) return { ok: false, error: 'Branch required' }

      return withRepoLock(cwd, async () => {
        let local: string
        try {
          const remotes = await gitFor(cwd).getRemotes(false)
          const remote = remotes.find((r) => remoteRef.startsWith(`${r.name}/`))
          local = remote ? remoteRef.slice(remote.name.length + 1) : remoteRef
          if (!local) return { ok: false, error: 'Branch required' }
        } catch (error) {
          return { ok: false, error: errorText(error), detail: errorDetail(error) }
        }

        return switchBranch(cwd, local, async (git) => {
          const existing = await git.branchLocal()
          if (existing.all.includes(local)) await git.checkout(local)
          else await git.checkout(['--track', remoteRef])
        })
      }).catch(fail)
    }
  )

  ipcMain.handle(
    'git:createBranch',
    async (
      _event,
      cwd: string | undefined,
      branch: string,
      carry = false
    ): Promise<GitCheckoutResult> => {
      const name = (branch ?? '').trim()
      if (!name) return { ok: false, error: 'Branch name required' }
      return withRepoLock(cwd, () =>
        carry
          ? carryToNewBranch(cwd, name)
          : switchBranch(cwd, name, (git) => git.checkoutLocalBranch(name))
      ).catch(fail)
    }
  )

  ipcMain.handle(
    'git:parkPreview',
    async (_event, cwd?: string): Promise<{ branch: string; files: number } | null> => {
      try {
        return await parkPreview(cwd)
      } catch {
        return null
      }
    }
  )

  ipcMain.handle('git:syncDefault', (_event, cwd?: string): Promise<GitSyncDefaultResult> => {
    return withRepoLock(cwd, async () => {
      const git = gitFor(cwd)
      const target = await defaultBranch(cwd)
      if (!target) return { ok: false, error: 'No default branch on remote' }
      const { remote, branch } = target

      try {
        const status = await git.status()
        if (status.current === branch) {
          await git.raw(['fetch', remote, branch])
          await git.raw(['merge', '--ff-only', `${remote}/${branch}`])
          return { ok: true, branch }
        }
        const checkedOut = await worktreeMap(cwd)
        const targetWorktree = checkedOut.get(branch)
        if (targetWorktree) {
          const targetGit = gitFor(targetWorktree)
          await targetGit.raw(['fetch', remote, branch])
          await targetGit.raw(['merge', '--ff-only', `${remote}/${branch}`])
          return { ok: true, branch }
        }
        await git.raw(['fetch', remote, `${branch}:${branch}`])
      } catch (error) {
        return { ok: false, branch, error: errorText(error), detail: errorDetail(error) }
      }

      const result = await switchBranch(cwd, branch, (g) => g.checkout(branch))
      if (result.ok) return { ok: true, branch }
      const note = result.conflicted
        ? ''
        : `${branch} was updated from ${remote}, but the switch failed.`
      return {
        ok: false,
        branch,
        error: result.error,
        detail: [result.detail, note].filter(Boolean).join('\n\n')
      }
    }).catch(fail)
  })

  ipcMain.handle('git:updateFromDefault', (_event, cwd?: string): Promise<GitUpdateDefaultResult> =>
    withRepoLock(cwd, async () => {
      const git = gitFor(cwd)
      const target = await defaultBranch(cwd)
      if (!target) return { ok: false, error: 'No default branch on remote' }
      const { remote, branch } = target
      const from = `${remote}/${branch}`

      let head: string
      let dirty: string[]
      try {
        const status = await git.status()
        if (!status.current) return { ok: false, error: 'HEAD is detached' }
        dirty = status.files
          .filter((f) => f.index !== '?' || f.working_dir !== '?')
          .map((f) => f.path)
        head = (await git.revparse(['HEAD'])).trim()
      } catch (error) {
        return { ok: false, branch, error: errorText(error), detail: errorDetail(error) }
      }

      if (dirty.length > 0) {
        return {
          ok: false,
          branch,
          from,
          error: 'Commit or stash your changes first',
          detail: dirty.join('\n')
        }
      }

      try {
        await git.raw(['fetch', remote, branch])
      } catch (error) {
        return { ok: false, branch, from, error: errorText(error), detail: errorDetail(error) }
      }

      try {
        await git.raw(['merge', '--no-edit', from])
      } catch (error) {
        const conflicted = await conflictedIn(git)
        if (conflicted.length > 0) {
          return {
            ok: false,
            branch,
            from,
            conflicted,
            error: `Conflicts merging ${from}`,
            detail: [
              'Merge left in progress. Resolve these files, then commit:',
              '',
              ...conflicted,
              '',
              'Or run: git merge --abort'
            ].join('\n')
          }
        }
        return { ok: false, branch, from, error: errorText(error), detail: errorDetail(error) }
      }

      try {
        const after = (await git.revparse(['HEAD'])).trim()
        return { ok: true, branch, from, updated: after !== head }
      } catch {
        return { ok: true, branch, from, updated: true }
      }
    }).catch(fail)
  )

  ipcMain.handle('git:sync', (_event, cwd?: string): Promise<GitSyncResult> => {
    return withRepoLock(cwd, async () => {
      const git = gitFor(cwd)

      let status: StatusResult
      let remote: string | null
      try {
        ;[status, remote] = await Promise.all([git.status(), remoteName(cwd)])
      } catch (error) {
        return fail(error)
      }

      const branch = status.current
      if (!branch) return { ok: false, error: 'HEAD is detached' }
      if (!remote) return { ok: false, branch, error: 'No remote configured' }

      if (status.ahead > 0 && status.behind > 0) {
        return {
          ok: false,
          branch,
          error: `${branch} has diverged from ${status.tracking}`,
          detail: [
            `${branch} is ${status.ahead} ahead and ${status.behind} behind ${status.tracking}.`,
            '',
            'Snow will not pick a merge or a rebase for you. Reconcile it with one of:',
            `  git pull --rebase`,
            `  git merge ${status.tracking}`
          ].join('\n')
        }
      }

      const action: GitSyncAction =
        !status.tracking || status.ahead > 0 ? 'push' : status.behind > 0 ? 'pull' : 'fetch'

      try {
        if (action === 'push') {
          if (status.tracking) await git.push()
          else await git.push(['--set-upstream', remote, branch])
        } else if (action === 'pull') {
          await git.raw(['pull', '--ff-only'])
        } else {
          await git.raw(['fetch', remote])
        }
      } catch (error) {
        return { ...fail(error), action, branch }
      }

      return { ok: true, action, branch }
    }).catch(fail)
  })

  ipcMain.handle('git:undoCommit', (_event, cwd?: string): Promise<GitUndoResult> => {
    return withRepoLock(cwd, async () => {
      const git = gitFor(cwd)

      let status: StatusResult
      let dir: string | null
      try {
        ;[status, dir] = await Promise.all([git.status(), gitDir(cwd)])
      } catch (error) {
        return fail(error)
      }

      if (!status.current) return { ok: false, error: 'HEAD is detached' }

      const merging =
        !!dir &&
        (await fs.promises.access(path.join(dir, 'MERGE_HEAD')).then(
          () => true,
          () => false
        ))
      if (merging) {
        return { ok: false, error: 'Finish or abort the merge first' }
      }

      try {
        await git.raw(['rev-parse', '--verify', '--quiet', 'HEAD'])
      } catch {
        return { ok: false, error: 'Nothing to undo: no commits yet' }
      }

      let parents: string[]
      let subject: string
      let body: string
      try {
        const meta = await git.raw(['show', '-s', '--format=%P%x1f%s%x1f%b', 'HEAD'])
        const [rawParents, rawSubject, rawBody] = meta.split('\x1f')
        parents = (rawParents ?? '').split(' ').filter(Boolean)
        subject = (rawSubject ?? '').trim()
        body = (rawBody ?? '').trim()
      } catch (error) {
        return fail(error)
      }

      if (parents.length === 0) {
        return { ok: false, error: 'Nothing to undo: this is the first commit' }
      }
      if (parents.length > 1) {
        return {
          ok: false,
          error: 'The last commit is a merge',
          detail: 'Undoing a merge is not a soft reset. Do it by hand if you meant to.'
        }
      }
      if (status.tracking && status.ahead === 0) {
        return { ok: false, error: `HEAD is already pushed to ${status.tracking}` }
      }

      try {
        await git.raw(['reset', '--soft', 'HEAD~1'])
      } catch (error) {
        return fail(error)
      }

      return { ok: true, subject, body }
    }).catch(fail)
  })

  ipcMain.handle('git:openPullRequest', (_event, cwd?: string): Promise<GitPullRequestResult> =>
    withRepoLock(cwd, async () => {
      const git = gitFor(cwd)

      let status: StatusResult
      let remote: string | null
      try {
        ;[status, remote] = await Promise.all([git.status(), remoteName(cwd)])
      } catch (error) {
        return fail(error)
      }

      const branch = status.current
      if (!branch) return { ok: false, error: 'HEAD is detached' }
      if (!status.tracking) return { ok: false, error: 'Push the branch first' }
      if (!remote) return { ok: false, error: 'No remote configured' }

      let repo: URL | null
      let target: { remote: string; branch: string } | null
      let template: string
      try {
        const [rawUrl, resolved, configured] = await Promise.all([
          git.raw(['remote', 'get-url', remote]),
          defaultBranch(cwd, false, remote),
          git.raw(['config', '--get', 'snow.pullRequestUrl']).catch(() => '')
        ])
        repo = webUrl(rawUrl)
        target = resolved
        template = configured.trim()
      } catch (error) {
        return fail(error)
      }
      if (!repo) return { ok: false, error: `Could not read a web URL from ${remote}` }
      if (!target) return { ok: false, error: 'No default branch on remote' }
      if (branch === target.branch) return { ok: false, error: 'Already on the default branch' }

      const url = pullRequestUrl(repo, branch, target.branch, template)
      if (!url) {
        return {
          ok: false,
          error: `Snow does not know how to open a pull request on ${repo.hostname}`,
          detail: [
            `${repo.hostname} is not GitHub, GitLab, Bitbucket, or Azure DevOps, so snow has no URL`,
            'shape for it. Teach it one for this repo:',
            '',
            '  git config snow.pullRequestUrl "https://host/org/repo/pr/new?from={branch}&to={base}"',
            '',
            '{branch}, {base}, and {repo} are substituted.'
          ].join('\n')
        }
      }

      if (!isExternalUrl(url)) {
        return {
          ok: false,
          url,
          error: 'Refusing to open a non-web pull request URL',
          detail: [
            'Snow only opens http and https URLs. This one came from:',
            '',
            '  git config --get snow.pullRequestUrl',
            '',
            url
          ].join('\n')
        }
      }

      return { ok: true, url }
    }).catch(fail)
  )

  ipcMain.handle(
    'git:commit',
    async (
      _event,
      cwd: string | undefined,
      message: string,
      ignored: CommitIgnored = 'block'
    ): Promise<GitCommitResult> => {
      const subject = (message ?? '').trim()
      if (!subject) return { ok: false, error: 'Commit message required' }

      return withRepoLock(cwd, async () => {
        const git = gitFor(cwd)

        try {
          const pending = await git.status()
          if (pending.conflicted.length > 0) {
            return {
              ok: false,
              error: 'Resolve conflicts before committing',
              detail: [
                'These files are still unmerged. Staging them would mark the conflict resolved',
                'with the markers left in place:',
                '',
                ...pending.conflicted,
                '',
                'Resolve them, then commit.'
              ].join('\n')
            }
          }
          let resolved = await resolveCommitTargets(cwd, pending)
          if (!resolved) return { ok: false, error: 'Nothing to commit' }

          if (ignored !== 'include') {
            if (ignored === 'unstage' && resolved.blocked.length > 0) {
              await git.raw(['reset', '-q', '--', ...resolved.blocked.flatMap((f) => f.targets)])
              resolved = await resolveCommitTargets(cwd, await git.status())
              if (!resolved) return { ok: false, error: 'Nothing to commit' }
            }
            if (resolved.blocked.length > 0) return blockedResult(resolved.blocked)
          }

          if (!resolved.staged) await git.add(resolved.targets)
          await git.commit(subject)
        } catch (error) {
          return { ok: false, error: errorText(error), detail: errorDetail(error) }
        }

        return { ok: true }
      }).catch(fail)
    }
  )

  ipcMain.handle(
    'git:generateCommitMessage',
    async (_event, cwd: string | undefined): Promise<GitCommitMessageResult> => {
      const outcome = await withRepoLock(cwd, () => stagedDiff(cwd)).catch(
        (error): GitCommitMessageResult & { diff?: string } => fail(error)
      )

      if (outcome.diff === undefined) return outcome
      if (!outcome.diff.trim()) return { ok: false, error: 'Nothing to commit' }

      const agent = activeCommitAgent()
      try {
        const message = await generateCommitMessage(agent, outcome.diff)
        if (!message)
          return {
            ok: false,
            error: `${commitAgentCommand(agent)} returned an empty commit message`
          }
        return { ok: true, message }
      } catch (error) {
        return {
          ok: false,
          error: 'Could not generate a commit message',
          detail: errorDetail(error)
        }
      }
    }
  )

  const fileHandler = (
    channel: string,
    op: (git: SimpleGit, targets: FileTarget[]) => Promise<unknown>
  ): void => {
    ipcMain.handle(
      channel,
      (
        _event,
        cwd: string | undefined,
        filePath: string,
        oldPath?: string | null
      ): Promise<GitFileResult> =>
        withRepoLock(cwd, async () => {
          const targets = await fileTargets(cwd, filePath, oldPath)
          if (!targets) return { ok: false, error: 'File is outside the repository' }
          await op(gitFor(cwd), targets)
          return { ok: true }
        }).catch(fail)
    )
  }

  fileHandler('git:stageFile', (git, targets) =>
    git.raw(['add', '-A', '--', ...targets.map((t) => t.full)])
  )

  fileHandler('git:unstageFile', (git, targets) =>
    git.raw(['reset', '-q', '--', ...targets.map((t) => t.full)])
  )

  fileHandler('git:revertFile', async (git, targets) => {
    const tracked = new Set(
      await git
        .raw([
          'ls-tree',
          '-r',
          '-z',
          '--full-name',
          '--name-only',
          'HEAD',
          '--',
          ...targets.map((t) => t.full)
        ])
        .then((out) => out.split('\0').filter(Boolean))
        .catch(() => [])
    )
    const restore = targets.filter((t) => tracked.has(t.rel))
    const remove = targets.filter((t) => !tracked.has(t.rel))

    if (restore.length > 0) await git.raw(['checkout', 'HEAD', '--', ...restore.map((t) => t.full)])
    if (remove.length === 0) return
    await git.raw([
      'rm',
      '-q',
      '--cached',
      '-f',
      '--ignore-unmatch',
      '--',
      ...remove.map((t) => t.full)
    ])
    await Promise.all(remove.map((t) => fs.promises.rm(t.full, { force: true })))
  })
}
