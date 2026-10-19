import type { SimpleGit, StatusResult } from 'simple-git'
import { collapseHome, samePath } from './config'
import {
  conflictedIn,
  errorDetail,
  errorText,
  fail,
  gitFor,
  mainWorktreeRoot,
  worktreeMap,
  worktreeRoot
} from './gitCore'
import type { GitCheckoutResult } from './gitTypes'
import { branchesFor, workflowsPath } from './registry'
import { withSharedStashLock } from './stashLock'

export const markerPrefix = 'snow-wf:'
const markerPattern = new RegExp(`^(?:On [^:]+: )?${markerPrefix}(.+)$`)

export interface StashEntry {
  selector: string
  branch: string
  date: string
}

interface Departure {
  current: string | null
  parked: number
  registered: string[]
  owner: string | null
}

export function parseStashList(raw: string): StashEntry[] {
  const entries: StashEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [selector, subject, date] = line.split('\x1f')
    if (!selector || !subject) continue
    const match = markerPattern.exec(subject)
    if (!match) continue
    const branch = match[1].trim()
    if (branch) entries.push({ selector, branch, date: date ?? '' })
  }
  return entries
}

export async function stashEntries(cwd?: string): Promise<StashEntry[]> {
  try {
    return parseStashList(await gitFor(cwd).raw(['stash', 'list', '--format=%gd%x1f%gs%x1f%aI']))
  } catch {
    return []
  }
}

export function newestStash(entries: StashEntry[], branch: string): StashEntry | null {
  return entries.find((entry) => entry.branch === branch) ?? null
}

async function readNullPaths(cwd: string | undefined, args: string[]): Promise<string[] | null> {
  try {
    const raw = await gitFor(cwd).raw(args)
    return raw.split('\0').filter((entry) => entry.length > 0)
  } catch {
    return null
  }
}

export async function parkedFilePaths(
  cwd: string | undefined,
  selector: string
): Promise<string[] | null> {
  const [tracked, untracked] = await Promise.all([
    readNullPaths(cwd, ['stash', 'show', '--name-only', '-z', selector]),
    readNullPaths(cwd, ['ls-tree', '-r', '--name-only', '-z', `${selector}^3`])
  ])
  return tracked === null ? null : [...tracked, ...(untracked ?? [])]
}

export async function parkedFiles(
  cwd: string | undefined,
  selector: string
): Promise<number | null> {
  const paths = await parkedFilePaths(cwd, selector)
  return paths?.length ?? null
}

async function registryFor(cwd?: string): Promise<{ parkable: string[]; owner: string | null }> {
  const [repo, here] = await Promise.all([mainWorktreeRoot(cwd), worktreeRoot(cwd)])
  if (!repo) return { parkable: [], owner: null }
  const { parkable, owner, error } = branchesFor(repo, here)
  if (error) throw new Error(`Could not read ${workflowsPath()}\n${error}`)
  return { parkable, owner }
}

function ownedElsewhere(owner: string | null, target: string): GitCheckoutResult | null {
  if (!owner || owner === target) return null
  return {
    ok: false,
    error: `This worktree belongs to ${owner}`,
    detail: [
      `snow keeps ${owner}'s parallel session on ${owner}, so ${target} cannot be checked out here.`,
      '',
      `Switch to ${target} in the repository's main session, or stop ${owner}'s parallel session first.`
    ].join('\n')
  }
}

async function parkPlan(cwd?: string): Promise<Departure & { status: StatusResult }> {
  const [registry, status] = await Promise.all([registryFor(cwd), gitFor(cwd).status()])
  const { parkable: registered, owner } = registry
  const current = status.current
  const dirty = !!current && registered.includes(current) && status.files.length > 0
  return { current, parked: dirty ? status.files.length : 0, registered, owner, status }
}

async function parkOnLeave(
  cwd: string | undefined,
  plan: Awaited<ReturnType<typeof parkPlan>>
): Promise<Departure> {
  const { status, ...departure } = plan
  if (departure.parked === 0) return departure

  if (status.conflicted.length > 0) {
    throw new Error(
      `Resolve conflicts on ${departure.current} before leaving it\n${status.conflicted.join('\n')}`
    )
  }

  await withSharedStashLock(cwd, () =>
    gitFor(cwd).raw(['stash', 'push', '-u', '-m', `${markerPrefix}${departure.current}`])
  )
  return departure
}

const indexConflictBail = /conflicts in index\. Try without --index/i

async function popStash(cwd: string | undefined, selector: string): Promise<void> {
  try {
    await gitFor(cwd).raw(['stash', 'pop', '--index', selector])
  } catch (error) {
    if (!indexConflictBail.test(error instanceof Error ? error.message : String(error))) throw error
    await gitFor(cwd).raw(['stash', 'pop', selector])
  }
}

export async function popNewest(cwd: string | undefined, branch: string): Promise<boolean> {
  return withSharedStashLock(cwd, async () => {
    const entry = newestStash(await stashEntries(cwd), branch)
    if (!entry) return false
    await popStash(cwd, entry.selector)
    return true
  })
}

const untrackedCollision = /^(.+) already exists, no checkout$/

export function collidingUntracked(error: unknown): string[] {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .split('\n')
    .map((line) => line.trim().match(untrackedCollision)?.[1])
    .filter((file): file is string => !!file)
}

async function restoreOnEnter(
  cwd: string | undefined,
  branch: string,
  registered: string[]
): Promise<GitCheckoutResult | null> {
  if (!registered.includes(branch)) return null
  try {
    const restored = await withSharedStashLock(cwd, async () => {
      const entry = newestStash(await stashEntries(cwd), branch)
      if (!entry) return null
      const files = await parkedFiles(cwd, entry.selector)
      await popStash(cwd, entry.selector)
      return files
    })
    if (restored === null) return null
    return { ok: true, restored: restored ?? 0 }
  } catch (error) {
    const conflicted = await conflictedIn(gitFor(cwd))
    if (conflicted.length > 0) {
      return {
        ok: false,
        conflicted,
        error: 'Conflicts restoring parked changes',
        detail: [
          `Switched to ${branch}, but its parked changes conflict with the branch.`,
          'Resolve these files, then run: git stash drop',
          '',
          ...conflicted,
          '',
          'Your parked changes are still stashed, so nothing is lost.'
        ].join('\n')
      }
    }
    const colliding = collidingUntracked(error)
    if (colliding.length > 0) {
      return {
        ok: false,
        error: 'Untracked files block restoring parked changes',
        detail: [
          `Switched to ${branch}, but these files already exist untracked, so their parked copies could not be restored:`,
          '',
          ...colliding,
          '',
          'Move or delete them, then run: git stash pop',
          '',
          'Your parked changes are still stashed, so nothing is lost.'
        ].join('\n')
      }
    }
    return fail(error)
  }
}

async function rollbackPark(
  cwd: string | undefined,
  departure: Departure,
  failure: GitCheckoutResult
): Promise<GitCheckoutResult> {
  if (departure.parked === 0 || !departure.current) return failure

  const stranded = (): GitCheckoutResult => ({
    ...failure,
    detail: [
      failure.detail,
      [
        `Your changes are stashed as "${markerPrefix}${departure.current}" and could not be restored automatically.`,
        'Recover them with: git stash pop'
      ].join('\n')
    ]
      .filter(Boolean)
      .join('\n\n')
  })

  try {
    return (await popNewest(cwd, departure.current)) ? failure : stranded()
  } catch {
    return stranded()
  }
}

export async function unparkBranch(cwd: string, branch: string): Promise<string | null> {
  try {
    if (!(await popNewest(cwd, branch))) return `no ${markerPrefix}${branch} stash was found`
    return null
  } catch (error) {
    return errorDetail(error) || errorText(error)
  }
}

export async function parkPreview(cwd?: string): Promise<{ branch: string; files: number } | null> {
  const { current, parked } = await parkPlan(cwd)
  return current && parked ? { branch: current, files: parked } : null
}

export async function carryToNewBranch(
  cwd: string | undefined,
  name: string
): Promise<GitCheckoutResult> {
  try {
    const blocked = ownedElsewhere((await registryFor(cwd)).owner, name)
    if (blocked) return blocked
    await gitFor(cwd).checkoutLocalBranch(name)
    return { ok: true, branch: name }
  } catch (error) {
    return fail(error)
  }
}

export async function switchBranch(
  cwd: string | undefined,
  target: string,
  checkout: (git: SimpleGit) => Promise<unknown>
): Promise<GitCheckoutResult> {
  const checkedOut = await worktreeMap(cwd)
  const elsewhere = checkedOut.get(target)
  const here = await worktreeRoot(cwd)
  if (elsewhere && (!here || !samePath(elsewhere, here))) {
    return {
      ok: false,
      error: `${target} is already open in another worktree`,
      detail: `Open its session at ${collapseHome(elsewhere)} instead of checking it out here.`
    }
  }
  let departure: Departure
  try {
    const plan = await parkPlan(cwd)
    const blocked = ownedElsewhere(plan.owner, target)
    if (blocked) return blocked
    departure = await parkOnLeave(cwd, plan)
  } catch (error) {
    return fail(error)
  }

  try {
    await checkout(gitFor(cwd))
  } catch (error) {
    return rollbackPark(cwd, departure, fail(error))
  }

  const restored = await restoreOnEnter(cwd, target, departure.registered)
  if (restored && !restored.ok) return { ...restored, branch: target, parked: departure.parked }
  return {
    ok: true,
    branch: target,
    parked: departure.parked,
    restored: restored?.restored ?? 0
  }
}
