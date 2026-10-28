// scripts/build-server.mjs replaces this module's source with `true` when it bundles a server package; the dev tree's
// daemon (dist/daemon.js from esbuild.config.mjs) keeps `false`.
export const SERVER_PACKAGE: boolean = false;

/** Whether the daemon serves e2e.* and gives its core e2e hooks: only a dev-tree daemon, and only when the variable asks. */
export function daemonE2eHooks(env: NodeJS.ProcessEnv, serverPackage: boolean = SERVER_PACKAGE): boolean {
  return !serverPackage && env['DAMOCLES_E2E_HOOKS'] === '1';
}

/**
 * The e2e hooks' shorter reconnection grace and held-frame bound, read only where daemonE2eHooks holds:
 * DAMOCLES_E2E_RECONNECTION_GRACE_MS and DAMOCLES_E2E_MAX_HELD_BYTES, each a positive integer within its bound.
 */
export function e2eConnectionLimits(env: NodeJS.ProcessEnv): { readonly graceMs?: number; readonly maxHeldBytes?: number } {
  const positive = (name: string, max: number): number | undefined => {
    const raw = env[name];
    if (raw === undefined) return undefined;
    if (!/^[1-9][0-9]{0,14}$/.test(raw) || Number(raw) > max) throw new Error(`${name} must be a positive integer up to ${max}`);
    return Number(raw);
  };
  // setTimeout fires a longer delay after 1 ms
  const graceMs = positive('DAMOCLES_E2E_RECONNECTION_GRACE_MS', 2 ** 31 - 1);
  const maxHeldBytes = positive('DAMOCLES_E2E_MAX_HELD_BYTES', Number.MAX_SAFE_INTEGER);
  return { ...(graceMs !== undefined ? { graceMs } : {}), ...(maxHeldBytes !== undefined ? { maxHeldBytes } : {}) };
}
