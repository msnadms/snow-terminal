import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { CommitAgent } from './snowconfig'

const commitDiffMaxChars = 60_000
const commitMessageTimeoutMs = 60_000

const commitMessagePrompt = [
  'Write a git commit message for the change below, given as a unified diff on stdin.',
  '',
  'Rules:',
  '- First line: an imperative-mood subject under 72 characters, no trailing period.',
  '- Add a blank line and a short body only if the subject cannot capture the change; keep it to a',
  '  few plain sentences or bullet points focused on why, not a restatement of the diff.',
  '- Single spaces only: one space between words and after sentence punctuation, never two.',
  '- Output only the commit message itself: no preamble, no code fences, no quotes, no labels.'
].join('\n')

export function truncateDiffForPrompt(diff: string, limit = commitDiffMaxChars): string {
  if (diff.length <= limit) return diff
  const head = diff.slice(0, limit)
  const boundary = head.lastIndexOf('\ndiff --git ')
  return `${boundary > 0 ? head.slice(0, boundary + 1) : head}\n[diff truncated]`
}

export function cleanCommitMessage(raw: string): string {
  const text = raw.trim()
  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)(?:\n?```[\s\S]*)?$/)
  const body = (fenced ? fenced[1] : text).trim()
  return body
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' '))
    .join('\n')
}

const commitMessageDisallowedTools = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'Task'
]

interface CommitAgentSpec {
  command: string
  timeoutMs: number
  args: (messageFile: string) => string[]
  read: (stdout: string, messageFile: string) => string
}

const commitAgentSpecs: Record<CommitAgent, CommitAgentSpec> = {
  claude: {
    command: 'claude',
    timeoutMs: commitMessageTimeoutMs,
    args: () => ['-p', '--disallowedTools', ...commitMessageDisallowedTools],
    read: (stdout) => stdout
  },
  codex: {
    command: 'codex',
    timeoutMs: commitMessageTimeoutMs * 2,
    args: (messageFile) => [
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-c',
      'model_reasoning_effort=low',
      '--output-last-message',
      messageFile,
      '-'
    ],
    read: (_stdout, messageFile) => {
      try {
        return fs.readFileSync(messageFile, 'utf8')
      } catch {
        return ''
      }
    }
  }
}

export function commitAgentCommand(agent: CommitAgent): string {
  return commitAgentSpecs[agent].command
}

function shellQuote(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`
}

function spawnCommitAgent(spec: CommitAgentSpec, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32'
    const child = spawn(spec.command, useShell ? args.map(shellQuote) : args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      shell: useShell
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`Timed out waiting for ${spec.command} to generate a commit message`))
    }, spec.timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim() || `${spec.command} exited with code ${code}`))
    })

    child.stdin.write(input)
    child.stdin.end()
  })
}

export async function generateCommitMessage(agent: CommitAgent, diff: string): Promise<string> {
  const spec = commitAgentSpecs[agent]
  const input = `${commitMessagePrompt}\n\n${truncateDiffForPrompt(diff)}`
  const messageFile = path.join(os.tmpdir(), `snow-commit-${process.pid}-${Date.now()}.txt`)
  try {
    const stdout = await spawnCommitAgent(spec, spec.args(messageFile), input)
    return cleanCommitMessage(spec.read(stdout, messageFile))
  } finally {
    fs.rmSync(messageFile, { force: true })
  }
}
