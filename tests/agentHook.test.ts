import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
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

describe('code links', () => {
  let project = ''

  beforeAll(() => {
    project = path.join(scratch, 'project')
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    spawnSync('git', ['init', '-q'], { cwd: project })
    fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'one\ntwo\nthree\n')
    fs.writeFileSync(path.join(project, 'b.ts'), 'one\ntwo\nthree\nfour\n')
    fs.writeFileSync(path.join(outside, 'c.ts'), 'x\n')
  })

  function links(): unknown {
    return record().links
  }

  it('extracts existing files cited in the final reply, relative to the repo root', () => {
    runHook({
      hook_event_name: 'Stop',
      cwd: path.join(project, 'src'),
      last_assistant_message: [
        'See `a.ts:3` and [the helper](../b.ts#L2-L4).',
        'Also missing.ts:4, ../../elsewhere/c.ts:1 and https://example.com/a.ts:1.',
        'Again a.ts:3, and src/a.ts without a line.'
      ].join('\n')
    })
    const result = links() as { root: string; items: unknown[] }
    expect(path.resolve(result.root)).toBe(path.resolve(project))
    expect(result.items).toEqual([
      { path: 'src/a.ts', line: 3 },
      { path: 'b.ts', line: 2, endLine: 4 },
      { path: 'src/a.ts' }
    ])
  })

  it('carries links across later events and drops them on a linkless Stop', () => {
    runHook({ hook_event_name: 'UserPromptSubmit', cwd: project, prompt_id: 'p9' })
    expect(links()).toBeDefined()
    runHook({ hook_event_name: 'Stop', cwd: project, last_assistant_message: 'Done.' })
    expect(links()).toBeUndefined()
  })

  it('keeps the turn links through a recap Stop reusing the prompt id', () => {
    runHook({ hook_event_name: 'UserPromptSubmit', cwd: project, prompt_id: 'p10' })
    runHook({
      hook_event_name: 'Stop',
      cwd: project,
      prompt_id: 'p10',
      last_assistant_message: 'See b.ts:2'
    })
    const first = links()
    expect(first).toBeDefined()
    runHook({
      hook_event_name: 'Stop',
      cwd: project,
      prompt_id: 'p10',
      last_assistant_message: 'Recap with no paths.'
    })
    expect(links()).toEqual(first)
  })

  it('reads angle-bracket, titled and file: markdown links', () => {
    fs.writeFileSync(path.join(project, 'my file.ts'), 'x\ny\n')
    const url = pathToFileURL(path.join(project, 'b.ts')).href
    runHook({
      hook_event_name: 'Stop',
      cwd: project,
      last_assistant_message: `[a](<my file.ts>) [b](src/a.ts "title") [c](${url}#L3)`
    })
    expect((links() as { items: unknown[] }).items).toEqual([
      { path: 'my file.ts' },
      { path: 'src/a.ts' },
      { path: 'b.ts', line: 3 }
    ])
  })

  it.runIf(process.platform === 'win32')('stores the on-disk case of a cited path', () => {
    runHook({ hook_event_name: 'Stop', cwd: project, last_assistant_message: 'See SRC/A.TS:2' })
    expect((links() as { items: unknown[] }).items).toEqual([{ path: 'src/a.ts', line: 2 }])
  })

  it('reads a markdown link whose label is a path once', () => {
    runHook({
      hook_event_name: 'Stop',
      cwd: project,
      last_assistant_message: '[src/a.ts](src/a.ts#L2) and [b.ts:1](b.ts)'
    })
    expect((links() as { items: unknown[] }).items).toEqual([
      { path: 'src/a.ts', line: 2 },
      { path: 'b.ts', line: 1 }
    ])
  })

  it('reads the label of a markdown link whose target is a web URL', () => {
    runHook({
      hook_event_name: 'Stop',
      cwd: project,
      last_assistant_message: '[src/a.ts:2](https://example.com/x/src/a.ts#L2)'
    })
    expect((links() as { items: unknown[] }).items).toEqual([{ path: 'src/a.ts', line: 2 }])
  })

  it('records which turn the links were extracted for', () => {
    runHook({
      hook_event_name: 'Stop',
      cwd: project,
      prompt_id: 'q1',
      last_assistant_message: 'See b.ts:2'
    })
    expect(record().linksFrom).toBe('q1')
    runHook({ hook_event_name: 'UserPromptSubmit', cwd: project, prompt_id: 'q2' })
    runHook({ hook_event_name: 'Stop', cwd: project, prompt_id: 'q2' })
    expect(record().linksFrom).toBe('q1')
    expect(record().linkedPrompt).toBe('q2')
  })

  it('keeps the previous links when the repo root cannot be resolved', () => {
    runHook({ hook_event_name: 'Stop', cwd: project, last_assistant_message: 'See b.ts:2' })
    const first = links()
    runHook({ hook_event_name: 'Stop', cwd: outside, last_assistant_message: 'See c.ts:1' })
    expect(links()).toEqual(first)
  })

  it('keeps root-level files whose names start with two dots', () => {
    fs.writeFileSync(path.join(project, '..env.local'), 'x\n')
    runHook({ hook_event_name: 'Stop', cwd: project, last_assistant_message: 'See ..env.local:1' })
    expect((links() as { items: unknown[] }).items).toEqual([{ path: '..env.local', line: 1 }])
  })

  it.skipIf(process.platform === 'win32')('resolves links from a symlinked cwd', () => {
    const alias = path.join(scratch, 'project-link')
    fs.symlinkSync(project, alias)
    runHook({ hook_event_name: 'Stop', cwd: alias, last_assistant_message: 'See b.ts:3' })
    expect((links() as { items: unknown[] }).items).toEqual([{ path: 'b.ts', line: 3 }])
  })

  it('re-extracts when a Stop hook blocked the stop and the turn continued', () => {
    runHook({ hook_event_name: 'UserPromptSubmit', cwd: project, prompt_id: 'p11' })
    runHook({
      hook_event_name: 'Stop',
      cwd: project,
      prompt_id: 'p11',
      last_assistant_message: 'b.ts:1'
    })
    runHook({
      hook_event_name: 'Stop',
      cwd: project,
      prompt_id: 'p11',
      stop_hook_active: true,
      last_assistant_message: 'Now see src/a.ts:2'
    })
    expect((links() as { items: unknown[] }).items).toEqual([{ path: 'src/a.ts', line: 2 }])
  })

  it('extracts on the real Stop after an idle reminder ended the turn early', () => {
    runHook({ hook_event_name: 'UserPromptSubmit', cwd: project, prompt_id: 'p12' })
    runHook({
      hook_event_name: 'Notification',
      cwd: project,
      prompt_id: 'p12',
      notification_type: 'idle_prompt'
    })
    expect(record().turnEnded).toBe(true)
    runHook({
      hook_event_name: 'Stop',
      cwd: project,
      prompt_id: 'p12',
      last_assistant_message: 'b.ts:3'
    })
    expect((links() as { items: unknown[] }).items).toEqual([{ path: 'b.ts', line: 3 }])
  })

  it('keeps the previous links when the transcript has no reply yet', () => {
    runHook({ hook_event_name: 'Stop', cwd: project, last_assistant_message: 'See b.ts:2' })
    const before = links()
    const transcript = path.join(scratch, 'unflushed.jsonl')
    fs.writeFileSync(
      transcript,
      [
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
    )
    runHook({ hook_event_name: 'Stop', cwd: project, transcript_path: transcript })
    expect(links()).toEqual(before)
  })

  it.skipIf(process.platform === 'win32')('never follows a symlink leaving the repo', () => {
    fs.symlinkSync(path.join(outside, 'c.ts'), path.join(project, 'escape.ts'))
    fs.symlinkSync(outside, path.join(project, 'vendor'))
    fs.symlinkSync(path.join(project, 'b.ts'), path.join(project, 'alias.ts'))
    runHook({
      hook_event_name: 'Stop',
      cwd: project,
      last_assistant_message: 'See escape.ts:1, vendor/c.ts:1 and alias.ts:2'
    })
    expect((links() as { items: unknown[] }).items).toEqual([{ path: 'b.ts', line: 2 }])
  })

  it('falls back to the transcript tail', () => {
    const transcript = path.join(scratch, 'transcript.jsonl')
    fs.writeFileSync(
      transcript,
      [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'old b.ts:1' }] } },
        { type: 'user', message: { content: 'next' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Look at b.ts:4' }] } }
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n')
    )
    runHook({ hook_event_name: 'Stop', cwd: project, transcript_path: transcript })
    expect((links() as { items: unknown[] }).items).toEqual([{ path: 'b.ts', line: 4 }])
    runHook({ hook_event_name: 'SessionEnd', cwd: project })
  })
})
