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
  parkedFilePaths,
  parkedFiles,
  stashEntries,
  switchBranch,
  unparkBranch,
  withRepoLock,
  mainWorktreeRoot,
  worktreeMap,
  type GitCheckoutResult
} from './git'
import type { StatusResult } from 'simple-git'
import { conflictingPaths } from './mergeCheck'
import { withSharedStashLock } from './stashLock'
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

/** Where a workflow's displayed claim on a path comes from. */
export type OverlapSource = 'committed' | 'working' | 'parked'

/**
 * `conflict` and `clean` are real `git merge-tree` verdicts, only reachable when every side has
 * committed the path; `overlap` means the path is claimed twice and nothing could test it, which is
 * "unknown" rather than "probably fine". Keeping all three apart is the point - a badge that reports
 * every shared file as a conflict is lit permanently and stops being read, and one that reports an
 * untested path as clean is worse.
 */
export type OverlapVerdict = 'conflict' | 'overlap' | 'clean'

/**
 * A workflow claiming the same path, and how. The source is what makes an `overlap` explain itself:
 * a path this workflow committed still reads unproven when someone else's claim is uncommitted, and
 * without naming whose claim that is the row looks self-contradictory.
 *
 * The default branch appears here like any other claimant, which is what keeps drift against it on
 * the one pipeline - it sorts, caps, counts and renders as an ordinary conflict row rather than as a
 * parallel channel every consumer has to special-case.
 */
export interface WorkflowClaimant {
  branch: string
  source: OverlapSource
}

export interface WorkflowOverlap {
  path: string
  verdict: OverlapVerdict
  source: OverlapSource
  branches: WorkflowClaimant[]
}

export interface WorkflowOverlapReport {
  /** Capped rows, ordered from the most actionable verdict to the least. */
  overlaps: WorkflowOverlap[]
  /** The pre-cap count per verdict. */
  overlapTotals: Record<OverlapVerdict, number>
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
  /** Paths also claimed by another workflow in this repository, from detail reads. Capped. */
  overlaps?: WorkflowOverlap[]
  /**
   * The pre-cap count per verdict. A breakdown rather than one total, because the badge reports the
   * three verdicts separately and the capped `overlaps` array cannot be counted for them - the cap
   * slices off the tail, which is exactly where the least alarming ones sort to.
   */
  overlapTotals?: Record<OverlapVerdict, number>
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
  /** Default-branch comparisons for open session directories, including unregistered repos. */
  comparisons: WorkflowSessionComparison[]
  error: string | null
}

export interface WorkflowSessionComparison extends WorkflowOverlapReport {
  directory: string
  repo: string | null
  branch: string | null
  defaultBranch: string | null
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

/**
 * `git worktree add` happily checks out into an existing *empty* directory - only a non-empty one
 * is actually a conflict (e.g. a previous `remove` that unregistered the worktree but couldn't
 * delete a locked file). An empty leftover is common: `remove` deletes its own directory tree but
 * can still leave an empty parent behind on Windows.
 */
async function occupiedWorktree(
  destination: string,
  branch: string,
  verb: 'create' | 'open'
): Promise<WorkflowResult | null> {
  const remaining = await fs.promises
    .readdir(destination)
    .catch((error) => (error.code === 'ENOENT' ? [] : Promise.reject(error)))
  if (!remaining.length) return null
  return {
    ok: false,
    error: `${branch}'s worktree directory already has files in it`,
    detail: [
      collapseHome(destination),
      '',
      `snow will not check ${branch} out over it. Move or delete that directory, then ${verb} the workspace again.`
    ].join('\n')
  }
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
 * `status.ahead` counts against the branch's upstream, which workspace creation deliberately does not
 * set (`--no-track`), so review distance is measured against the default branch instead - the remote
 * ref first, then the local one for a repo with no remote.
 */
interface WorkflowReviewState {
  review: WorkflowReview
  claims: PathClaim[]
}

interface PathClaim {
  path: string
  source: OverlapSource
}

interface DescribedWorkflow {
  entry: WorkflowEntry
  claims: PathClaim[]
  head: string | null
}

const sourceRank: Record<OverlapSource, number> = { committed: 2, working: 1, parked: 0 }

function strongest(a: OverlapSource, b: OverlapSource): OverlapSource {
  return sourceRank[a] >= sourceRank[b] ? a : b
}

interface ClaimProvenance {
  committed: boolean
  /** Dirty provenance is retained even when this path was also committed. */
  dirty: Exclude<OverlapSource, 'committed'> | null
}

function addProvenance(
  existing: ClaimProvenance | undefined,
  source: OverlapSource
): ClaimProvenance {
  if (source === 'committed') return { committed: true, dirty: existing?.dirty ?? null }
  const dirty = existing?.dirty === 'working' || source === 'working' ? 'working' : 'parked'
  return { committed: existing?.committed ?? false, dirty }
}

function displayedSource(provenance: ClaimProvenance): OverlapSource {
  return provenance.dirty ?? 'committed'
}

function claimsOf(paths: string[] | null | undefined, source: OverlapSource): PathClaim[] {
  return (paths ?? []).map((path) => ({ path, source }))
}

/** Both sides of a rename are separate claims, which is what makes an unstaged rename collide. */
function workingClaims(status: StatusResult): PathClaim[] {
  return claimsOf(
    status.files.flatMap((file) => [file.from, file.path].filter(Boolean) as string[]),
    'working'
  )
}

export function nameStatusPaths(raw: string): string[] {
  const fields = raw.split('\0')
  const paths: string[] = []
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]
    if (!status) continue
    const first = fields[index++]
    if (first) paths.push(first)
    if (status[0] === 'R' || status[0] === 'C') {
      const second = fields[index++]
      if (second) paths.push(second)
    }
  }
  return paths
}

async function rangePaths(directory: string, range: string): Promise<string[] | null> {
  try {
    const raw = await gitFor(directory).raw(['diff', '--name-status', '-z', '-M', range])
    return nameStatusPaths(raw)
  } catch {
    return null
  }
}

async function committedPaths(directory: string, bases: string[]): Promise<string[]> {
  for (const base of bases) {
    const paths = await rangePaths(directory, `${base}...HEAD`)
    if (paths) return paths
  }
  return []
}

async function reviewOf(directory: string, bases: string[]): Promise<WorkflowReviewState | null> {
  try {
    const status = await gitFor(directory).status()
    const [committed, ahead] = await Promise.all([
      committedPaths(directory, bases),
      aheadOf(directory, bases)
    ])
    return {
      review: {
        changed: status.files.length,
        staged: status.files.filter((file) => isStaged(file.index)).length,
        ahead
      },
      claims: [...claimsOf(committed, 'committed'), ...workingClaims(status)]
    }
  } catch {
    return null
  }
}

/**
 * Uncommitted work in the repository's own checkout collides with every workspace just as hard as a
 * registered one, so it joins the overlap comparison - but only as a participant. It gets no row of
 * its own, because the manager lists what has been registered. Skipped when the current branch is
 * already registered, where `reviewOf` covers the same directory.
 */
async function unregisteredClaims(
  repo: string | null,
  current: string | null,
  registered: string[]
): Promise<PathClaim[]> {
  if (!repo || !current || registered.includes(current)) return []
  try {
    return workingClaims(await gitFor(repo).status())
  } catch {
    return []
  }
}

async function branchHeads(cwd: string | undefined): Promise<Map<string, string>> {
  try {
    const raw = await gitFor(cwd).raw([
      'for-each-ref',
      '--format=%(refname:short)%09%(objectname)',
      'refs/heads/'
    ])
    const heads = new Map<string, string>()
    for (const line of raw.split('\n')) {
      const [branch, sha] = line.trim().split('\t')
      if (branch && sha) heads.set(branch, sha)
    }
    return heads
  } catch {
    return new Map()
  }
}

async function resolveBase(cwd: string | undefined, bases: string[]): Promise<string | null> {
  const resolved = await Promise.all(
    bases.map(async (base) => {
      try {
        return (
          await gitFor(cwd).raw(['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
        ).trim()
      } catch {
        return ''
      }
    })
  )
  return resolved.find(Boolean) ?? null
}

const overlapCap = 20

const verdictRank: Record<OverlapVerdict, number> = { conflict: 0, overlap: 1, clean: 2 }

function overlapReport(overlaps: WorkflowOverlap[]): WorkflowOverlapReport {
  overlaps.sort((a, b) =>
    a.verdict === b.verdict
      ? a.path.localeCompare(b.path)
      : verdictRank[a.verdict] - verdictRank[b.verdict]
  )
  const overlapTotals: Record<OverlapVerdict, number> = { conflict: 0, overlap: 0, clean: 0 }
  for (const overlap of overlaps) overlapTotals[overlap.verdict]++
  return { overlaps: overlaps.slice(0, overlapCap), overlapTotals }
}

function participantPair(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/**
 * `git merge-tree` merges commits, so it can only answer for paths both sides have committed. That
 * is the seam the two verdicts fall out of: a committed pair gets a real merge result, and every
 * other shared path stays an unproven `overlap`. Path intersection is not the answer here, it is the
 * prefilter deciding which pairs are worth a subprocess.
 *
 * The default branch is merged against every tip (O(n), not O(n^2)) and its conflicts are recorded
 * through the same `noteConflict` as a sibling's, so drift lands in `overlaps` as ordinary rows. It
 * is deliberately not a claim-bearing participant: it never contributes to path intersection, so it
 * cannot manufacture an unproven overlap - only a real merge failure puts it on a row.
 */
async function resolveOverlaps(
  cwd: string | undefined,
  repo: string | null,
  described: DescribedWorkflow[],
  current: string | null,
  bases: string[],
  baseLabel: string | null
): Promise<WorkflowEntry[]> {
  const registered = described.map(({ entry }) => entry.branch)
  const extra = await unregisteredClaims(repo, current, registered)
  const participants = [
    ...described.map(({ entry, claims }) => ({ label: entry.branch, claims })),
    ...(extra.length && current ? [{ label: current, claims: extra }] : [])
  ]

  const owners = new Map<string, Map<number, ClaimProvenance>>()
  participants.forEach(({ claims }, index) => {
    for (const { path: file, source } of claims) {
      const byOwner = owners.get(file) ?? new Map<number, ClaimProvenance>()
      byOwner.set(index, addProvenance(byOwner.get(index), source))
      owners.set(file, byOwner)
    }
  })

  const pairs = new Map<string, [number, number]>()
  const notePair = (a: number, b: number): void => {
    if (a !== b) pairs.set(participantPair(a, b), [a, b])
  }
  for (const byOwner of owners.values()) {
    const committed = [...byOwner.entries()]
      .filter(([, provenance]) => provenance.committed)
      .map(([index]) => index)
    for (let x = 0; x < committed.length; x++)
      for (let y = x + 1; y < committed.length; y++) notePair(committed[x], committed[y])
  }
  for (const [file, byOwner] of owners) {
    let boundary = file.indexOf('/')
    while (boundary !== -1) {
      const parents = owners.get(file.slice(0, boundary))
      if (parents)
        for (const [child, childClaim] of byOwner)
          if (childClaim.committed)
            for (const [parent, parentClaim] of parents)
              if (parentClaim.committed) notePair(child, parent)
      boundary = file.indexOf('/', boundary + 1)
    }
  }

  const root = repo ?? cwd ?? null
  const [pairResults, baseConflicts] = await Promise.all([
    Promise.all(
      [...pairs.values()].map(async ([a, b]) => {
        const headA = described[a]?.head
        const headB = described[b]?.head
        if (!root || !headA || !headB) return { a, b, paths: null }
        return { a, b, paths: await conflictingPaths(root, headA, headB) }
      })
    ),
    (root ? resolveBase(cwd, bases) : Promise.resolve(null)).then((baseSha) =>
      Promise.all(
        described.map(({ head }) =>
          root && baseSha && head && head !== baseSha
            ? conflictingPaths(root, head, baseSha)
            : Promise.resolve(null)
        )
      )
    )
  ])

  const conflictedWith = new Map<number, Map<string, Set<string>>>()
  const noteConflict = (index: number, file: string, other: string): void => {
    const byPath = conflictedWith.get(index) ?? new Map<string, Set<string>>()
    const branches = byPath.get(file) ?? new Set<string>()
    branches.add(other)
    byPath.set(file, branches)
    conflictedWith.set(index, byPath)
  }
  const evaluated = new Set<string>()
  for (const { a, b, paths } of pairResults) {
    if (!paths) continue
    evaluated.add(participantPair(a, b))
    for (const file of paths) {
      noteConflict(a, file, participants[b].label)
      noteConflict(b, file, participants[a].label)
    }
  }
  if (baseLabel)
    baseConflicts.forEach((paths, index) => {
      for (const file of paths ?? []) noteConflict(index, file, baseLabel)
    })

  /**
   * A path merges cleanly only when *every* claim on it was actually testable - both sides
   * committed it and the pair evaluated. One untested claimant leaves the whole path unproven,
   * because "we checked and it is fine" is a much stronger statement than "we could not check".
   */
  const provenClean = (file: string, index: number): boolean => {
    const byOwner = owners.get(file)
    const own = byOwner?.get(index)
    if (!byOwner || !own?.committed || own.dirty) return false
    const others = [...byOwner.keys()].filter((owner) => owner !== index)
    if (!others.length) return false
    return others.every((other) => {
      const claim = byOwner.get(other)
      return !!claim?.committed && !claim.dirty && evaluated.has(participantPair(index, other))
    })
  }

  const sharedByOwner = new Map<number, string[]>()
  for (const [file, byOwner] of owners) {
    if (byOwner.size < 2) continue
    for (const owner of byOwner.keys()) {
      const files = sharedByOwner.get(owner) ?? []
      files.push(file)
      sharedByOwner.set(owner, files)
    }
  }

  return described.map(({ entry }, index) => {
    const conflicts = conflictedWith.get(index) ?? new Map<string, Set<string>>()
    const shared = sharedByOwner.get(index) ?? []
    const overlaps: WorkflowOverlap[] = [...new Set([...shared, ...conflicts.keys()])].map(
      (file) => {
        const byOwner = owners.get(file)
        const own = byOwner?.get(index)
        const others = new Map<string, OverlapSource>()
        for (const [owner, provenance] of byOwner ?? [])
          if (owner !== index) others.set(participants[owner].label, displayedSource(provenance))
        // A path merge-tree named but intersection never saw (a rename/delete) has no recorded
        // claim; the merge derived it from commits, so `committed` is the honest label.
        for (const branch of conflicts.get(file) ?? [])
          if (!others.has(branch)) others.set(branch, 'committed')
        const verdict: OverlapVerdict = conflicts.has(file)
          ? 'conflict'
          : provenClean(file, index)
            ? 'clean'
            : 'overlap'
        return {
          path: file,
          verdict,
          source: own ? displayedSource(own) : 'committed',
          branches: [...others]
            .map(([branch, source]) => ({ branch, source }))
            .sort((a, b) => a.branch.localeCompare(b.branch))
        }
      }
    )
    return { ...entry, ...overlapReport(overlaps) }
  })
}

async function mergeBase(directory: string, a: string, b: string): Promise<string | null> {
  try {
    return (await gitFor(directory).raw(['merge-base', a, b])).trim() || null
  } catch {
    return null
  }
}

/**
 * Compare an ordinary open session to both local and remote-tracking versions of its default
 * branch. These sessions have no workflow record, so they cannot participate in the registered
 * workflow matrix above, but drift from master/main is still the conflict most likely to matter
 * when the session is handed back. The two refs are evaluated once when they point to the same
 * commit and labelled separately when they diverge.
 *
 * Committed tips get a real merge verdict. Working-tree paths are marked `overlap` only when the
 * default branch changed the same path since the merge base; without committing that work Git
 * cannot prove whether it will merge, so calling it a conflict would overstate the result.
 */
export async function describeSessionComparison(
  directory: string
): Promise<WorkflowSessionComparison> {
  const empty = (
    repo: string | null,
    branch: string | null = null,
    defaultName: string | null = null
  ): WorkflowSessionComparison => ({
    directory,
    repo,
    branch,
    defaultBranch: defaultName,
    ...overlapReport([])
  })

  const repo = await mainWorktreeRoot(directory)
  if (!repo) return empty(null)

  try {
    const [status, target, head] = await Promise.all([
      gitFor(directory).status(),
      defaultBranch(directory, false),
      gitFor(directory)
        .revparse(['--verify', 'HEAD'])
        .then((value) => value.trim())
    ])
    const branch = status.current ?? null
    if (!target || !head) return empty(repo, branch)

    const refs = [
      { ref: target.branch, label: `${target.branch} (local)` },
      { ref: `${target.remote}/${target.branch}`, label: `${target.remote}/${target.branch}` }
    ]
    const resolved = (
      await Promise.all(
        refs.map(async (candidate) => ({
          ...candidate,
          sha: await resolveBase(directory, [candidate.ref])
        }))
      )
    ).filter((candidate): candidate is (typeof refs)[number] & { sha: string } => !!candidate.sha)
    if (!resolved.length) return empty(repo, branch, target.branch)

    const uniqueBases = new Map<string, { sha: string; label: string }>()
    for (const candidate of resolved) {
      const existing = uniqueBases.get(candidate.sha)
      if (existing) {
        // Local and remote are in sync, so one generic label is clearer than two identical claims.
        existing.label = target.branch
      } else {
        uniqueBases.set(candidate.sha, { sha: candidate.sha, label: candidate.label })
      }
    }

    const working = new Map<string, OverlapSource>()
    for (const claim of workingClaims(status)) {
      const current = working.get(claim.path)
      working.set(claim.path, current ? strongest(current, claim.source) : claim.source)
    }

    const results = await Promise.all(
      [...uniqueBases.values()].map(async (base) => {
        const [conflicts, common] = await Promise.all([
          head === base.sha
            ? Promise.resolve<string[] | null>([])
            : conflictingPaths(repo, head, base.sha),
          mergeBase(directory, head, base.sha)
        ])
        const [changedOnDefault, changedInSession] = common
          ? await Promise.all([
              rangePaths(directory, `${common}..${base.sha}`),
              rangePaths(directory, `${common}..${head}`)
            ])
          : [null, null]
        return { ...base, conflicts, changedOnDefault, changedInSession }
      })
    )

    const byPath = new Map<string, WorkflowOverlap>()
    const note = (
      file: string,
      verdict: Extract<OverlapVerdict, 'conflict' | 'overlap'>,
      source: OverlapSource,
      label: string
    ): void => {
      const existing = byPath.get(file)
      if (!existing) {
        byPath.set(file, {
          path: file,
          verdict,
          source,
          branches: [{ branch: label, source: 'committed' }]
        })
        return
      }
      if (verdict === 'conflict') {
        existing.verdict = 'conflict'
        existing.source = 'committed'
      } else if (existing.verdict !== 'conflict') {
        // For an unproven row, dirty provenance is the useful fact even if this path was committed.
        existing.source =
          existing.source === 'working' || source === 'working'
            ? 'working'
            : existing.source === 'parked' || source === 'parked'
              ? 'parked'
              : 'committed'
      }
      if (!existing.branches.some((claim) => claim.branch === label))
        existing.branches.push({ branch: label, source: 'committed' })
    }

    for (const result of results) {
      const conflicted = new Set(result.conflicts ?? [])
      for (const file of conflicted) note(file, 'conflict', 'committed', result.label)
      if (result.conflicts === null) {
        const changedInSession = new Set(result.changedInSession ?? [])
        for (const file of result.changedOnDefault ?? [])
          if (changedInSession.has(file)) note(file, 'overlap', 'committed', result.label)
      }
      for (const file of result.changedOnDefault ?? []) {
        const source = working.get(file)
        if (source && !conflicted.has(file)) note(file, 'overlap', source, result.label)
      }
    }
    const overlaps = [...byPath.values()].map((overlap) => ({
      ...overlap,
      branches: overlap.branches.sort((a, b) => a.branch.localeCompare(b.branch))
    }))

    return {
      directory,
      repo,
      branch,
      defaultBranch: target.branch,
      ...overlapReport(overlaps)
    }
  } catch {
    return empty(repo)
  }
}

async function describeSessionComparisons(
  directories: string[]
): Promise<WorkflowSessionComparison[]> {
  const unique = directories
    .filter((directory): directory is string => typeof directory === 'string' && !!directory.trim())
    .filter(
      (directory, index, all) =>
        all.findIndex((candidate) => samePath(candidate, directory)) === index
    )
    .slice(0, 100)
  return Promise.all(unique.map(describeSessionComparison))
}

export async function describeWorkflows(
  cwd: string | undefined,
  repo: string | null,
  records: WorkflowRecord[],
  error: string | null,
  detail = false
): Promise<WorkflowList> {
  const [summary, entries, target, checkedOut, heads] = await Promise.all([
    gitFor(cwd)
      .branchLocal()
      .catch(() => null),
    stashEntries(cwd),
    defaultBranch(cwd, false),
    worktreeMap(cwd),
    detail ? branchHeads(cwd) : new Map<string, string>()
  ])
  if (!summary) return emptyList(error, repo)

  const current = summary.current || null
  const bases = target ? [`${target.remote}/${target.branch}`, target.branch] : []
  const described = await Promise.all(
    records.map(async ({ branch, worktree }): Promise<DescribedWorkflow> => {
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
      const [review, parkedPaths] = await Promise.all([
        detail && reviewDir ? reviewOf(reviewDir, bases) : null,
        detail && entry ? parkedFilePaths(cwd, entry.selector) : null
      ])
      return {
        entry: {
          branch,
          current: branch === current,
          exists: summary.all.includes(branch),
          parked: entry
            ? {
                files: detail
                  ? (parkedPaths?.length ?? null)
                  : await parkedFiles(cwd, entry.selector),
                date: entry.date,
                count: entries.filter((candidate) => candidate.branch === branch).length
              }
            : null,
          worktree: absoluteWorktree,
          worktreeExists,
          worktreeLinked,
          review: review?.review
        },
        claims: [...(review?.claims ?? []), ...claimsOf(parkedPaths, 'parked')],
        head: heads.get(branch) ?? null
      }
    })
  )

  const workflows: WorkflowEntry[] = detail
    ? await resolveOverlaps(cwd, repo, described, current, bases, target?.branch ?? null)
    : described.map(({ entry }) => entry)

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
          error: `Remove ${name}'s workspace before removing its workspace record`
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

        const destination = worktreeDirectory(repo, name)
        const blocked = await occupiedWorktree(destination, name, 'create')
        if (blocked) return blocked

        const target = await defaultBranch(cwd)
        const base = target ? `${target.remote}/${target.branch}` : 'HEAD'

        try {
          // Creating the branch as part of `worktree add` keeps the current checkout exactly where
          // it is while giving the new workspace an isolated working directory.
          await gitFor(cwd).raw(['worktree', 'add', '-b', name, '--no-track', destination, base])
        } catch (error) {
          return { ok: false, error: errorText(error), detail: errorDetail(error) }
        }

        const failed = addRecord(repo, name, destination)
        if (failed)
          return {
            ok: false,
            error: `Created ${name}'s workspace, but could not register it in ${workflowsPath()}`,
            detail: failed,
            worktree: destination
          }

        return { ok: true, branch: name, worktree: destination }
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
          // Removal deletes the directory whole, ignored files included, with or without --force;
          // the renderer confirms that. The first --force covers what the stash above could not
          // take. The second is required for explicitly locked worktrees (Claude Code creates
          // these); the same confirmation also covers overriding that advisory lock.
          //
          // Run from the main worktree: invoking this from the target worktree itself also keeps
          // that directory as Git's current working directory, which prevents its removal on Windows.
          //
          // Try once with the session still running. Killing the user's shells is the destructive
          // part of stopping a workflow and it is only needed on Windows, where an open shell holds
          // the directory - so it is worth finding out whether removal needs it before paying it.
          try {
            await gitFor(repo).raw(['worktree', 'remove', '--force', '--force', directory])
          } catch (first) {
            if (!(await stillLinked(repo, name, directory))) throw first
            await closePtysInDirectory(directory)
            terminalsClosed = true
            await gitFor(repo).raw(['worktree', 'remove', '--force', '--force', directory])
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
