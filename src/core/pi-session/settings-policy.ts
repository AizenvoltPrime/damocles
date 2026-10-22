import type { SettingsManager } from '@earendil-works/pi-coding-agent';

type PolicySettings = Pick<SettingsManager, 'getSteeringMode' | 'getFollowUpMode' | 'getEnableInstallTelemetry'>;

/**
 * The pi settings Damocles fixes whatever a settings file says, a trusted project's `.pi/settings.json` included. pi
 * reads each only through these getters, so the values also survive pi re-reading its settings.
 * - Every steer pending at a tool boundary, and every follow-up pending when a run would stop, reaches the model in one
 *   request. pi reads both modes at session build (sdk.js:283-284) and in `AgentSession.reload()`
 *   (`syncQueueModesFromSettings`, agent-session.js:2182-2185, :3008). See "Every pending steer reaches the model at
 *   the next boundary" in docs/invariants.md.
 * - Install telemetry is off, which also keeps pi's attribution off every provider request (`client-identity.js:12`,
 *   read per request). pi's `PI_TELEMETRY` environment variable still outranks it (`telemetry.js:7`).
 */
export function withSettingsPolicy<T extends PolicySettings>(manager: T): T {
  manager.getSteeringMode = () => 'all';
  manager.getFollowUpMode = () => 'all';
  manager.getEnableInstallTelemetry = () => false;
  return manager;
}
