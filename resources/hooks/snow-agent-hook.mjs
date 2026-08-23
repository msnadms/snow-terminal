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

function agentsDir() {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config')
  return path.join(base, 'snow', 'agents')
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
}

// A hook that fails, prints, or hangs degrades the session it is attached to, and a status badge
// is not worth that: every path here exits 0 silently, and the timer covers a stdin that never
// closes.
const guard = setTimeout(() => process.exit(0), 5000)

main()
  .catch(() => {})
  .finally(() => {
    clearTimeout(guard)
    process.exit(0)
  })
