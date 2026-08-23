import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const lockName = 'snow-stash.lock'
const ownerName = 'owner.json'
const missingOwnerGraceMs = 5_000
const execFileAsync = promisify(execFile)

interface StashLock {
  directory: string
  owner: string
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function processIsAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function lockDirectory(cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
    cwd: cwd || os.homedir(),
    windowsHide: true
  })
  const raw = stdout.trim()
  if (!raw) throw new Error("Could not locate this repository's shared Git directory")
  const base = cwd || os.homedir()
  const common = path.resolve(path.isAbsolute(raw) ? raw : path.join(base, raw))
  return path.join(common, lockName)
}

async function removeIfAbandoned(directory: string): Promise<void> {
  const owner = path.join(directory, ownerName)
  let raw: string | null = null
  let age = 0
  try {
    raw = await fs.promises.readFile(owner, 'utf8')
  } catch {
    try {
      age = Date.now() - (await fs.promises.stat(directory)).mtimeMs
    } catch {
      return
    }
    if (age < missingOwnerGraceMs) return
  }

  let live = false
  if (raw) {
    try {
      live = processIsAlive((JSON.parse(raw) as { pid?: unknown }).pid)
    } catch {
      live = false
    }
  }
  if (live) return

  await fs.promises.unlink(owner).catch(() => undefined)
  await fs.promises.rmdir(directory).catch(() => undefined)
}

async function acquire(cwd?: string): Promise<StashLock> {
  const directory = await lockDirectory(cwd)
  const owner = path.join(directory, ownerName)
  const deadline = Date.now() + 10_000

  while (true) {
    try {
      await fs.promises.mkdir(directory)
      await fs.promises.writeFile(
        owner,
        `${JSON.stringify({ pid: process.pid, token: randomUUID() })}\n`,
        {
          flag: 'wx'
        }
      )
      return { directory, owner }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      await removeIfAbandoned(directory)
      if (Date.now() >= deadline)
        throw new Error('Another Snow workspace is updating the shared stash; try again shortly')
      await delay(50)
    }
  }
}

async function release(lock: StashLock): Promise<void> {
  await fs.promises.unlink(lock.owner).catch(() => undefined)
  await fs.promises.rmdir(lock.directory).catch(() => undefined)
}

/**
 * `refs/stash` and its reflog are shared by every linked worktree. Keep every Snow operation that
 * resolves and then consumes a marker stash in one cross-process critical section, so a concurrent
 * workspace cannot shift a `stash@{n}` selector between those two steps.
 */
export async function withSharedStashLock<T>(
  cwd: string | undefined,
  op: () => Promise<T>
): Promise<T> {
  const lock = await acquire(cwd)
  try {
    return await op()
  } finally {
    await release(lock)
  }
}
