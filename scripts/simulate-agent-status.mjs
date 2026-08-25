import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'snow-agent-status-'))

try {
  const projects = path.join(scratch, 'projects')
  const child = path.join(projects, 'snow')
  fs.mkdirSync(child, { recursive: true })

  const token = 'parent-tab-child-agent'
  const event = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'child-session',
    prompt_id: 'turn-1',
    cwd: child
  }
  execFileSync(process.execPath, [path.join(root, 'resources/hooks/snow-agent-hook.mjs')], {
    input: JSON.stringify(event),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: scratch,
      SNOW_AGENT_BINDING: token,
      SNOW_AGENT_OWNER: 'snow-instance-1'
    }
  })

  const recordsDir = path.join(scratch, 'snow', 'agents')
  const recordFile = fs
    .readdirSync(recordsDir)
    .map((name) => path.join(recordsDir, name))
    .find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).sessionId === event.session_id)
  assert(recordFile, 'the real hook should write an agent record')
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'))
  assert.equal(record.terminal, undefined)
  assert.equal(record.terminalBinding, token)
  assert.equal(record.terminalOwner, 'snow-instance-1')
  assert.equal(record.cwd, child)
  assert.equal(record.state, 'busy')

  const bundle = path.join(scratch, 'agentStatus.mjs')
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'src/renderer/src/agentStatus.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { '@renderer': path.join(root, 'src/renderer/src') }
  })
  const {
    agentDirsOf,
    tabStatusFrom,
    tabStatusIn,
    terminalAgentsOf,
    visibleAgentSessions,
    workflowSessionsOf
  } = await import(pathToFileURL(bundle).href)

  // `readAgents` adds the PTY id by resolving the hook token against its live terminal registry.
  const parentTerminalId = 101
  const sessions = [{ ...record, terminalId: parentTerminalId }]
  const interrupted = {}
  const dirs = agentDirsOf(sessions, interrupted)

  // Tab ownership is terminal-specific even in ordinary non-git directories. A second tab at the
  // exact same cwd must not inherit the first tab's agent, while the directory rollup still sees it.
  assert.equal(tabStatusIn(sessions, interrupted, [parentTerminalId], {}), 'busy')
  assert.equal(tabStatusIn(sessions, interrupted, [202], {}), undefined)
  const terminalAgents = terminalAgentsOf(sessions, interrupted)
  assert.equal(tabStatusFrom(terminalAgents, [parentTerminalId], {}), 'busy')
  assert.equal(tabStatusFrom(terminalAgents, [202], {}), undefined)
  assert.equal(dirs[child.replaceAll('\\', '/')].state, 'busy')

  // Interrupting one of two sessions in the same directory suppresses only that terminal. The
  // other tab and the workflow rollup retain the other session's independently reported status.
  const updated = Date.now() - 100
  const sharedSessions = [
    { ...record, sessionId: 'waiting', state: 'attention', updated, terminalId: 301 },
    { ...record, sessionId: 'working', state: 'busy', updated, terminalId: 302 }
  ]
  const interruptedOne = { 301: Date.now() }
  assert.equal(tabStatusIn(sharedSessions, interruptedOne, [301], {}), undefined)
  assert.equal(tabStatusIn(sharedSessions, interruptedOne, [302], {}), 'busy')
  assert.deepEqual(
    visibleAgentSessions(sharedSessions, interruptedOne).map((session) => session.sessionId),
    ['working']
  )
  assert.equal(
    agentDirsOf(sharedSessions, interruptedOne)[child.replaceAll('\\', '/')].state,
    'busy'
  )

  // Tokenless external agents contribute to a workflow directory but never claim a Snow tab.
  const external = [{ ...record, terminal: undefined, terminalId: undefined }]
  assert.equal(tabStatusIn(external, {}, [202], {}), undefined)
  assert.equal(agentDirsOf(external, {})[child.replaceAll('\\', '/')].state, 'busy')

  // A busy terminal heuristic keeps workflow counts stable only while that terminal has no hook
  // record. Hook state remains authoritative, and inferred attention cannot claim an agent needs
  // input merely because output stopped while its tab was inactive.
  const workflowSessions = workflowSessionsOf(
    [{ ...record, state: 'busy', terminalId: 501 }],
    [
      { terminalId: 501, cwd: child, state: 'attention' },
      { terminalId: 502, cwd: child, state: 'attention' },
      { terminalId: 503, cwd: child, state: 'idle' },
      { terminalId: 504, cwd: child, state: 'busy' }
    ]
  )
  assert.deepEqual(
    workflowSessions.map((session) => [session.terminalId, session.state]),
    [
      [501, 'busy'],
      [504, 'busy']
    ]
  )

  // Hook state replaces only its own terminal's heuristic before the tab aggregate is selected.
  // An idle hooked agent cannot hide a second, hookless terminal that still needs attention.
  const idleHook = [{ ...record, state: 'idle', terminalId: 401 }]
  assert.equal(
    tabStatusIn(idleHook, {}, [401, 402], { 401: 'busy', 402: 'attention' }),
    'attention'
  )

  const workflowBundle = path.join(scratch, 'workflowText.mjs')
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'src/renderer/src/workflowText.ts')],
    outfile: workflowBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { '@renderer': path.join(root, 'src/renderer/src') }
  })
  const { inboxSignal } = await import(pathToFileURL(workflowBundle).href)
  assert.equal(inboxSignal({}, { waiting: 1, working: 1 }).label, 'needs input · 1 working')
  assert.equal(inboxSignal({}, { waiting: 2, working: 3 }).label, '2 need input · 3 working')
  assert.equal(inboxSignal({}, { waiting: 0, working: 0 }, true).label, 'finished')
  assert.equal(
    inboxSignal({ review: { changed: 1 } }, { waiting: 0, working: 0 }, true).label,
    'review'
  )

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const runHook = (hookEvent) =>
    execFileSync(process.execPath, [path.join(root, 'resources/hooks/snow-agent-hook.mjs')], {
      input: JSON.stringify(hookEvent),
      env: { ...process.env, XDG_CONFIG_HOME: scratch }
    })
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const recordFor = (sessionId) => {
    const file = fs
      .readdirSync(recordsDir)
      .map((name) => path.join(recordsDir, name))
      .find((candidate) => JSON.parse(fs.readFileSync(candidate, 'utf8')).sessionId === sessionId)
    assert(file, `expected a record for ${sessionId}`)
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }

  // A question is already blocked on the operator at PreToolUse. It must not rely on Claude also
  // emitting a later Notification, because that event is not guaranteed to arrive first (or at
  // all) in every client/version.
  const questionSession = 'ask-user-question'
  runHook({
    session_id: questionSession,
    prompt_id: 'turn-question',
    cwd: child,
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{ header: 'Choice', question: 'Which option?', options: [] }]
    }
  })
  const waitingForAnswer = recordFor(questionSession)
  assert.equal(waitingForAnswer.state, 'attention')
  assert.equal(waitingForAnswer.turnEnded, undefined)

  // Claude can announce idle after Stop and before running an internal away-recap prompt. The
  // notification must retain the completed-turn marker so recap activity cannot resurrect busy.
  const recapSession = 'completed-turn-recap'
  const recapBase = { session_id: recapSession, prompt_id: 'turn-recap', cwd: child }
  runHook({ ...recapBase, hook_event_name: 'Stop' })
  runHook({ ...recapBase, hook_event_name: 'Notification', notification_type: 'idle_prompt' })
  const afterIdlePrompt = recordFor(recapSession)
  assert.equal(afterIdlePrompt.state, 'idle')
  assert.equal(afterIdlePrompt.turnEnded, true)
  runHook({
    ...recapBase,
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'recap' }
  })
  assert.deepEqual(recordFor(recapSession), afterIdlePrompt)

  // If Stop is missed, idle_prompt repairs busy to idle and must also mark the turn complete so an
  // away recap carrying the same prompt id cannot resurrect busy.
  const missedStopSession = 'missed-stop-recap'
  const missedStopBase = {
    session_id: missedStopSession,
    prompt_id: 'turn-missed-stop',
    cwd: child
  }
  runHook({ ...missedStopBase, hook_event_name: 'UserPromptSubmit', prompt: 'continue' })
  runHook({
    ...missedStopBase,
    hook_event_name: 'Notification',
    notification_type: 'idle_prompt'
  })
  const afterMissedStop = recordFor(missedStopSession)
  assert.equal(afterMissedStop.state, 'idle')
  assert.equal(afterMissedStop.turnEnded, true)
  runHook({
    ...missedStopBase,
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'recap-after-missed-stop' }
  })
  assert.deepEqual(recordFor(missedStopSession), afterMissedStop)

  // An idle prompt while waiting for permission is not completion and must still allow later work
  // for that prompt to return the session to busy.
  const liveSession = 'live-turn-idle-prompt'
  const liveBase = { session_id: liveSession, prompt_id: 'turn-live', cwd: child }
  runHook({ ...liveBase, hook_event_name: 'UserPromptSubmit', prompt: 'continue' })
  runHook({
    ...liveBase,
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: 'Permission required'
  })
  runHook({ ...liveBase, hook_event_name: 'Notification', notification_type: 'idle_prompt' })
  assert.equal(recordFor(liveSession).turnEnded, undefined)
  runHook({
    ...liveBase,
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'real-work' }
  })
  assert.equal(recordFor(liveSession).state, 'busy')

  process.stdout.write('agent status parent/child and turn sequencing simulations passed\n')
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
