// The server packages' manifest, dist/desktop/server-manifest.json beside main.js: inside app.asar in a packaged app, written
// by scripts/build-server.mjs (the release from all eight packages, a dev build from the local ones).
import * as path from 'node:path';
import { readFile } from '../../../core/resource-fs';
import { parseServerManifest, SERVER_TARGETS, type ServerManifest } from './server-manifest-format';

export const SERVER_MANIFEST_FILE = 'server-manifest.json';

/** missing: no manifest; invalid: unreadable or malformed; incomplete: a packaged app's manifest lacks a target or its version. */
export type ManifestRefusal = 'missing' | 'invalid' | 'incomplete';

export type ManifestRead = { readonly manifest: ServerManifest } | { readonly refused: ManifestRefusal; readonly detail: string };

/**
 * The manifest in `desktopDir` (main.js's folder). A packaged app refuses one that lacks a target or names another
 * version than `appVersion`; a dev build takes the packages it has.
 */
export async function readServerManifest(desktopDir: string, appVersion: string, packaged: boolean): Promise<ManifestRead> {
  const file = path.join(desktopDir, SERVER_MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    return { refused: 'missing', detail: `${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  let manifest: ServerManifest | undefined;
  try {
    manifest = parseServerManifest(JSON.parse(text));
  } catch {
    manifest = undefined;
  }
  if (!manifest) return { refused: 'invalid', detail: `${file} is not a server package manifest` };
  if (!packaged) return { manifest };
  const missing = SERVER_TARGETS.filter((target) => !manifest.packages[target]);
  if (manifest.version !== appVersion || missing.length > 0) {
    return { refused: 'incomplete', detail: `${file} is for ${manifest.version}${missing.length ? ` and lacks ${missing.join(', ')}` : ''}; this app is ${appVersion}` };
  }
  return { manifest };
}
