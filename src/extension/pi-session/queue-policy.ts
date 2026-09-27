import type { SettingsManager } from '@earendil-works/pi-coding-agent';

/**
 * Every steer pending at a tool boundary reaches the model in one request, whatever a settings file says.
 * pi reads the mode only through `getSteeringMode()`, at session build and in `AgentSession.reload()`.
 * See "Every pending steer reaches the model at the next boundary" in docs/invariants.md.
 */
export function withQueuePolicy<T extends Pick<SettingsManager, 'getSteeringMode'>>(manager: T): T {
  manager.getSteeringMode = () => 'all';
  return manager;
}
