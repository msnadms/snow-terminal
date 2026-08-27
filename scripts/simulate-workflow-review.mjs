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

const electronFacade = {
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
        export { describeSessionComparison, describeWorkflows } from './src/main/workflow.ts';
        export { mergeRuns } from './src/main/mergeCheck.ts';
      `,
      resolveDir: root,
      sourcefile: 'workflow-review-test-entry.ts'
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins: [electronFacade]
  })
  const { defaultBranch, describeSessionComparison, describeWorkflows, mergeRuns } = require(bundle)

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

  // Detailed workflow overlaps cover committed changes, both sides of staged renames, the real
  // merge verdict between two branch tips, drift against the default branch, and uncommitted work
  // sitting in the repository's own checkout.
  const repo = path.join(scratch, 'repo')
  const one = path.join(scratch, 'one')
  const two = path.join(scratch, 'two')
  const three = path.join(scratch, 'three')
  const stale = path.join(scratch, 'stale')
  const loose = path.join(scratch, 'loose')
  const fileCollision = path.join(scratch, 'file-collision')
  const directoryCollision = path.join(scratch, 'directory-collision')
  fs.mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Snow Test')
  git(repo, 'config', 'user.email', 'snow@example.test')
  write(repo, 'shared.txt', 'base\n')
  write(repo, 'rename-old.txt', 'base\n')
  write(repo, 'drift.txt', 'base\n')
  write(repo, 'local-drift.txt', 'base\n')
  write(repo, 'working-drift.txt', 'base\n')
  // Wide enough that an edit at the top and one at the bottom merge without touching each other.
  write(repo, 'wide.txt', Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join(''))
  write(repo, 'mixed.txt', Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join(''))
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'base')
  git(repo, 'remote', 'add', 'origin', 'https://example.invalid/snow.git')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  for (const branch of [
    'workflow-one',
    'workflow-two',
    'workflow-three',
    'workflow-stale',
    'workflow-file-collision',
    'workflow-directory-collision',
    'session-loose'
  ])
    git(repo, 'branch', branch)
  git(repo, 'worktree', 'add', one, 'workflow-one')
  git(repo, 'worktree', 'add', two, 'workflow-two')
  git(repo, 'worktree', 'add', three, 'workflow-three')
  git(repo, 'worktree', 'add', stale, 'workflow-stale')
  git(repo, 'worktree', 'add', fileCollision, 'workflow-file-collision')
  git(repo, 'worktree', 'add', directoryCollision, 'workflow-directory-collision')
  git(repo, 'worktree', 'add', loose, 'session-loose')

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const wide = (index, value) => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}\n`)
    lines[index] = `${value}\n`
    return lines.join('')
  }

  write(one, 'shared.txt', 'one\n')
  write(one, 'wide.txt', wide(0, 'one edits the top'))
  write(one, 'mixed.txt', wide(0, 'one commits the top'))
  git(one, 'add', 'shared.txt', 'wide.txt', 'mixed.txt')
  git(one, 'commit', '-m', 'one changes shared and two top lines')
  write(one, 'mixed.txt', `${wide(0, 'one commits the top')}dirty after commit\n`)
  git(one, 'mv', 'rename-old.txt', 'rename-new.txt')

  write(two, 'shared.txt', 'two\n')
  git(two, 'add', 'shared.txt')
  git(two, 'commit', '-m', 'two changes shared')
  write(two, 'rename-old.txt', 'two changes old path\n')

  write(three, 'wide.txt', wide(39, 'three edits the bottom'))
  write(three, 'mixed.txt', wide(39, 'three commits the bottom'))
  git(three, 'add', 'wide.txt', 'mixed.txt')
  git(three, 'commit', '-m', 'three changes two bottom lines')

  write(stale, 'drift.txt', 'stale\n')
  git(stale, 'add', 'drift.txt')
  git(stale, 'commit', '-m', 'stale changes drift')

  write(fileCollision, 'path-collision', 'file\n')
  git(fileCollision, 'add', 'path-collision')
  git(fileCollision, 'commit', '-m', 'add colliding file')
  fs.mkdirSync(path.join(directoryCollision, 'path-collision'))
  write(directoryCollision, 'path-collision/nested.txt', 'nested\n')
  git(directoryCollision, 'add', 'path-collision/nested.txt')
  git(directoryCollision, 'commit', '-m', 'add colliding directory')

  // An ordinary worktree with an open session but no workflow record. Its committed change can be
  // merge-tested against main; its working change can only be identified as an unproven overlap.
  write(loose, 'drift.txt', 'loose\n')
  write(loose, 'local-drift.txt', 'loose local conflict\n')
  git(loose, 'add', 'drift.txt', 'local-drift.txt')
  git(loose, 'commit', '-m', 'loose session changes drift paths')
  write(loose, 'working-drift.txt', 'loose working copy\n')

  // The default branch moves under workflow-stale with an incompatible change to the same file.
  write(repo, 'drift.txt', 'main moved on\n')
  write(repo, 'working-drift.txt', 'main moved here too\n')
  git(repo, 'add', 'drift.txt', 'working-drift.txt')
  git(repo, 'commit', '-m', 'main changes drift paths')
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')

  // Identical local and remote refs are evaluated and labelled once.
  const syncedComparison = await describeSessionComparison(loose)
  assert.ok(
    syncedComparison.overlaps.every(
      (entry) => entry.branches.length === 1 && entry.branches[0].branch === 'main'
    )
  )

  // Local main moves again without origin/main. The session must now report both baselines without
  // counting drift.txt twice, plus a conflict introduced only by the local commit.
  write(repo, 'local-drift.txt', 'local main moved on\n')
  git(repo, 'add', 'local-drift.txt')
  git(repo, 'commit', '-m', 'local main changes another drift path')

  // Uncommitted work in the repository's own checkout, on a branch nothing registered.
  write(repo, 'shared.txt', 'main is dirty too\n')

  const records = [
    { repo, branch: 'workflow-one', worktree: one },
    { repo, branch: 'workflow-two', worktree: two },
    { repo, branch: 'workflow-three', worktree: three },
    { repo, branch: 'workflow-stale', worktree: stale },
    { repo, branch: 'workflow-file-collision', worktree: fileCollision },
    { repo, branch: 'workflow-directory-collision', worktree: directoryCollision }
  ]
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const describe = () => describeWorkflows(repo, repo, records, null, true)

  const before = mergeRuns()
  const result = await describe()
  assert.ok(mergeRuns() > before, 'expected the first detailed read to evaluate merges')

  const byBranch = Object.fromEntries(result.workflows.map((entry) => [entry.branch, entry]))
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const overlap = (branch, file) => byBranch[branch].overlaps.find((entry) => entry.path === file)

  assert.deepEqual(Object.keys(byBranch).sort(), [
    'workflow-directory-collision',
    'workflow-file-collision',
    'workflow-one',
    'workflow-stale',
    'workflow-three',
    'workflow-two'
  ])
  assert.equal(byBranch['workflow-one'].review.changed, 2)
  assert.equal(byBranch['workflow-one'].review.ahead, 1)
  assert.equal(byBranch['workflow-two'].review.changed, 1)
  assert.equal(byBranch['workflow-two'].review.ahead, 1)

  const fileDirectoryConflict = byBranch['workflow-file-collision'].overlaps.find((entry) =>
    entry.branches.some((claim) => claim.branch === 'workflow-directory-collision')
  )
  const directoryFileConflict = byBranch['workflow-directory-collision'].overlaps.find((entry) =>
    entry.branches.some((claim) => claim.branch === 'workflow-file-collision')
  )
  assert.equal(fileDirectoryConflict.verdict, 'conflict')
  assert.ok(fileDirectoryConflict.path.startsWith('path-collision'))
  assert.deepEqual(fileDirectoryConflict.branches, [
    { branch: 'workflow-directory-collision', source: 'committed' }
  ])
  assert.equal(directoryFileConflict.verdict, 'conflict')
  assert.ok(directoryFileConflict.path.startsWith('path-collision'))

  // Both committed an incompatible change to shared.txt, so this is a proven conflict - and the
  // repo's own dirty checkout is named alongside the sibling workspace.
  assert.equal(overlap('workflow-one', 'shared.txt').verdict, 'conflict')
  assert.equal(overlap('workflow-one', 'shared.txt').source, 'committed')
  assert.deepEqual(overlap('workflow-one', 'shared.txt').branches, [
    { branch: 'main', source: 'working' },
    { branch: 'workflow-two', source: 'committed' }
  ])
  assert.equal(overlap('workflow-two', 'shared.txt').verdict, 'conflict')

  // A staged-but-uncommitted rename cannot be merge-tested, so it must not be promoted past overlap.
  assert.equal(overlap('workflow-one', 'rename-old.txt').verdict, 'overlap')
  assert.equal(overlap('workflow-one', 'rename-old.txt').source, 'working')
  assert.deepEqual(overlap('workflow-one', 'rename-old.txt').branches, [
    { branch: 'workflow-two', source: 'working' }
  ])

  // wide.txt is claimed only by workspaces that committed it, so an unproven verdict there would
  // mean the merge failed to evaluate rather than someone leaving work uncommitted.
  assert.ok(
    overlap('workflow-one', 'wide.txt').branches.every((c) => c.source === 'committed'),
    'expected every wide.txt claimant to be committed'
  )

  // The false positive this whole change exists to kill: both committed to wide.txt, but the hunks
  // are disjoint, so the merge was tested and came back clean - reported as such, not as a conflict
  // and not as the untested `overlap` a path nothing could evaluate gets.
  assert.equal(overlap('workflow-one', 'wide.txt').verdict, 'clean')
  assert.equal(overlap('workflow-one', 'wide.txt').source, 'committed')
  assert.equal(overlap('workflow-three', 'wide.txt').verdict, 'clean')

  // Committing and then editing the same path retains both facts: the committed tips can still be
  // evaluated, but their clean merge cannot prove anything about the dirty content left behind.
  assert.deepEqual(overlap('workflow-one', 'mixed.txt'), {
    path: 'mixed.txt',
    verdict: 'overlap',
    source: 'working',
    branches: [{ branch: 'workflow-three', source: 'committed' }]
  })
  assert.equal(overlap('workflow-three', 'mixed.txt').verdict, 'overlap')

  // shared.txt is claimed by three participants, one of them the repo's dirty checkout, which no
  // merge can test - so it never reads as clean for anyone even though two sides did commit it.
  assert.notEqual(overlap('workflow-two', 'shared.txt').verdict, 'clean')

  // A path only one workspace touches, and that the default branch has not moved under, is not an
  // overlap at all.
  assert.equal(overlap('workflow-one', 'rename-new.txt'), undefined)

  // Drift against the default branch is an ordinary conflict row naming the default branch as the
  // claimant - not a channel of its own - so it sorts, caps and counts with everything else.
  assert.deepEqual(overlap('workflow-stale', 'drift.txt'), {
    path: 'drift.txt',
    verdict: 'conflict',
    source: 'committed',
    branches: [{ branch: 'main', source: 'committed' }]
  })
  assert.equal(byBranch['workflow-stale'].overlapTotals.conflict, 1)

  // A workspace that merges cleanly with the default branch gets no such row.
  assert.ok(
    !byBranch['workflow-one'].overlaps.some((entry) =>
      entry.branches.some((claim) => claim.branch === 'main' && claim.source === 'committed')
    ),
    'expected workflow-one not to drift against the default branch'
  )

  // The repository's own dirty checkout participates but never becomes a row of its own.
  assert.ok(!('main' in byBranch))

  // Nonaffiliated sessions compare both local main and origin/main. Real committed conflicts are
  // red; working-tree changes on a path either main changed stay explicitly unproven.
  const looseComparison = await describeSessionComparison(loose)
  assert.equal(looseComparison.branch, 'session-loose')
  assert.equal(looseComparison.defaultBranch, 'main')
  assert.deepEqual(looseComparison.overlapTotals, { conflict: 2, overlap: 1, clean: 0 })
  assert.deepEqual(
    Object.fromEntries(looseComparison.overlaps.map((entry) => [entry.path, entry])),
    {
      'drift.txt': {
        path: 'drift.txt',
        verdict: 'conflict',
        source: 'committed',
        branches: [
          { branch: 'main (local)', source: 'committed' },
          { branch: 'origin/main', source: 'committed' }
        ]
      },
      'local-drift.txt': {
        path: 'local-drift.txt',
        verdict: 'conflict',
        source: 'committed',
        branches: [{ branch: 'main (local)', source: 'committed' }]
      },
      'working-drift.txt': {
        path: 'working-drift.txt',
        verdict: 'overlap',
        source: 'working',
        branches: [
          { branch: 'main (local)', source: 'committed' },
          { branch: 'origin/main', source: 'committed' }
        ]
      }
    }
  )

  // An older git (or any failed merge-tree evaluation) falls back to the paths committed on both
  // sides. They remain visible as unproven instead of disappearing as though nothing overlapped.
  const fallbackBundle = path.join(scratch, 'workflow-review-no-merge-tree.cjs')
  await build({
    absWorkingDir: root,
    stdin: {
      contents: `export { describeSessionComparison } from './src/main/workflow.ts';`,
      resolveDir: root,
      sourcefile: 'workflow-review-no-merge-tree-entry.ts'
    },
    outfile: fallbackBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: 'merge-tree-unavailable',
        setup(buildApi) {
          buildApi.onResolve({ filter: /^\.\/mergeCheck$/ }, () => ({
            path: 'mergeCheck',
            namespace: 'merge-tree-unavailable'
          }))
          buildApi.onLoad({ filter: /.*/, namespace: 'merge-tree-unavailable' }, () => ({
            contents: 'export async function conflictingPaths() { return null }',
            loader: 'js'
          }))
        }
      },
      electronFacade
    ]
  })
  const { describeSessionComparison: describeWithoutMergeTree } = require(fallbackBundle)
  const fallbackComparison = await describeWithoutMergeTree(loose)
  assert.deepEqual(fallbackComparison.overlapTotals, { conflict: 0, overlap: 3, clean: 0 })
  assert.deepEqual(
    Object.fromEntries(fallbackComparison.overlaps.map((entry) => [entry.path, entry])),
    {
      'drift.txt': {
        path: 'drift.txt',
        verdict: 'overlap',
        source: 'committed',
        branches: [
          { branch: 'main (local)', source: 'committed' },
          { branch: 'origin/main', source: 'committed' }
        ]
      },
      'local-drift.txt': {
        path: 'local-drift.txt',
        verdict: 'overlap',
        source: 'committed',
        branches: [{ branch: 'main (local)', source: 'committed' }]
      },
      'working-drift.txt': {
        path: 'working-drift.txt',
        verdict: 'overlap',
        source: 'working',
        branches: [
          { branch: 'main (local)', source: 'committed' },
          { branch: 'origin/main', source: 'committed' }
        ]
      }
    }
  )

  const cached = mergeRuns()
  await describe()
  assert.equal(mergeRuns(), cached, 'expected an unchanged repository to reuse cached merges')

  process.stdout.write('workflow default-ref and cross-workflow overlap simulations passed\n')
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
