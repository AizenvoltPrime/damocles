import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readServerVersion } from '../server-version';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-version-'));
  roots.push(dir);
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  return dir;
}

describe('the server version a daemon runs as', () => {
  it('is a server package\'s serverVersion, not its app version', async () => {
    expect(await readServerVersion(root({ 'package.json': { version: '3.7.0' }, 'server-package.json': { version: '3.7.0', serverVersion: '3.7.0+0123456789ab' } }))).toBe('3.7.0+0123456789ab');
  });

  it('is package.json\'s version in the checkout, which has no server-package.json', async () => {
    expect(await readServerVersion(root({ 'package.json': { version: '3.7.0' } }))).toBe('3.7.0');
  });

  it('refuses a server-package.json without a server version the handshake takes, rather than reading package.json', async () => {
    for (const info of [{ version: '3.7.0' }, { version: '3.7.0', serverVersion: '3.7.0 0123456789ab' }, null]) {
      await expect(readServerVersion(root({ 'package.json': { version: '3.7.0' }, 'server-package.json': info })), JSON.stringify(info)).rejects.toThrow('server-package.json names no server version');
    }
  });

  it('refuses a checkout whose package.json names no version', async () => {
    await expect(readServerVersion(root({ 'package.json': {} }))).rejects.toThrow('package.json names no version');
  });
});
