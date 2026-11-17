import type { AgentSession } from '@earendil-works/pi-coding-agent';

/**
 * Aborts the run on `session`: the one open now, else the next one pi starts, at its `agent_start`, which pi-agent-core
 * awaits before the first request (`agent.js:436-437`). For a run no prompt of Damocles opened, such as a user's pi
 * extension's, which no `RunRefused` can refuse; a disposed session no longer turns its abort mark into an agent abort
 * (`agent-session.js:767-768`, `:1082`), so the agent is also stopped from a listener of its own.
 */
export function abortRunAtStart(session: AgentSession): Promise<void> {
  const stopAgent = session.agent.subscribe((event) => {
    if (event.type !== 'agent_start' && event.type !== 'agent_end') return;
    stopAgent();
    if (event.type === 'agent_start') session.agent.abort();
  });
  return session.abort();
}
