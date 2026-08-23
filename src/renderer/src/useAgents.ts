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

/**
 * A record claims a live agent only while its session is working or waiting on a human. `idle`
 * means "alive but between turns", which is indistinguishable from a session that was killed at
 * its terminal without firing SessionEnd - so counting those turns work that finished hours ago
 * into a fleet that looks like it is still running.
 */
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

/**
 * What a rollup needs from the live agents in one directory. `names` is the distinct set of
 * reporting agents, which the display names only when there is more than one - the same rule the
 * usage meter uses for its per-agent split, so today's Claude-only channel reads exactly as it did
 * while a mixed fleet stops looking homogeneous. A record that did not say which agent wrote it
 * contributes no name rather than being counted as Claude.
 */
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
