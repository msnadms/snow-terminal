import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const hook = path.resolve('resources/hooks/snow-agent-hook.mjs')

let scratch = ''
let config = ''
let repo = ''
let outside = ''

interface HookRun {
  stdout: string
  status: number | null
}

function runHook(event: Record<string, unknown>, agent = 'claude'): HookRun {
  const result = spawnSync(process.execPath, [hook, agent], {
    input: JSON.stringify({ session_id: 'test-session', ...event }),
    env: { ...process.env, XDG_CONFIG_HOME: config },
    encoding: 'utf8'
  })
  return { stdout: result.stdout, status: result.status }
}

function bash(command: string, cwd = repo): HookRun {
  return runHook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    cwd
  })
}

function decision(run: HookRun): string | null {
  if (!run.stdout) return null
  const parsed = JSON.parse(run.stdout)
  return parsed.hookSpecificOutput?.permissionDecision ?? (parsed.systemMessage ? 'warn' : null)
}

function setProtection(mode: string): void {
  fs.writeFileSync(
    path.join(config, 'snow', '.snowconfig'),
    JSON.stringify({ presets: [], workflowStashProtection: mode })
  )
}

function record(): Record<string, unknown> {
  const dir = path.join(config, 'snow', 'agents')
  const [file] = fs.readdirSync(dir)
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'snow-hook-test-'))
  config = path.join(scratch, 'config')
  repo = path.join(scratch, 'repo')
  outside = path.join(scratch, 'elsewhere')
  fs.mkdirSync(path.join(config, 'snow'), { recursive: true })
  fs.mkdirSync(repo)
  fs.mkdirSync(outside)
  fs.writeFileSync(
    path.join(config, 'snow', '.snowworkflows'),
    JSON.stringify({ workflows: [{ repo, branch: 'feature' }] })
  )
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('agent status records', () => {
  it('moves through busy, attention and idle, and is deleted on SessionEnd', () => {
    expect(
      runHook({ hook_event_name: 'UserPromptSubmit', cwd: repo, prompt_id: 'p1' }).status
    ).toBe(0)
    expect(record()).toMatchObject({ state: 'busy', cwd: repo, agent: 'claude', promptId: 'p1' })

    runHook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', cwd: repo })
    expect(record().state).toBe('attention')

    runHook({ hook_event_name: 'Stop', cwd: repo })
    expect(record()).toMatchObject({ state: 'idle', turnEnded: true })

    runHook({ hook_event_name: 'SessionEnd', cwd: repo })
    expect(fs.readdirSync(path.join(config, 'snow', 'agents'))).toEqual([])
  })

  it('ignores a late event from the turn that already ended', () => {
    runHook({ hook_event_name: 'UserPromptSubmit', cwd: repo, prompt_id: 'p2' })
    runHook({ hook_event_name: 'Stop', cwd: repo, prompt_id: 'p2' })
    runHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: repo, prompt_id: 'p2' })
    expect(record().state).toBe('idle')
    runHook({ hook_event_name: 'SessionEnd', cwd: repo })
  })

  it('exits 0 on malformed input', () => {
    const result = spawnSync(process.execPath, [hook], {
      input: 'not json',
      env: { ...process.env, XDG_CONFIG_HOME: config },
      encoding: 'utf8'
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })
})

describe('shared-stash protection', () => {
  it.each([
    'git stash pop',
    'git stash apply stash@{1}',
    'git stash drop',
    'git stash clear',
    'cd src && git stash pop',
    'git -C . stash pop',
    'nohup git stash pop',
    'git stash push -m "snow-wf:feature"',
    'git stash -m snow-wf:other'
  ])('denies %s in a registered repo', (command) => {
    expect(decision(bash(command))).toBe('deny')
  })

  it.each([
    'git stash list',
    'git stash show -p',
    'git stash',
    'git stash push -m "try something"',
    'git stash pop --help',
    'echo "git stash pop"',
    'grep -r stash src'
  ])('allows %s', (command) => {
    expect(decision(bash(command))).toBeNull()
  })

  it('leaves unregistered directories alone', () => {
    expect(decision(bash('git stash pop', outside))).toBeNull()
  })

  it('honours warn and off modes', () => {
    setProtection('warn')
    expect(decision(bash('git stash pop'))).toBe('ask')
    expect(
      decision(
        runHook(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'git stash pop' },
            cwd: repo
          },
          'codex'
        )
      )
    ).toBe('warn')
    setProtection('off')
    expect(decision(bash('git stash pop'))).toBeNull()
    setProtection('deny')
  })
})
