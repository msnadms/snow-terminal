import type { StatusResult } from 'simple-git'
import { samePath } from './config'
import { defaultBranch, gitFor, mainWorktreeRoot } from './gitCore'
import { conflictingPaths } from './mergeCheck'
import type {
  OverlapSource,
  OverlapVerdict,
  WorkflowEntry,
  WorkflowOverlap,
  WorkflowOverlapReport,
  WorkflowSessionComparison
} from './workflowTypes'
import { mergeBase, rangePaths, resolveBase } from './worktrees'

export interface PathClaim {
  path: string
  source: OverlapSource
}

export interface DescribedWorkflow {
  entry: WorkflowEntry
  claims: PathClaim[]
  head: string | null
}

interface ClaimProvenance {
  committed: boolean
  dirty: Exclude<OverlapSource, 'committed'> | null
}

const sourceRank: Record<OverlapSource, number> = { committed: 2, working: 1, parked: 0 }

function strongest(a: OverlapSource, b: OverlapSource): OverlapSource {
  return sourceRank[a] >= sourceRank[b] ? a : b
}

export function addProvenance(
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

export function claimsOf(paths: string[] | null | undefined, source: OverlapSource): PathClaim[] {
  return (paths ?? []).map((path) => ({ path, source }))
}

export function workingClaims(status: Pick<StatusResult, 'files'>): PathClaim[] {
  return claimsOf(
    status.files.flatMap((file) => [file.from, file.path].filter(Boolean) as string[]),
    'working'
  )
}

const overlapCap = 20

const verdictRank: Record<OverlapVerdict, number> = { conflict: 0, overlap: 1, clean: 2 }

export function overlapReport(overlaps: WorkflowOverlap[]): WorkflowOverlapReport {
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

export async function resolveOverlaps(
  cwd: string | undefined,
  repo: string | null,
  described: DescribedWorkflow[],
  current: string | null,
  baseSha: string | null,
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
    Promise.all(
      described.map(({ head }) =>
        root && baseSha && head && head !== baseSha
          ? conflictingPaths(root, head, baseSha)
          : Promise.resolve(null)
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

export async function describeSessionComparisons(
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
