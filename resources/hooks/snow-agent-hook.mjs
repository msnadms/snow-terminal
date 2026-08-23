import fs from 'fs'
import os from 'os'
import path from 'path'

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
 * whatever was pushed last anywhere in the repo - which may be another workflow's parked work. A
 * command that names its entry, or carries snow's own park marker, knows which one it means.
 */
function takesSharedStash(command) {
  for (const segment of command.split(/&&|\|\||[;\n|]/)) {
    const args = gitArgs(tokenize(segment))
    if (!args || args[0] !== 'stash') continue
    const rest = args.slice(1)
    const subcommand = rest.find((arg) => !arg.startsWith('-'))
    if (subcommand && safeStashSubcommands.has(subcommand)) continue
    if (rest.some((arg) => arg.includes('stash@{') || arg.includes(markerPrefix))) continue
    return true
  }
  return false
}

function workflowWorktrees() {
  const raw = JSON.parse(fs.readFileSync(path.join(configRoot(), '.snowworkflows'), 'utf8'))
  const records = Array.isArray(raw?.workflows) ? raw.workflows : []
  return records
    .filter((record) => record && typeof record.worktree === 'string')
    .map((record) => expandHome(record.worktree.trim()))
    .filter(Boolean)
}

function stashRefusal(event) {
  if (event.tool_name !== 'Bash') return null
  const command = event.tool_input?.command
  const cwd = event.cwd
  if (typeof command !== 'string' || typeof cwd !== 'string' || !cwd) return null
  if (!command.includes('stash') || !takesSharedStash(command)) return null

  const worktree = workflowWorktrees().find((dir) => inside(cwd, dir))
  if (!worktree) return null

  return [
    `This directory is a snow workflow worktree, and every worktree of a repository shares one`,
    `stash list. A stash command that does not name its entry can push onto, or consume, another`,
    `workflow's parked changes - including work snow parked when leaving a branch.`,
    ``,
    `Run "git stash list" and address the entry explicitly, e.g. git stash pop "stash@{2}".`
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

  fs.mkdirSync(dir, { recursive: true })
  writeRecord(file, {
    sessionId: event.session_id,
    cwd: typeof event.cwd === 'string' ? event.cwd : '',
    state,
    detail: detailFor(event),
    agent: 'claude',
    updated: Date.now()
  })

  // Anything that throws on the way here leaves the command allowed: a registry snow cannot read
  // must never block the user's git.
  if (event.hook_event_name !== 'PreToolUse') return
  const refusal = stashRefusal(event)
  if (refusal) deny(refusal)
}

// A hook that fails or hangs degrades the session it is attached to, and a status badge is not
// worth that: every path here exits 0, the only thing ever written to stdout is a deliberate
// refusal, and the timer covers a stdin that never closes.
const guard = setTimeout(() => process.exit(0), 5000)

main()
  .catch(() => {})
  .finally(() => {
    clearTimeout(guard)
    process.exit(0)
  })
