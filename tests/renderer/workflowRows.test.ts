import { describe, expect, it } from 'vitest'
import {
  activitySignal,
  emptyActivity,
  failureList,
  nonaffiliatedSessions,
  orderRepos,
  workflowDirectories,
  type Activity,
  type OpenSession
} from '@renderer/workflowRows'
import type { WorkflowEntry, WorkflowRepo } from '@renderer/workflowText'

function entry(branch: string, extra: Partial<WorkflowEntry> = {}): WorkflowEntry {
  return { branch, current: false, exists: true, parked: null, ...extra }
}

function repo(path: string, workflows: WorkflowEntry[] = []): WorkflowRepo {
  return {
    repo: path,
    name: path.split('/').pop() ?? path,
    unreachable: false,
    current: null,
    defaultBranch: 'main',
    workflows,
    error: null
  }
}

function session(id: number, dir?: string): OpenSession {
  return { id, dir, directories: dir ? [dir] : [], label: `s${id}`, terminalIds: [id] }
}

describe('activitySignal', () => {
  const activity = (waiting: number, working: number, status?: Activity['status']): Activity => ({
    ...emptyActivity,
    status,
    summary: { waiting, working, names: [] }
  })

  it('ranks waiting above finished above working', () => {
    expect(activitySignal(activity(1, 2))).toEqual({
      tier: 4,
      label: 'needs input · 2 working',
      slug: 'input'
    })
    expect(activitySignal(activity(2, 0)).label).toBe('2 need input')
    expect(activitySignal(activity(0, 0, 'attention')).tier).toBe(3)
    expect(activitySignal(activity(0, 3)).label).toBe('3 working')
    expect(activitySignal(activity(0, 0, 'busy')).label).toBe('working')
    expect(activitySignal(activity(0, 0, 'idle')).tier).toBe(0)
  })
})

describe('failureList', () => {
  it('indents multi-line detail under its label', () => {
    expect(failureList('feat', 'Failed', 'line one\nline two')).toBe(
      'feat: Failed\n  line one\n  line two'
    )
    expect(failureList('feat', 'Failed', '')).toBe('feat: Failed')
  })
})

describe('orderRepos', () => {
  it('applies the saved order and keeps unknown repos in their original order', () => {
    const repos = [repo('/a'), repo('/b'), repo('/c'), repo('/d')]
    expect(orderRepos(repos, ['/c', '/a']).map((r) => r.repo)).toEqual(['/c', '/a', '/b', '/d'])
  })
})

describe('nonaffiliatedSessions', () => {
  it('drops sessions inside an open workflow directory', () => {
    const repos = [
      repo('/src/snow', [
        entry('main', { current: true }),
        entry('feat', { worktree: '/src/snow-worktrees/feat', worktreeExists: true })
      ])
    ]
    const dirs = workflowDirectories(repos)
    const sessions = [
      session(1, '/src/snow/src'),
      session(2, '/src/snow-worktrees/feat'),
      session(3, '/src/other'),
      session(4)
    ]
    expect(nonaffiliatedSessions(sessions, dirs).map((s) => s.id)).toEqual([3, 4])
  })
})
