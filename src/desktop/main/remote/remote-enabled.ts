/**
 * Whether remote features show: always in a development build, and in a packaged build only with DAMOCLES_REMOTE=1. While
 * false no remote entry point shows and no remote project is restored (docs/invariants.md "Remote daemon and wire").
 */
export function remoteEnabled(app: { readonly isPackaged: boolean }, env: Readonly<Record<string, string | undefined>>): boolean {
  return !app.isPackaged || env['DAMOCLES_REMOTE'] === '1';
}

/** What a remote entry point serves while the gate is open; a call past a closed gate is refused, never served. */
export function gated<T>(enabled: boolean, serve: () => T): T {
  if (!enabled) throw new Error('Remote hosts are not enabled in this build');
  return serve();
}
