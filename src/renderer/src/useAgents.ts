import { useEffect, useState } from 'react'
import { isInside, normalizePath } from '@renderer/format'

type AgentsResult = Awaited<ReturnType<typeof window.api.agents.get>>
export type AgentSession = AgentsResult['sessions'][number]

const none: AgentSession[] = []

export function useAgents(): AgentSession[] {
  const [sessions, setSessions] = useState<AgentSession[]>(none)

  useEffect(() => {
    let active = true
    window.api.agents.get().then((result) => {
      if (active) setSessions(result.sessions)
    })
    const off = window.api.agents.onChanged((result) => setSessions(result.sessions))
    return () => {
      active = false
      off()
    }
  }, [])

  return sessions
}

export function liveAgentsIn(sessions: AgentSession[], dir: string): AgentSession[] {
  const root = normalizePath(dir)
  return sessions.filter(
    (session) =>
      session.state !== 'idle' && session.cwd && isInside(normalizePath(session.cwd), root)
  )
}

export interface AgentSummary {
  waiting: number
  working: number
  names: string[]
}

export function agentSummary(sessions: AgentSession[]): AgentSummary {
  const names: string[] = []
  let waiting = 0
  let working = 0
  for (const session of sessions) {
    if (session.state === 'attention') waiting += 1
    if (session.state === 'busy') working += 1
    if (session.agent && !names.includes(session.agent)) names.push(session.agent)
  }
  return { waiting, working, names: names.sort() }
}
