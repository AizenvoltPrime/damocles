import * as path from 'node:path';

// scripts/build-server.ts replaces this module's source with `true` when it bundles a server package; the dev tree's
// daemon (dist/daemon.js from esbuild.config.ts) keeps `false`.
export const SERVER_PACKAGE: boolean = false;

/**
 * The folder holding the terminals' remote-cli and helpers: a server package's bin/, or in a checkout the dist/server-bin
 * the desktop build writes (esbuild.config.ts writeCheckoutServerBin), whose scripts run this checkout's dist/cli-remote.js.
 */
export function terminalBinFolder(root: string, serverPackage: boolean = SERVER_PACKAGE): string {
  return serverPackage ? path.join(root, 'bin') : path.join(root, 'dist', 'server-bin');
}

/** Whether the daemon serves e2e.* and gives its core e2e hooks: only a dev-tree daemon, and only when the variable asks. */
export function daemonE2eHooks(env: NodeJS.ProcessEnv, serverPackage: boolean = SERVER_PACKAGE): boolean {
  return !serverPackage && env['DAMOCLES_E2E_HOOKS'] === '1';
}

/**
 * The e2e hooks' shorter reconnection grace, held-frame bound and actor intent expiry, read only where daemonE2eHooks holds:
 * DAMOCLES_E2E_RECONNECTION_GRACE_MS, DAMOCLES_E2E_MAX_HELD_BYTES and DAMOCLES_E2E_ACTOR_INTENT_EXPIRY_MS, each a positive
 * integer within its bound.
 */
export function e2eConnectionLimits(env: NodeJS.ProcessEnv): { readonly graceMs?: number; readonly maxHeldBytes?: number; readonly actorIntentExpiryMs?: number } {
  const positive = (name: string, max: number): number | undefined => {
    const raw = env[name];
    if (raw === undefined) return undefined;
    if (!/^[1-9][0-9]{0,14}$/.test(raw) || Number(raw) > max) throw new Error(`${name} must be a positive integer up to ${max}`);
    return Number(raw);
  };
  // setTimeout fires a longer delay after 1 ms
  const graceMs = positive('DAMOCLES_E2E_RECONNECTION_GRACE_MS', 2 ** 31 - 1);
  const maxHeldBytes = positive('DAMOCLES_E2E_MAX_HELD_BYTES', Number.MAX_SAFE_INTEGER);
  const actorIntentExpiryMs = positive('DAMOCLES_E2E_ACTOR_INTENT_EXPIRY_MS', 2 ** 31 - 1);
  return {
    ...(graceMs !== undefined ? { graceMs } : {}),
    ...(maxHeldBytes !== undefined ? { maxHeldBytes } : {}),
    ...(actorIntentExpiryMs !== undefined ? { actorIntentExpiryMs } : {}),
  };
}
