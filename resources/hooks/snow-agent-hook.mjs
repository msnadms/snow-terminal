import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const stateByEvent = {
  SessionStart: 'idle',
  UserPromptSubmit: 'busy',
  PreToolUse: 'busy',
  PostToolUse: 'busy',
  SubagentStart: 'busy',
  SubagentStop: 'busy',
  Stop: 'idle',
  StopFailure: 'idle'
}

// The events that mean the turn itself is over, rather than merely that the agent is not running
// something this instant. Only an `idle` one of these wrote can silence a later busy event.
const turnEndEvents = new Set(['Stop', 'StopFailure'])

// Claude emits both user-blocking notifications and routine status notices such as auth success.
// Only the former should make a workspace look like it needs operator attention.
const attentionNotifications = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input'
])

const markerPrefix = 'snow-wf:'
const assignmentPrefix = /^[A-Za-z_][A-Za-z0-9_]*=/
const shellWrappers = new Set(['sh', 'bash', 'zsh'])
// Wrappers that run the rest of the line as a command of their own, with operands of their own
// (`timeout 10 git …`, `nice -n 5 git …`). Their argument shapes differ, so the scan below looks
// for the git token rather than trying to model each one.
const commandWrappers = new Set([
  'command',
  'doas',
  'env',
  'exec',
  'ionice',
  'nice',
  'nohup',
  'stdbuf',
  'sudo',
  'time',
  'timeout',
  'xargs'
])
// A segment can begin mid-construct: `for f in x; do git stash pop; done` splits to ` do git …`.
const shellKeywords = new Set(['!', '{', '}', 'do', 'elif', 'else', 'if', 'then', 'until', 'while'])
const safeStashSubcommands = new Set(['list', 'show'])
// Creating a stash only ever adds to the list; it cannot consume another workspace's parked work,
// and snow re-lists under the shared lock before every apply so a shifted selector is not a hazard.
// The one thing an agent must not do is forge a marker snow would later restore as its own.
const createStashSubcommands = new Set(['push', 'save'])
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
  if (!['PreToolUse', 'PermissionRequest', 'PostToolUse'].includes(event.hook_event_name)) return ''
  const tool = clip(event.tool_name, 40) || 'Tool'
  const target = toolTarget(event.tool_input)
  return target ? `${tool} ${target}` : tool
}

/**
 * `attention` is the one state no later event refreshes - nothing happens until a human acts - so
 * it is also the one this hook must not lose quietly. A notification that reports *no* type is a
 * contract that changed underneath us, and reading it as routine would retire the whole signal
 * fleet-wide with nothing on screen to say so; it fails loud instead. A type Claude Code did report
 * but this list does not name is a notice it has classified as something else, and is believed.
 */
function stateFor(event, previous) {
  if (event.hook_event_name === 'PermissionRequest') return 'attention'
  if (event.hook_event_name === 'Notification') {
    const type = event.notification_type
    if (typeof type !== 'string' || !type) return 'attention'
    // This is a delayed "Claude finished" reminder, not a request that blocked the agent. Writing
    // idle also repairs a missed Stop event while leaving review readiness to the Git state.
    if (type === 'idle_prompt') return 'idle'
    return attentionNotifications.has(type) ? 'attention' : null
  }
  // Auto-compaction restarts the session in the middle of a turn, so its SessionStart reports a
  // context event rather than a lifecycle one: the agent was working before it and is working
  // after it. Writing `idle` here is what the guard below would then read as a finished turn.
  if (event.hook_event_name === 'SessionStart' && event.source === 'compact') return null
  // AskUserQuestion is itself the point where Claude yields to the operator. Do not depend on a
  // separate Notification arriving afterward: clients and Claude Code versions can omit or delay
  // that notification, while PreToolUse already tells us unambiguously that input is required.
  if (event.hook_event_name === 'PreToolUse' && event.tool_name === 'AskUserQuestion')
    return 'attention'
  // Claude's away-recap generator runs an internal prompt/fork a few minutes after Stop, retaining
  // the completed turn's prompt_id. Letting any of its late events raise idle back to busy pins the
  // status until the next real turn, so the guard belongs to the transition rather than to the two
  // event names that first showed it: every busy-producing event inherits it, and a genuine prompt
  // is unaffected because it carries a new correlation id.
  //
  // It applies only to an idle the turn's *end* wrote (or an idle prompt that recovered a missed
  // Stop). An `idle_prompt` after an attention notification can instead be emitted while a
  // permission prompt sits unanswered; suppressing that prompt's remaining events would pin
  // `idle` over an agent that resumed working.
  const next = stateByEvent[event.hook_event_name] ?? null
  const promptId = text(event.prompt_id)
  if (
    next === 'busy' &&
    previous?.state === 'idle' &&
    previous.turnEnded === true &&
    promptId &&
    previous.promptId === promptId
  )
    return null
  return next
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

function commandName(token) {
  return path
    .basename(token ?? '')
    .replace(/\.exe$/i, '')
    .toLowerCase()
}

function commandAt(tokens, start = 0) {
  let i = start
  while (i < tokens.length && (assignmentPrefix.test(tokens[i]) || shellKeywords.has(tokens[i])))
    i += 1
  return { index: i, name: commandName(tokens[i] ?? '') }
}

function gitArgs(tokens) {
  const { index, name } = commandAt(tokens)
  if (name !== 'git') return null
  let i = index + 1
  while (i < tokens.length) {
    if (!tokens[i].startsWith('-')) return tokens.slice(i)
    i += gitValueFlags.has(tokens[i]) ? 2 : 1
  }
  return null
}

/**
 * A direct `git` command is the common case. Recognize the two lightweight wrappers agents use
 * as well, without interpreting an arbitrary string such as `rg stash` as a shell wrapper that
 * might write the shared stash.
 */
function wrappedGitArgs(tokens) {
  const direct = gitArgs(tokens)
  if (direct) return direct

  const { index, name } = commandAt(tokens)
  // Each wrapper takes its own flags and operands, so scan for the git token rather than modelling
  // every one. The scan is gated on a recognized wrapper, so `rg stash` is still just a search.
  if (commandWrappers.has(name)) {
    for (let i = index + 1; i < tokens.length; i += 1) {
      if (commandName(tokens[i]) === 'git') return gitArgs(tokens.slice(i))
    }
    return null
  }
  if (shellWrappers.has(name)) {
    // Shells accept bundled short flags, e.g. `bash -lc "git stash pop"`.
    const flag = tokens.findIndex(
      (token, i) => i > index && (token === '-c' || /^-[^-]*c/.test(token))
    )
    return flag < 0 ? null : wrappedGitArgs(tokenize(tokens[flag + 1] ?? ''))
  }
  return null
}

/**
 * A stash whose message carries snow's own marker would be restored later as a workspace's parked
 * work. Nothing else about creating a stash is hazardous, so this is the only thing push has to be
 * checked for - and any token mentioning the marker is enough to ask. Parsing out which of `-m`,
 * `-m<msg>`, `--message=` or a bare `save` message carried it would only re-derive the same answer,
 * and over-blocking is safe here: a real pathspec is not named after the marker.
 */
function forgesMarker(rest) {
  return rest.some((arg) => arg.includes(markerPrefix))
}

/**
 * `refs/stash` is shared by every worktree of a repository, so `stash@{0}` in a parallel session is
 * whatever was pushed last anywhere in the repo - which may be another workspace's parked work. An
 * explicit stash selector is not enough either: another worktree can push before the command runs
 * and shift every selector, so agents restore through the helper below, which resolves the marker
 * their own workspace owns under the same lock snow takes.
 *
 * Only the consuming half is refused. Blocking `git stash push` as well would take away an ordinary
 * move ("stash this and try something else") and leave nothing in its place, and creating a stash
 * cannot consume anyone's parked work - it only appends.
 */
function takesSharedStash(command) {
  for (const segment of command.split(/&&|\|\||[;\n|()]/)) {
    if (!segment.includes('stash')) continue
    const args = wrappedGitArgs(tokenize(segment))
    // A mention of "stash" is not itself a stash operation: agents need to search and discuss it.
    if (!args || args[0] !== 'stash') continue
    const rest = args.slice(1)
    if (rest.some((arg) => arg === '--help' || arg === '-h')) continue
    const subcommand = rest.find((arg) => !arg.startsWith('-'))
    // A bare `git stash`, or one carrying only flags, is a push.
    if (!subcommand || createStashSubcommands.has(subcommand)) {
      if (forgesMarker(rest)) return true
      continue
    }
    if (!safeStashSubcommands.has(subcommand)) return true
  }
  return false
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function workflowRecords() {
  const raw = JSON.parse(fs.readFileSync(path.join(configRoot(), '.snowworkflows'), 'utf8'))
  const records = Array.isArray(raw?.workflows) ? raw.workflows : []
  return records
    .map((record) => {
      const repo = record && text(record.repo)
      const branch = record && text(record.branch)
      if (!repo || !branch) return null
      const worktree = text(record.worktree)
      return {
        repo: expandHome(repo),
        branch,
        worktree: worktree ? expandHome(worktree) : null
      }
    })
    .filter(Boolean)
}

/**
 * The two questions the registry answers about a directory, kept apart because they have different
 * answers and different costs. Both cover a repository's *own* checkout as well as a linked
 * worktree: park-mode markers are created in the main worktree, by the pane that left the branch,
 * so guarding only linked worktrees left the guard off where the markers are actually minted.
 *
 * Is anything snow parks reachable from here? A pure path comparison, so the refusal path - which
 * runs on every tool call mentioning "stash" - never spawns Git.
 */
function guardedScope(cwd) {
  const records = workflowRecords()
  const owned = records.find((record) => record.worktree && inside(cwd, record.worktree))
  if (owned) return { label: `this workspace (${owned.branch})` }
  if (records.some((record) => !record.worktree && inside(cwd, record.repo)))
    return { label: 'the branch checked out here' }
  return null
}

/** And: whose parked work is it? Only the explicit restore needs this, so only it pays for Git. */
function ownedBranch(cwd) {
  const records = workflowRecords()
  const owned = records.find((record) => record.worktree && inside(cwd, record.worktree))
  if (owned) return owned.branch

  const parkable = records.filter((record) => !record.worktree && inside(cwd, record.repo))
  if (!parkable.length) return null
  const branch = currentBranch(cwd)
  return parkable.some((record) => record.branch === branch) ? branch : null
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

// `windowsHide` is the easy one to forget, and forgetting it flashes a console window on every
// tool call this hook runs for.
function gitOut(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function currentBranch(cwd) {
  try {
    const raw = gitOut(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    return raw && raw !== 'HEAD' ? raw : null
  } catch {
    return null
  }
}

function sharedStashLock(cwd) {
  const raw = gitOut(cwd, ['rev-parse', '--git-common-dir']).trim()
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
  const raw = gitOut(cwd, ['stash', 'list', '--format=%gd%x1f%gs'])
  const marker = `${markerPrefix}${branch}`
  for (const line of raw.split(/\r?\n/)) {
    const [selector, subject] = line.split('\x1f', 2)
    if (!selector || !subject) continue
    if (subject === marker || subject.endsWith(`: ${marker}`)) return selector
  }
  return null
}

function restoreMarkedStash() {
  const branch = ownedBranch(process.cwd())
  if (!branch)
    throw new Error(
      'No registered snow workspace owns this directory, or its branch is not one snow parks.'
    )
  const lock = acquireSharedStashLock(process.cwd())
  try {
    const selector = markerSelector(process.cwd(), branch)
    if (!selector) throw new Error(`No parked ${markerPrefix}${branch} stash was found.`)
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
  // Keyed on the shape rather than a tool name: Bash and PowerShell are two of them today, and
  // anything else that hands a shell string to the same worktree needs the same guard.
  const command = event.tool_input?.command
  const cwd = event.cwd
  if (typeof command !== 'string' || typeof cwd !== 'string' || !cwd) return null
  if (!command.includes('stash') || !takesSharedStash(command)) return null

  const scope = guardedScope(cwd)
  if (!scope) return null

  return [
    `Every worktree of a repository shares one stash list, and snow parks workspace changes in`,
    `this one. Restoring, dropping or clearing a stash by hand here can consume another`,
    `workspace's parked work, so those are blocked. Creating one is not: git stash push is fine,`,
    `as long as its message does not impersonate a "${markerPrefix}" marker.`,
    ``,
    `To restore the parked changes belonging to ${scope.label}, run:`,
    `  ${helperCommand()}`
  ].join('\n')
}

function decide(permissionDecision, reason) {
  fs.writeSync(
    1,
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision,
        permissionDecisionReason: reason,
        ...(permissionDecision === 'ask' ? { additionalContext: reason } : {})
      }
    })
  )
}

function warn(reason) {
  fs.writeSync(1, JSON.stringify({ systemMessage: reason }))
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

function readRecord(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    return record && typeof record === 'object' ? record : null
  } catch {
    return null
  }
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

  const previous = readRecord(file)
  const state = stateFor(event, previous)
  if (!state) return

  const refusal = event.hook_event_name === 'PreToolUse' ? stashRefusal(event) : null
  const protection = refusal ? stashProtection() : 'off'
  const detail =
    refusal && protection === 'warn'
      ? [detailFor(event), 'shared-stash warning'].filter(Boolean).join(' · ')
      : detailFor(event)
  // Carried forward, because the events that end a turn do not all re-report the id the guard in
  // `stateFor` compares against.
  const promptId = text(event.prompt_id) ?? text(previous?.promptId)
  const turnEnded =
    turnEndEvents.has(event.hook_event_name) ||
    (event.hook_event_name === 'Notification' &&
      event.notification_type === 'idle_prompt' &&
      ((previous?.turnEnded === true && promptId === text(previous.promptId)) ||
        previous?.state === 'busy'))

  fs.mkdirSync(dir, { recursive: true })
  const terminalBinding = text(process.env.SNOW_AGENT_BINDING)
  const terminalOwner = text(process.env.SNOW_AGENT_OWNER)
  const legacyTerminal = text(process.env.SNOW_AGENT_TERMINAL)
  writeRecord(file, {
    sessionId: event.session_id,
    // New Snow instances use fields older releases do not recognize. An older app therefore reads
    // this as an external session instead of deleting it because the binding is absent from that
    // app's in-memory terminal registry. Keep the legacy field for terminals spawned by an older
    // Snow release whose environment cannot provide the owner pair.
    ...(terminalBinding && terminalOwner
      ? { terminalBinding, terminalOwner }
      : legacyTerminal
        ? { terminal: legacyTerminal }
        : {}),
    cwd: typeof event.cwd === 'string' ? event.cwd : '',
    state,
    detail,
    ...(promptId ? { promptId } : {}),
    ...(turnEnded ? { turnEnded: true } : {}),
    agent: process.argv[2] === 'codex' ? 'codex' : 'claude',
    updated: Date.now()
  })

  // Anything that throws on the way here leaves the command allowed: a registry snow cannot read
  // must never block the user's git.
  if (event.hook_event_name !== 'PreToolUse') return
  if (protection === 'deny') decide('deny', refusal)
  else if (protection === 'warn') {
    // Codex deliberately does not support `permissionDecision: "ask"` on PreToolUse. Its supported
    // non-blocking equivalent is a visible system warning; Claude keeps its interactive prompt.
    if (process.argv[2] === 'codex') warn(refusal)
    else decide('ask', refusal)
  }
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
