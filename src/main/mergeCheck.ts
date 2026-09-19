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

export function mergeRuns(): number {
  return mergeRunCount
}

function pairKey(repo: string, a: string, b: string): string {
  return [repo, ...[a, b].sort()].join('\0')
}

export function parseConflictedNames(stdout: string): string[] {
  const [, ...rest] = stdout.split('\0')
  const end = rest.indexOf('')
  const paths = end === -1 ? rest : rest.slice(0, end)
  return [...new Set(paths)]
}

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
  return pairCache.set(key, parseConflictedNames(stdout))
}
