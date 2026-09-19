import os from 'os'
import { mainWorktreeRoot, worktreeRoot } from './gitCore'
import { contentWatchers } from './watchRegistry'

const repoLocks = new Map<string, Promise<unknown>>()

export async function withRepoLock<T>(cwd: string | undefined, op: () => Promise<T>): Promise<T> {
  const key = (await mainWorktreeRoot(cwd)) ?? (await worktreeRoot(cwd)) ?? cwd ?? os.homedir()
  const previous = repoLocks.get(key) ?? Promise.resolve()
  const run = previous.then(op, op)
  repoLocks.set(key, run)
  try {
    return await run
  } finally {
    if (repoLocks.get(key) === run) repoLocks.delete(key)
    contentWatchers.notify(key)
  }
}
