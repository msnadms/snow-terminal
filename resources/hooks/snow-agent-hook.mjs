import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const startedAt = Date.now()

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

const turnEndEvents = new Set(['Stop', 'StopFailure'])

const attentionNotifications = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input'
])

const markerPrefix = 'snow-wf:'
const assignmentPrefix = /^[A-Za-z_][A-Za-z0-9_]*=/
const shellWrappers = new Set(['sh', 'bash', 'zsh'])
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
const shellKeywords = new Set(['!', '{', '}', 'do', 'elif', 'else', 'if', 'then', 'until', 'while'])
const safeStashSubcommands = new Set(['list', 'show'])
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

function stateFor(event, previous) {
  if (event.hook_event_name === 'PermissionRequest') return 'attention'
  if (event.hook_event_name === 'Notification') {
    const type = event.notification_type
    if (typeof type !== 'string' || !type) return 'attention'
    if (type === 'idle_prompt') return 'idle'
    return attentionNotifications.has(type) ? 'attention' : null
  }
  if (event.hook_event_name === 'SessionStart' && event.source === 'compact') return null
  if (event.hook_event_name === 'PreToolUse' && event.tool_name === 'AskUserQuestion')
    return 'attention'
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

function wrappedGitArgs(tokens) {
  const direct = gitArgs(tokens)
  if (direct) return direct

  const { index, name } = commandAt(tokens)
  if (commandWrappers.has(name)) {
    for (let i = index + 1; i < tokens.length; i += 1) {
      if (commandName(tokens[i]) === 'git') return gitArgs(tokens.slice(i))
    }
    return null
  }
  if (shellWrappers.has(name)) {
    const flag = tokens.findIndex(
      (token, i) => i > index && (token === '-c' || /^-[^-]*c/.test(token))
    )
    return flag < 0 ? null : wrappedGitArgs(tokenize(tokens[flag + 1] ?? ''))
  }
  return null
}

function forgesMarker(rest) {
  return rest.some((arg) => arg.includes(markerPrefix))
}

function takesSharedStash(command) {
  for (const segment of command.split(/&&|\|\||[;\n|()]/)) {
    if (!segment.includes('stash')) continue
    const args = wrappedGitArgs(tokenize(segment))
    if (!args || args[0] !== 'stash') continue
    const rest = args.slice(1)
    if (rest.some((arg) => arg === '--help' || arg === '-h')) continue
    const subcommand = rest.find((arg) => !arg.startsWith('-'))
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

function guardedScope(cwd) {
  const records = workflowRecords()
  const owned = records.find((record) => record.worktree && inside(cwd, record.worktree))
  if (owned) return { label: `this workspace (${owned.branch})` }
  if (records.some((record) => !record.worktree && inside(cwd, record.repo)))
    return { label: 'the branch checked out here' }
  return null
}

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

function attempt(operation) {
  try {
    operation()
  } catch {
    return
  }
}

function releaseStashLock(lock) {
  attempt(() => fs.unlinkSync(lock.owner))
  attempt(() => fs.rmdirSync(lock.directory))
}

function ownerAlive(raw) {
  try {
    return processIsAlive(JSON.parse(raw).pid)
  } catch {
    return false
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

  if (raw && ownerAlive(raw)) return
  attempt(() => fs.unlinkSync(lock.owner))
  attempt(() => fs.rmdirSync(lock.directory))
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

const linkCap = 50
const replyCap = 200_000
const transcriptTail = 512 * 1024
const markdownLink = /(?:\[([^[\]\n]*))?\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\)/g
const fileUrl = /^file:\/\/(?:localhost)?(?=\/)/i
const pathToken =
  /(?<![\w./\\:@~+-])(?:[A-Za-z]:[\\/]|~[\\/]|[\\/])?(?:[\w.@+-]+[\\/])*[\w.@+-]*\.[A-Za-z0-9]+(?:#L\d+(?:-L?\d+)?|:\d+(?:[-–]\d+)?(?::\d+)?)?/g
const linkTarget = /^(.*?)(?:#L(\d+)(?:-L?(\d+))?|:(\d+)(?:[-–](\d+))?(?::\d+)?)?$/
const urlScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function transcriptReply(file) {
  if (typeof file !== 'string' || !file) return null
  let raw = ''
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const length = Math.min(size, transcriptTail)
      const buffer = Buffer.alloc(length)
      fs.readSync(fd, buffer, 0, length, size - length)
      raw = buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }

  const parts = []
  for (const line of raw.split('\n').reverse()) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry?.type === 'user') break
    if (entry?.type !== 'assistant') continue
    const value = blockText(entry.message?.content)
    if (value) parts.unshift(value)
  }
  return parts.length > 0 ? parts.join('\n') : null
}

function lastReply(event) {
  const reply =
    typeof event.last_assistant_message === 'string' && event.last_assistant_message
      ? event.last_assistant_message
      : transcriptReply(event.transcript_path)
  return reply === null ? null : reply.slice(0, replyCap)
}

function lineNumber(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

function fromFileUrl(raw) {
  if (!fileUrl.test(raw)) return raw
  const local = raw.replace(fileUrl, '')
  return /^\/[A-Za-z]:/.test(local) ? local.slice(1) : local
}

function parseTarget(target, explicit) {
  const raw = fromFileUrl(target)
  if (urlScheme.test(raw)) return null
  let decoded = raw
  try {
    decoded = decodeURI(raw)
  } catch {
    decoded = raw
  }
  const match = linkTarget.exec(decoded)
  if (!match || !match[1]) return null
  const line = lineNumber(match[2] ?? match[4])
  const end = lineNumber(match[3] ?? match[5])
  if (!explicit && !line && !/[\\/]/.test(match[1])) return null
  return { file: match[1], line, endLine: line && end && end > line ? end : undefined }
}

function baseName(file) {
  return file.split(/[\\/]/).pop()
}

function withLabelLine(target, label) {
  if (target.line) return target
  for (const match of label.matchAll(pathToken)) {
    const cited = parseTarget(match[0], false)
    if (cited?.line && baseName(cited.file) === baseName(target.file))
      return { ...target, line: cited.line, endLine: cited.endLine }
  }
  return target
}

function candidates(reply) {
  const found = []
  const spans = []
  for (const match of reply.matchAll(markdownLink)) {
    const target = parseTarget(match[2] ?? match[3], true)
    if (!target) continue
    spans.push([match.index, match.index + match[0].length])
    found.push({ index: match.index, target: withLabelLine(target, match[1] ?? '') })
  }
  for (const match of reply.matchAll(pathToken)) {
    if (spans.some(([start, end]) => match.index >= start && match.index < end)) continue
    found.push({ index: match.index, target: parseTarget(match[0], false) })
  }
  return found
    .filter((entry) => entry.target)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.target)
}

const candidateCap = 500
const linkBudgetMs = 2000
const linkDeadlineMs = 3000
const statCap = 200

const symlinkHops = 16

function linkFree(file, roots) {
  let current = file
  for (let hop = 0; hop < symlinkHops; hop++) {
    const base = roots.find((root) => inside(current, root))
    if (!base) return null
    let walked = path.resolve(base)
    let redirected = null
    for (const part of path.relative(walked, current).split(path.sep).filter(Boolean)) {
      walked = path.join(walked, part)
      if (!fs.lstatSync(walked).isSymbolicLink()) continue
      const target = path.resolve(path.dirname(walked), fs.readlinkSync(walked))
      redirected = path.join(target, path.relative(walked, current))
      break
    }
    if (redirected === null) return current
    current = redirected
  }
  return null
}

function realPath(file) {
  try {
    return fs.realpathSync.native(file)
  } catch {
    return fs.realpathSync(file)
  }
}

function realFile(file, roots) {
  try {
    const resolved = linkFree(file, roots)
    return resolved && fs.statSync(resolved).isFile() ? realPath(resolved) : null
  } catch {
    return null
  }
}

function repoRoot(cwd) {
  try {
    const [root, cdup = ''] = execFileSync('git', ['rev-parse', '--show-toplevel', '--show-cdup'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
    if (!root) return null
    return { root, real: realPath(root), logical: path.resolve(cwd, cdup) }
  } catch {
    return null
  }
}

function insideRoot(relative) {
  return (
    !!relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function candidateFiles(file, cwd, repo) {
  const expanded = expandHome(file)
  const files = [path.resolve(cwd, expanded)]
  if (!path.isAbsolute(expanded)) files.push(path.resolve(repo.logical, expanded))
  return [...new Set(files)].filter(
    (candidate) =>
      inside(candidate, repo.logical) ||
      inside(candidate, repo.root) ||
      inside(candidate, repo.real)
  )
}

function extractLinks(reply, cwd) {
  if (typeof cwd !== 'string' || !cwd) return undefined
  if (!reply) return null
  const targets = candidates(reply).slice(0, candidateCap)
  if (targets.length === 0) return null
  const repo = repoRoot(cwd)
  if (!repo) return undefined

  const roots = [repo.real, repo.root, repo.logical]
  const deadline = Math.min(Date.now() + linkBudgetMs, startedAt + linkDeadlineMs)
  const resolved = new Map()
  const seen = new Set()
  const items = []
  for (const target of targets) {
    if (items.length === linkCap || Date.now() > deadline) break
    let real = null
    for (const file of candidateFiles(target.file, cwd, repo)) {
      if (!resolved.has(file)) {
        if (resolved.size === statCap) break
        resolved.set(file, realFile(file, roots))
      }
      real = resolved.get(file)
      if (real) break
    }
    if (!real) continue
    const relative = path.relative(repo.real, real)
    if (!insideRoot(relative)) continue
    const item = {
      path: relative.split(path.sep).join('/'),
      ...(target.line ? { line: target.line } : {}),
      ...(target.endLine ? { endLine: target.endLine } : {})
    }
    const key = `${item.path}:${item.line ?? ''}-${item.endLine ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }
  return items.length > 0 ? { root: repo.root, at: Date.now(), items } : null
}

function recapStop(event, previous) {
  const promptId = text(event.prompt_id)
  return (
    previous?.turnEnded === true &&
    event.stop_hook_active !== true &&
    !!promptId &&
    promptId === text(previous.linkedPrompt)
  )
}

function stopLinks(event, previous) {
  if (event.hook_event_name !== 'Stop' || recapStop(event, previous)) return undefined
  try {
    const reply = lastReply(event)
    return reply === null ? undefined : extractLinks(reply, event.cwd)
  } catch {
    return undefined
  }
}

function overtaken(event, before, previous) {
  const promptId = text(event.prompt_id)
  const current = text(previous?.promptId)
  return (
    event.hook_event_name === 'Stop' &&
    !!promptId &&
    !!current &&
    promptId !== current &&
    previous?.updated !== before?.updated
  )
}

function writeLinksOnly(file, event, previous, links) {
  if (links === (previous.links ?? null)) return
  if (text(previous.linksFrom) === text(previous.promptId)) return
  const rest = { ...previous }
  delete rest.links
  writeRecord(file, {
    ...rest,
    ...(links ? { links } : {}),
    linkedPrompt: text(event.prompt_id),
    linksFrom: text(event.prompt_id)
  })
}

function freshLinks(event, previous, extracted) {
  return event.hook_event_name === 'Stop' && !recapStop(event, previous) && extracted !== undefined
}

function linksFor(event, previous, extracted) {
  return freshLinks(event, previous, extracted) ? extracted : (previous?.links ?? null)
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

  const before = event.hook_event_name === 'Stop' ? readRecord(file) : null
  const extracted = event.hook_event_name === 'Stop' ? stopLinks(event, before) : undefined
  const previous = readRecord(file)
  if (overtaken(event, before, previous)) {
    writeLinksOnly(file, event, previous, linksFor(event, previous, extracted))
    return
  }
  const state = stateFor(event, previous)
  if (!state) return

  const refusal = event.hook_event_name === 'PreToolUse' ? stashRefusal(event) : null
  const protection = refusal ? stashProtection() : 'off'
  const detail =
    refusal && protection === 'warn'
      ? [detailFor(event), 'shared-stash warning'].filter(Boolean).join(' · ')
      : detailFor(event)
  const promptId = text(event.prompt_id) ?? text(previous?.promptId)
  const turnEnded =
    turnEndEvents.has(event.hook_event_name) ||
    (event.hook_event_name === 'Notification' &&
      event.notification_type === 'idle_prompt' &&
      ((previous?.turnEnded === true && promptId === text(previous.promptId)) ||
        previous?.state === 'busy'))

  const links = linksFor(event, previous, extracted)
  const linkedPrompt =
    event.hook_event_name === 'Stop' ? text(event.prompt_id) : text(previous?.linkedPrompt)
  const linksFrom = freshLinks(event, previous, extracted)
    ? text(event.prompt_id)
    : text(previous?.linksFrom)

  fs.mkdirSync(dir, { recursive: true })
  const terminalBinding = text(process.env.SNOW_AGENT_BINDING)
  const terminalOwner = text(process.env.SNOW_AGENT_OWNER)
  const legacyTerminal = text(process.env.SNOW_AGENT_TERMINAL)
  writeRecord(file, {
    sessionId: event.session_id,
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
    ...(links ? { links } : {}),
    ...(linkedPrompt ? { linkedPrompt } : {}),
    ...(linksFrom ? { linksFrom } : {}),
    agent: process.argv[2] === 'codex' ? 'codex' : 'claude',
    updated: Date.now()
  })

  if (event.hook_event_name !== 'PreToolUse') return
  if (protection === 'deny') decide('deny', refusal)
  else if (protection === 'warn') {
    if (process.argv[2] === 'codex') warn(refusal)
    else decide('ask', refusal)
  }
}

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
