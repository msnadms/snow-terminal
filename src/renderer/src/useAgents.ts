import { useEffect, useState } from 'react'

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
