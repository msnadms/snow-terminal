import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'snow-workflow-review-'))
const require = createRequire(import.meta.url)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function write(cwd, name, value) {
  fs.writeFileSync(path.join(cwd, name), value)
}

try {
  const bundle = path.join(scratch, 'workflow-review.cjs')
  await build({
    absWorkingDir: root,
    stdin: {
      contents: `
        export { defaultBranch } from './src/main/git.ts';
        export { describeWorkflows } from './src/main/workflow.ts';
      `,
      resolveDir: root,
      sourcefile: 'workflow-review-test-entry.ts'
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: 'electron-test-facade',
        setup(buildApi) {
          buildApi.onResolve({ filter: /^electron$/ }, () => ({
            path: 'electron',
            namespace: 'electron-test'
          }))
          buildApi.onLoad({ filter: /.*/, namespace: 'electron-test' }, () => ({
            contents: `
              export const app = { getAppPath: () => process.cwd() };
              export const BrowserWindow = { getAllWindows: () => [] };
              export const dialog = {};
              export const ipcMain = { handle() {}, on() {} };
              export const shell = {};
            `,
            loader: 'js'
          }))
        }
      }
    ]
  })
  const { defaultBranch, describeWorkflows } = require(bundle)

  // A local main branch does not prove origin/main exists. Returning it as a remote target makes
  // callers try to create worktrees from a ref that cannot resolve.
  const localOnly = path.join(scratch, 'local-only')
  fs.mkdirSync(localOnly)
  git(localOnly, 'init', '-b', 'main')
  git(localOnly, 'config', 'user.name', 'Snow Test')
  git(localOnly, 'config', 'user.email', 'snow@example.test')
  write(localOnly, 'file.txt', 'base\n')
  git(localOnly, 'add', '.')
  git(localOnly, 'commit', '-m', 'base')
  git(localOnly, 'remote', 'add', 'origin', 'https://example.invalid/snow.git')
  assert.equal(await defaultBranch(localOnly, false), null)

  git(localOnly, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  assert.deepEqual(await defaultBranch(localOnly, false), { remote: 'origin', branch: 'main' })
  git(localOnly, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/missing')
  assert.deepEqual(await defaultBranch(localOnly, false), { remote: 'origin', branch: 'main' })

  // Detailed workflow conflicts include clean committed changes and both sides of staged renames.
  const repo = path.join(scratch, 'repo')
  const one = path.join(scratch, 'one')
  const two = path.join(scratch, 'two')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Snow Test')
  git(repo, 'config', 'user.email', 'snow@example.test')
  write(repo, 'shared.txt', 'base\n')
  write(repo, 'rename-old.txt', 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'base')
  git(repo, 'remote', 'add', 'origin', 'https://example.invalid/snow.git')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(repo, 'branch', 'workflow-one')
  git(repo, 'branch', 'workflow-two')
  git(repo, 'worktree', 'add', one, 'workflow-one')
  git(repo, 'worktree', 'add', two, 'workflow-two')

  write(one, 'shared.txt', 'one\n')
  git(one, 'add', 'shared.txt')
  git(one, 'commit', '-m', 'one changes shared')
  git(one, 'mv', 'rename-old.txt', 'rename-new.txt')

  write(two, 'shared.txt', 'two\n')
  git(two, 'add', 'shared.txt')
  git(two, 'commit', '-m', 'two changes shared')
  write(two, 'rename-old.txt', 'two changes old path\n')

  const result = await describeWorkflows(
    repo,
    repo,
    [
      { repo, branch: 'workflow-one', worktree: one },
      { repo, branch: 'workflow-two', worktree: two }
    ],
    null,
    true
  )
  const byBranch = Object.fromEntries(result.workflows.map((entry) => [entry.branch, entry]))
  assert.equal(byBranch['workflow-one'].review.changed, 1)
  assert.equal(byBranch['workflow-one'].review.ahead, 1)
  assert.equal(byBranch['workflow-one'].conflicted, 2)
  assert.equal(byBranch['workflow-two'].review.changed, 1)
  assert.equal(byBranch['workflow-two'].review.ahead, 1)
  assert.equal(byBranch['workflow-two'].conflicted, 2)

  process.stdout.write('workflow default-ref and cross-workflow conflict simulations passed\n')
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
