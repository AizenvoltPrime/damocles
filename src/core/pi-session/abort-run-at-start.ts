import type { AgentSession } from '@earendil-works/pi-coding-agent';

/**
 * Aborts the run pi just opened on `session` at its `agent_start`, which pi-agent-core awaits before the first request
 * (`agent.js:432-433`). A disposed session no longer turns its abort mark into an agent abort (`agent-session.js:713-714`,
 * `:1008`), so the agent is also stopped from a listener of its own.
 */
export function abortRunAtStart(session: AgentSession): Promise<void> {
  const stopAgent = session.agent.subscribe((event) => {
    if (event.type !== 'agent_start' && event.type !== 'agent_end') return;
    stopAgent();
    if (event.type === 'agent_start') session.agent.abort();
  });
  return session.abort();
}
