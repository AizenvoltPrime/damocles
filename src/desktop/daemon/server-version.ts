// The server version a daemon runs as: its server package's server-package.json `serverVersion` (`<app version>+<build>`), or,
// for the checkout's own daemon, which has no server-package.json, package.json's version.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isVersionText } from '../../remote/handshake';
import { isAppVersion } from '../../shared/app-version';

function versionField(file: string, key: 'serverVersion' | 'version', text: string): string {
  const value = (JSON.parse(text) as Record<string, unknown> | null)?.[key];
  if (!isVersionText(value)) throw new Error(`${file} names no ${key === 'version' ? 'version' : 'server version'}`);
  return value;
}

/** The version the welcome, the pid file and `damocles --version` carry for the server under `root`. */
export async function readServerVersion(root: string): Promise<string> {
  const info = path.join(root, 'server-package.json');
  let text: string;
  try {
    text = await fs.readFile(info, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const manifest = path.join(root, 'package.json');
    return versionField(manifest, 'version', await fs.readFile(manifest, 'utf8'));
  }
  return versionField(info, 'serverVersion', text);
}

/**
 * The release's minimum server version the server package under `root` carries, which its daemon raises the host's security
 * floor to; undefined for a package of a release that requires none and for the checkout.
 */
export async function readMinimumServerVersion(root: string): Promise<string | undefined> {
  const info = path.join(root, 'server-package.json');
  let text: string;
  try {
    text = await fs.readFile(info, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return undefined;
  }
  const value = (JSON.parse(text) as Record<string, unknown> | null)?.['minimumServerVersion'];
  if (value === undefined) return undefined;
  if (!isAppVersion(value)) throw new Error(`${info} names a minimum server version that is no app version`);
  return value;
}
