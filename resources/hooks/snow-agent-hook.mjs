import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const stateByEvent = {
  SessionStart: 'idle',
  UserPromptSubmit: 'busy',
  PreToolUse: 'busy',
  SubagentStop: 'busy',
  Notification: 'attention',
  Stop: 'idle'
}

const markerPrefix = 'snow-wf:'
const safeStashSubcommands = new Set(['list', 'show'])
const stashProtectionModes = new Set(['warn', 'deny', 'off'])
const stashLockName = 'snow-stash.lock'
const stashLockOwner = 'owner.json'
const gitValueFlags = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env'
])

function configRoot() {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config')
  return path.join(base, 'snow')
}

function agentsDir() {
  return path.join(configRoot(), 'agents')
}

function clip(value, limit) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function toolTarget(input) {
  if (!input || typeof input !== 'object') return ''
  if (typeof input.command === 'string') return clip(input.command, 80)
  if (typeof input.file_path === 'string') return path.basename(input.file_path)
  if (typeof input.notebook_path === 'string') return path.basename(input.notebook_path)
  if (typeof input.pattern === 'string') return clip(input.pattern, 40)
  if (typeof input.url === 'string') return clip(input.url, 60)
  if (typeof input.subagent_type === 'string') return clip(input.subagent_type, 40)
  if (typeof input.description === 'string') return clip(input.description, 60)
  return ''
}

function detailFor(event) {
  if (event.hook_event_name === 'Notification') return clip(event.message, 160)
  if (event.hook_event_name !== 'PreToolUse') return ''
  const tool = clip(event.tool_name, 40) || 'Tool'
  const target = toolTarget(event.tool_input)
  return target ? `${tool} ${target}` : tool
}

function sessionFile(dir, sessionId) {
  const safe = String(sessionId ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .slice(0, 96)
  return safe ? path.join(dir, `${safe}.json`) : null
}

function expandHome(p) {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

function normalize(p) {
  const slashed = path.resolve(p).split(path.sep).join('/').replace(/\/+$/, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

function inside(child, parent) {
  const c = normalize(child)
  const p = normalize(parent)
  return c === p || c.startsWith(`${p}/`)
}

function tokenize(segment) {
  const tokens = []
  let current = null
  let quote = null
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i]
    if (quote) {
      if (c === quote) quote = null
      else current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current = current ?? ''
      continue
    }
    if (c === '\\' && i + 1 < segment.length) {
      i += 1
      current = (current ?? '') + segment[i]
      continue
    }
    if (/\s/.test(c)) {
      if (current !== null) tokens.push(current)
      current = null
      continue
    }
    current = (current ?? '') + c
  }
  if (current !== null) tokens.push(current)
  return tokens
}

function gitArgs(tokens) {
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1
  const name = path.basename(tokens[i] ?? '').replace(/\.exe$/i, '')
  if (name.toLowerCase() !== 'git') return null
  i += 1
  while (i < tokens.length) {
    if (!tokens[i].startsWith('-')) return tokens.slice(i)
    i += gitValueFlags.has(tokens[i]) ? 2 : 1
  }
  return null
}

/**
 * `refs/stash` is shared by every worktree of a repository, so `stash@{0}` in a parallel session is
 * whatever was pushed last anywhere in the repo - which may be another workflow's parked work.
 * An explicit stash selector is not enough: another worktree can change its index before the command
 * runs, so agents use the helper below to resolve the marker owned by their own workspace.
 */
function takesSharedStash(command) {
  for (const segment of command.split(/&&|\|\||[;\n|]/)) {
    if (!segment.includes('stash')) continue
    const args = gitArgs(tokenize(segment))
    // Shell wrappers (for example `sh -c`, `env`, or a function) cannot be proven read-only from
    // the outer command. Deny them rather than letting a wrapper evade workspace protection.
    if (!args || args[0] !== 'stash') return true
    const rest = args.slice(1)
    const subcommand = rest.find((arg) => !arg.startsWith('-'))
    if (!subcommand || !safeStashSubcommands.has(subcommand)) return true
  }
  return false
}

function workflowWorktrees() {
  const raw = JSON.parse(fs.readFileSync(path.join(configRoot(), '.snowworkflows'), 'utf8'))
  const records = Array.isArray(raw?.workflows) ? raw.workflows : []
  return records
    .filter(
      (record) =>
        record &&
        typeof record.branch === 'string' &&
        record.branch.trim() &&
        typeof record.worktree === 'string' &&
        record.worktree.trim()
    )
    .map((record) => ({
      branch: record.branch.trim(),
      worktree: expandHome(record.worktree.trim())
    }))
}

function workspaceFor(cwd) {
  return workflowWorktrees().find((record) => inside(cwd, record.worktree)) ?? null
}

function helperCommand() {
  const file = path.join(
    configRoot(),
    'hooks',
    process.platform === 'win32' ? 'snow-workspace-stash.cmd' : 'snow-workspace-stash'
  )
  const command = process.platform === 'win32' ? file.split(path.sep).join('/') : file
  return `"${command}" restore`
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function sharedStashLock(cwd) {
  const raw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  }).trim()
  if (!raw) throw new Error("Could not locate this repository's shared Git directory.")
  const common = path.resolve(path.isAbsolute(raw) ? raw : path.join(cwd, raw))
  return {
    directory: path.join(common, stashLockName),
    owner: path.join(common, stashLockName, stashLockOwner)
  }
}

function releaseStashLock(lock) {
  try {
    fs.unlinkSync(lock.owner)
  } catch {
    // The lock may already have been cleaned after a failed acquire.
  }
  try {
    fs.rmdirSync(lock.directory)
  } catch {
    // Do not remove an unexpected non-empty directory.
  }
}

function clearAbandonedStashLock(lock) {
  let raw = null
  try {
    raw = fs.readFileSync(lock.owner, 'utf8')
  } catch {
    try {
      if (Date.now() - fs.statSync(lock.directory).mtimeMs < 5000) return
    } catch {
      return
    }
  }

  let live = false
  if (raw) {
    try {
      live = processIsAlive(JSON.parse(raw).pid)
    } catch {
      // A malformed owner record is abandoned and can be recovered below.
    }
  }
  if (live) return
  try {
    fs.unlinkSync(lock.owner)
  } catch {
    // No owner file is safe to continue with; rmdir below will still verify emptiness.
  }
  try {
    fs.rmdirSync(lock.directory)
  } catch {
    // A live owner may have written its record while this stale check was running.
  }
}

function acquireSharedStashLock(cwd) {
  const lock = sharedStashLock(cwd)
  const deadline = Date.now() + 3000
  while (true) {
    try {
      fs.mkdirSync(lock.directory)
      fs.writeFileSync(lock.owner, `${JSON.stringify({ pid: process.pid })}\n`, { flag: 'wx' })
      return lock
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      clearAbandonedStashLock(lock)
      if (Date.now() >= deadline)
        throw new Error('Another Snow workspace is updating the shared stash; try again shortly.')
      sleep(50)
    }
  }
}

function markerSelector(cwd, branch) {
  const raw = execFileSync('git', ['stash', 'list', '--format=%gd%x1f%gs'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  })
  const marker = `${markerPrefix}${branch}`
  for (const line of raw.split(/\r?\n/)) {
    const [selector, subject] = line.split('\x1f', 2)
    if (!selector || !subject) continue
    if (subject === marker || subject.endsWith(`: ${marker}`)) return selector
  }
  return null
}

function restoreMarkedStash() {
  const workspace = workspaceFor(process.cwd())
  if (!workspace) throw new Error('This directory is not a registered snow workspace.')
  const lock = acquireSharedStashLock(process.cwd())
  try {
    const selector = markerSelector(process.cwd(), workspace.branch)
    if (!selector) throw new Error(`No parked ${markerPrefix}${workspace.branch} stash was found.`)
    try {
      execFileSync('git', ['stash', 'pop', '--index', selector], {
        cwd: process.cwd(),
        stdio: 'inherit',
        windowsHide: true
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (!/conflicts in index\. Try without --index/i.test(detail)) throw error
      execFileSync('git', ['stash', 'pop', selector], {
        cwd: process.cwd(),
        stdio: 'inherit',
        windowsHide: true
      })
    }
  } finally {
    releaseStashLock(lock)
  }
}

function stashProtection() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configRoot(), '.snowconfig'), 'utf8'))
    const value =
      typeof raw?.workflowStashProtection === 'string'
        ? raw.workflowStashProtection.trim().toLowerCase()
        : null
    return stashProtectionModes.has(value) ? value : 'deny'
  } catch {
    return 'deny'
  }
}

function stashRefusal(event) {
  if (event.tool_name !== 'Bash') return null
  const command = event.tool_input?.command
  const cwd = event.cwd
  if (typeof command !== 'string' || typeof cwd !== 'string' || !cwd) return null
  if (!command.includes('stash') || !takesSharedStash(command)) return null

  const workspace = workspaceFor(cwd)
  if (!workspace) return null

  return [
    `This directory is a snow workspace worktree, and every worktree of a repository shares one`,
    `stash list. Raw git stash writes and restores are blocked here so an agent cannot affect`,
    `another workspace's parked changes.`,
    ``,
    `To restore this workspace's parked changes, run:`,
    `  ${helperCommand()}`
  ].join('\n')
}

function deny(reason) {
  fs.writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    })
  )
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function writeRecord(file, record) {
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`)
  fs.renameSync(temp, file)
}

async function main() {
  const event = JSON.parse(await readStdin())
  const dir = agentsDir()
  const file = sessionFile(dir, event.session_id)
  if (!file) return

  if (event.hook_event_name === 'SessionEnd') {
    fs.rmSync(file, { force: true })
    return
  }

  const state = stateByEvent[event.hook_event_name]
  if (!state) return

  const refusal = event.hook_event_name === 'PreToolUse' ? stashRefusal(event) : null
  const protection = refusal ? stashProtection() : 'off'
  const detail =
    refusal && protection === 'warn'
      ? [detailFor(event), 'shared-stash warning'].filter(Boolean).join(' · ')
      : detailFor(event)

  fs.mkdirSync(dir, { recursive: true })
  writeRecord(file, {
    sessionId: event.session_id,
    parentSessionId: typeof event.parent_session_id === 'string' ? event.parent_session_id : '',
    cwd: typeof event.cwd === 'string' ? event.cwd : '',
    state,
    detail,
    task: typeof event.task_description === 'string' ? clip(event.task_description, 160) : '',
    agent: 'claude',
    updated: Date.now()
  })

  // Anything that throws on the way here leaves the command allowed: a registry snow cannot read
  // must never block the user's git.
  if (event.hook_event_name !== 'PreToolUse') return
  if (refusal && protection === 'deny') deny(refusal)
}

// A hook that fails or hangs degrades the session it is attached to, and a status badge is not
// worth that: every path here exits 0, the only thing ever written to stdout is a deliberate
// refusal, and the timer covers a stdin that never closes.
if (process.argv[2] === 'restore') {
  try {
    restoreMarkedStash()
  } catch (error) {
    fs.writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
} else {
  const guard = setTimeout(() => process.exit(0), 5000)

  main()
    .catch(() => {})
    .finally(() => {
      clearTimeout(guard)
      process.exit(0)
    })
}
