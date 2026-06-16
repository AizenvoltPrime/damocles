import { log } from '../logger';
import { nodeSupportsPi } from './pi-loader';

export type HarnessKind = 'sdk' | 'pi';

let sdkFallbackLogged = false;

/**
 * The agent backend for new chat sessions. pi is the only intended backend — there is no
 * user-facing toggle. The Claude Agent SDK path is retained solely as a safety fallback for hosts
 * whose Node is too old for pi (B5); the VS Code extension host satisfies Node >= 22, so this falls
 * back only in pathological environments (logged once).
 */
export function getEffectiveHarness(): HarnessKind {
  if (nodeSupportsPi()) return 'pi';
  if (!sdkFallbackLogged) {
    sdkFallbackLogged = true;
    log('[Harness] host Node lacks pi support (B5) — falling back to the Claude Agent SDK');
  }
  return 'sdk';
}
