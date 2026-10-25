// scripts/build-server.mjs replaces this module's source with `true` when it bundles a server package; the dev tree's
// daemon (dist/daemon.js from esbuild.config.mjs) keeps `false`.
export const SERVER_PACKAGE: boolean = false;

/** Whether the daemon serves e2e.* and gives its core e2e hooks: only a dev-tree daemon, and only when the variable asks. */
export function daemonE2eHooks(env: NodeJS.ProcessEnv, serverPackage: boolean = SERVER_PACKAGE): boolean {
  return !serverPackage && env['DAMOCLES_E2E_HOOKS'] === '1';
}
