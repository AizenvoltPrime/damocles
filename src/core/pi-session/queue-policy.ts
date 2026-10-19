import type { SettingsManager } from '@earendil-works/pi-coding-agent';

/**
 * Every steer pending at a tool boundary, and every follow-up pending when a run would stop, reaches the model in one
 * request, whatever a settings file says. pi reads both modes only through these methods, at session build
 * (sdk.js:284-285) and in `AgentSession.reload()` (`syncQueueModesFromSettings`, agent-session.js:2153-2156, :2979).
 * See "Every pending steer reaches the model at the next boundary" in docs/invariants.md.
 */
export function withQueuePolicy<T extends Pick<SettingsManager, 'getSteeringMode' | 'getFollowUpMode'>>(manager: T): T {
  manager.getSteeringMode = () => 'all';
  manager.getFollowUpMode = () => 'all';
  return manager;
}
