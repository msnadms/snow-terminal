import { execFile } from 'child_process'
import os from 'os'
import { promisify } from 'util'
import { log } from './log'
import { boundedCache } from './cache'

const execFileAsync = promisify(execFile)

const maxBuffer = 8 * 1024 * 1024

const maxCachedPairs = 500

const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }

const maxInFlight = 6

let inFlight = 0

const waiting: (() => void)[] = []

/**
 * One commonly-committed path - a lockfile, `package.json` - is claimed by every workspace that
 * committed it, so a single such file yields the full C(n, 2) pairs. Unbounded, a cold detailed
 * overview across several repos spawns them all at once, each writing loose objects. The slot is
 * handed straight to the next waiter rather than released and re-taken, so the count is conserved
 * exactly and a burst cannot briefly exceed the limit.
 */
async function acquire(): Promise<void> {
  if (inFlight < maxInFlight) {
    inFlight++
    return
  }
  await new Promise<void>((resolve) => waiting.push(resolve))
}

function release(): void {
  const next = waiting.shift()
  if (next) next()
  else inFlight--
}

/**
 * `merge-tree` reports conflicts through its exit status, which simple-git cannot surface - `.raw()`
 * rejects on any non-zero exit and `GitError` carries no code, so "1 means conflicts" and "128 means
 * the command failed" arrive as the same rejection. Dropping to `execFile` is what separates them,
 * at the cost of re-supplying by hand what `gitFor` would have added.
 */
function gitArgs(args: string[]): string[] {
  return process.platform === 'win32' ? ['-c', 'core.longpaths=true', ...args] : args
}

interface GitRun {
  code: number
  stdout: string
}

async function runGit(cwd: string, args: string[]): Promise<GitRun> {
  await acquire()
  try {
    const { stdout } = await execFileAsync('git', gitArgs(args), {
      cwd: cwd || os.homedir(),
      windowsHide: true,
      maxBuffer,
      env: gitEnv
    })
    return { code: 0, stdout }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string }
    const code = typeof failure.code === 'number' ? failure.code : -1
    return { code, stdout: failure.stdout ?? '' }
  } finally {
    release()
  }
}

const supportByRepo = new Map<string, Promise<boolean>>()

/**
 * Probed by running the command rather than by parsing `git --version`, so one probe covers both
 * `--write-tree` (git 2.38) and `--name-only` (2.40) without caring how a distribution numbers its
 * build. An unsupported git leaves every pair unresolved, which degrades to path overlap alone.
 */
function mergeTreeSupported(repo: string): Promise<boolean> {
  const cached = supportByRepo.get(repo)
  if (cached) return cached

  const probe = runGit(repo, ['merge-tree', '--write-tree', '--name-only', '-z', 'HEAD', 'HEAD'])
    .then(({ code }) => code === 0)
    .catch(() => false)
  probe.then((supported) => log('info', 'merge', 'merge-tree probe', { repo, supported }))
  supportByRepo.set(repo, probe)
  return probe
}

const pairCache = boundedCache<string[] | null>(maxCachedPairs)

let mergeRunCount = 0

/** How many merges have actually been evaluated, so a test can prove the cache is being hit. */
export function mergeRuns(): number {
  return mergeRunCount
}

function pairKey(repo: string, a: string, b: string): string {
  return [repo, ...[a, b].sort()].join('\0')
}

/**
 * The conflicting paths between two commits, `null` when the merge could not be evaluated at all
 * (unrelated histories, an unresolvable ref, a git too old). `null` is deliberately not an empty
 * array - "these merge cleanly" and "could not look" must not render as the same verdict.
 *
 * `--write-tree` writes the merged tree into the object database, so this is not a pure read. The
 * objects are unreferenced and collected by `git gc`; the cache keeps it to one write per pair of
 * commits this process has never seen.
 */
export async function conflictingPaths(
  repo: string,
  a: string,
  b: string
): Promise<string[] | null> {
  if (a === b) return []

  const key = pairKey(repo, a, b)
  const cached = pairCache.get(key)
  if (cached !== undefined) return cached

  if (!(await mergeTreeSupported(repo))) return pairCache.set(key, null)

  mergeRunCount++
  const { code, stdout } = await runGit(repo, [
    'merge-tree',
    '--write-tree',
    '--name-only',
    '-z',
    a,
    b
  ])
  if (code === 0) return pairCache.set(key, [])
  if (code !== 1) return pairCache.set(key, null)

  const [, ...rest] = stdout.split('\0')
  const end = rest.indexOf('')
  const paths = end === -1 ? rest : rest.slice(0, end)
  return pairCache.set(key, [...new Set(paths)])
}
