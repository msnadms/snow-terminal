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
  const runHook = (hookEvent, agent) =>
    execFileSync(
      process.execPath,
      [path.join(root, 'resources/hooks/snow-agent-hook.mjs'), ...(agent ? [agent] : [])],
      {
        input: JSON.stringify(hookEvent),
        env: { ...process.env, XDG_CONFIG_HOME: scratch }
      }
    )
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

  // Codex uses the same hook input contract but names approval prompts directly instead of
  // emitting Claude's Notification event. Its identity must survive the shared runtime, and the
  // tool completion after a worktree-creating command must refresh discovery while the turn runs.
  const codexSession = 'codex-session'
  const codexBase = { session_id: codexSession, cwd: child, model: 'gpt-test-codex' }
  runHook({ ...codexBase, hook_event_name: 'SessionStart', source: 'startup' }, 'codex')
  assert.equal(recordFor(codexSession).agent, 'codex')
  assert.equal(recordFor(codexSession).state, 'idle')
  runHook(
    {
      ...codexBase,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'git worktree add ../agent-worktree agent-branch' }
    },
    'codex'
  )
  assert.equal(recordFor(codexSession).state, 'attention')
  runHook(
    {
      ...codexBase,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git worktree add ../agent-worktree agent-branch' }
    },
    'codex'
  )
  assert.equal(recordFor(codexSession).state, 'busy')

  // Codex does not accept Claude's interactive `ask` decision on PreToolUse. Warn mode must use
  // Codex's supported non-blocking systemMessage shape while Claude retains its confirmation.
  fs.writeFileSync(
    path.join(scratch, 'snow', '.snowworkflows'),
    `${JSON.stringify({ workflows: [{ repo: child, branch: 'agent-branch', worktree: child }] })}\n`
  )
  fs.writeFileSync(
    path.join(scratch, 'snow', '.snowconfig'),
    `${JSON.stringify({ presets: [], workflowStashProtection: 'warn' })}\n`
  )
  const stashEvent = {
    session_id: 'stash-warning',
    cwd: child,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git stash pop' }
  }
  const codexWarning = JSON.parse(runHook(stashEvent, 'codex').toString())
  assert.match(codexWarning.systemMessage, /Every worktree/)
  const claudeWarning = JSON.parse(
    runHook({ ...stashEvent, session_id: 'claude-stash-warning' }).toString()
  )
  assert.equal(claudeWarning.hookSpecificOutput.permissionDecision, 'ask')

  // The installer shares one runtime while preserving each product's supported event set and every
  // unrelated user hook. Bundle the real main-process module with a tiny Electron façade so this
  // exercises install and removal without touching the developer's actual home configuration.
  const claudeConfig = path.join(scratch, 'claude-config')
  const codexConfig = path.join(scratch, 'codex-config')
  fs.mkdirSync(claudeConfig)
  fs.mkdirSync(codexConfig)
  const claudeSettings = path.join(claudeConfig, 'settings.json')
  const codexHooks = path.join(codexConfig, 'hooks.json')
  const customGroup = { hooks: [{ type: 'command', command: 'keep-my-hook' }] }
  fs.writeFileSync(
    claudeSettings,
    `${JSON.stringify({ custom: 'claude', hooks: { Stop: [customGroup] } }, null, 2)}\n`
  )
  fs.writeFileSync(
    codexHooks,
    `${JSON.stringify({ description: 'mine', hooks: { Stop: [customGroup] } }, null, 2)}\n`
  )
  process.env.CLAUDE_CONFIG_DIR = claudeConfig
  process.env.CODEX_HOME = codexConfig
  process.env.SNOW_TEST_APP_PATH = root

  const hooksBundle = path.join(scratch, 'hooks.mjs')
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'src/main/hooks.ts')],
    outfile: hooksBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
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
              export const app = { getAppPath: () => process.env.SNOW_TEST_APP_PATH };
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
  process.env.XDG_CONFIG_HOME = scratch
  const { refreshHooks, runHooks } = await import(pathToFileURL(hooksBundle).href)
  const installed = runHooks('install')
  assert.equal(installed.ok, true, installed.detail)

  const installedClaude = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'))
  const installedCodex = JSON.parse(fs.readFileSync(codexHooks, 'utf8'))
  assert.equal(installedClaude.custom, 'claude')
  assert.equal(installedCodex.description, 'mine')
  assert.equal(installedClaude.hooks.Stop[0].hooks[0].command, 'keep-my-hook')
  assert.equal(installedCodex.hooks.Stop[0].hooks[0].command, 'keep-my-hook')
  assert(installedClaude.hooks.Notification)
  assert.equal(installedClaude.hooks.PermissionRequest, undefined)
  assert(installedCodex.hooks.PermissionRequest)
  assert.equal(installedCodex.hooks.Notification, undefined)
  assert(installedClaude.hooks.PostToolUse)
  assert(installedCodex.hooks.PostToolUse)
  // PostToolUse writes `busy`, so it must complete before a following Stop or SessionEnd can write
  // the terminal state. An async handler could finish late and resurrect a completed session.
  assert.equal(installedClaude.hooks.PostToolUse.at(-1).hooks[0].async, undefined)
  assert.equal(installedCodex.hooks.PostToolUse.at(-1).hooks[0].async, undefined)
  assert.equal(installedClaude.hooks.PreToolUse.at(-1).hooks[0].async, undefined)
  assert.equal(installedCodex.hooks.PreToolUse.at(-1).hooks[0].async, undefined)
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const installedHandlers = (config) =>
    Object.values(config.hooks)
      .flat()
      .flatMap((group) => group.hooks ?? [])
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const installedCommands = (config) =>
    installedHandlers(config)
      .map((handler) => handler.command)
      .filter((command) => command?.includes('snow-agent-hook'))
  assert(installedCommands(installedClaude).every((command) => command.endsWith(' claude')))
  assert(installedCommands(installedCodex).every((command) => command.endsWith(' codex')))
  if (process.platform === 'win32') {
    const codexHandlers = installedHandlers(installedCodex).filter((handler) =>
      handler.command?.includes('snow-agent-hook')
    )
    assert(codexHandlers.every((handler) => handler.commandWindows?.includes('-EncodedCommand ')))
    assert(codexHandlers.every((handler) => !handler.commandWindows.includes('"')))

    const sessionStart = installedCodex.hooks.SessionStart.at(-1).hooks[0]
    execFileSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/D', '/S', '/C', sessionStart.commandWindows],
      {
        input: JSON.stringify({
          session_id: 'codex-windows-command',
          cwd: child,
          hook_event_name: 'SessionStart',
          source: 'startup'
        }),
        env: { ...process.env, XDG_CONFIG_HOME: scratch }
      }
    )
    assert.equal(recordFor('codex-windows-command').agent, 'codex')
  }

  const removed = runHooks('remove')
  assert.equal(removed.ok, true, removed.detail)
  const removedClaude = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'))
  const removedCodex = JSON.parse(fs.readFileSync(codexHooks, 'utf8'))
  assert.deepEqual(removedClaude.hooks, { Stop: [customGroup] })
  assert.deepEqual(removedCodex.hooks, { Stop: [customGroup] })

  // App startup carries an existing Claude installation over to Codex even if Codex has not yet
  // created its config directory. It also reconstructs a missing runtime from that install intent.
  const reinstalled = runHooks('install')
  assert.equal(reinstalled.ok, true, reinstalled.detail)
  fs.rmSync(codexConfig, { recursive: true, force: true })
  const runtimeShim = path.join(
    scratch,
    'snow',
    'hooks',
    process.platform === 'win32' ? 'snow-agent-hook.cmd' : 'snow-agent-hook'
  )
  fs.rmSync(runtimeShim, { force: true })

  refreshHooks()

  assert(fs.existsSync(runtimeShim), 'startup should reconstruct the installed hook runtime')
  assert(fs.existsSync(codexHooks), 'startup should install Codex hooks from Claude install intent')
  const migratedCodex = JSON.parse(fs.readFileSync(codexHooks, 'utf8'))
  assert(migratedCodex.hooks.PermissionRequest)
  assert(installedCommands(migratedCodex).every((command) => command.endsWith(' codex')))

  // Reconciliation may need a trailing pass because PostToolUse can report the same cwd after the
  // tool changed its worktree set. While one pass is active, however, every newer read replaces the
  // pending snapshot instead of extending a promise chain with obsolete repository scans.
  const registrationConfig = path.join(scratch, 'registration-config')
  const registrationRecords = path.join(registrationConfig, 'agents')
  const registrationRecord = path.join(registrationRecords, 'session.json')
  fs.mkdirSync(registrationRecords, { recursive: true })
  process.env.SNOW_AGENT_TEST_CONFIG = registrationConfig

  let releaseFirst
  const firstRegistration = new Promise((resolve) => {
    releaseFirst = resolve
  })
  let finishSecond
  const secondRegistration = new Promise((resolve) => {
    finishSecond = resolve
  })
  const registrationState = {
    firstRegistration,
    finishSecond,
    rootCalls: [],
    mapCalls: []
  }
  globalThis.__snowAgentRegistrationTest = registrationState

  const agentsBundle = path.join(scratch, 'agents.mjs')
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'src/main/agents.ts')],
    outfile: agentsBundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'agent-registration-facade',
        setup(buildApi) {
          // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
          const facade = (filter, name, contents) => {
            buildApi.onResolve({ filter }, () => ({ path: name, namespace: 'agent-test' }))
            buildApi.onLoad({ filter: new RegExp(`^${name}$`), namespace: 'agent-test' }, () => ({
              contents,
              loader: 'js'
            }))
          }
          facade(/^electron$/, 'electron', 'export const ipcMain = { handle() {} };')
          facade(
            /^\.\/config$/,
            'config',
            `
              export const broadcast = () => {};
              export const configDir = () => process.env.SNOW_AGENT_TEST_CONFIG;
              export const expandHome = (value) => value;
              export const samePath = (a, b) => a.toLowerCase() === b.toLowerCase();
            `
          )
          facade(
            /^\.\/git$/,
            'git',
            `
              const state = globalThis.__snowAgentRegistrationTest;
              export async function mainWorktreeRoot(cwd) {
                state.rootCalls.push(cwd);
                if (state.rootCalls.length === 1) await state.firstRegistration;
                return cwd;
              }
              export async function worktreeMap(repo) {
                state.mapCalls.push(repo);
                if (state.mapCalls.length === 2) state.finishSecond();
                return new Map();
              }
            `
          )
          facade(/^\.\/log$/, 'log', 'export const log = () => {};')
          facade(
            /^\.\/registry$/,
            'registry',
            `
              export const addRecord = () => null;
              export const recordsFor = () => ({ records: [], error: null });
              export const workflowsPath = () => 'test workflows';
            `
          )
        }
      }
    ]
  })

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  const writeRegistrationSession = (cwd) =>
    fs.writeFileSync(
      registrationRecord,
      JSON.stringify({
        sessionId: 'registration-session',
        cwd,
        state: 'busy',
        detail: '',
        agent: 'test',
        updated: Date.now()
      })
    )

  const firstCwd = path.join(scratch, 'repo-first')
  const supersededCwd = path.join(scratch, 'repo-superseded')
  const latestCwd = path.join(scratch, 'repo-latest')
  writeRegistrationSession(firstCwd)
  const { disposeAgentWatcher, readAgents, registerAgentHandlers } = await import(
    pathToFileURL(agentsBundle).href
  )
  registerAgentHandlers()
  try {
    readAgents()
    writeRegistrationSession(supersededCwd)
    readAgents()
    writeRegistrationSession(latestCwd)
    readAgents()
    releaseFirst()
    await secondRegistration
  } finally {
    disposeAgentWatcher()
  }
  assert.deepEqual(registrationState.rootCalls, [firstCwd, latestCwd])
  assert.deepEqual(registrationState.mapCalls, [firstCwd, latestCwd])
  delete globalThis.__snowAgentRegistrationTest

  process.stdout.write(
    'Claude/Codex hook installation, status, sequencing, and reconciliation simulations passed\n'
  )
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
