import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVER_TARGETS as SCRIPT_TARGETS, serverArtifact } from '../../../../../scripts/server-targets.ts';
import { readServerManifest, SERVER_MANIFEST_FILE } from '../server-manifest';
import { appVersionOf, parseServerManifest, SERVER_TARGETS, serverVersionsOf, type ServerManifest } from '../server-manifest-format';

const SHA = 'a'.repeat(64);
// a build per target, as each target's package hashes to its own
const buildOf = (target: string): string => SERVER_TARGETS.indexOf(target as never).toString(16).repeat(12);
const full = (version: string): ServerManifest => ({
  version,
  protocolVersion: 1,
  published: false,
  packages: Object.fromEntries(SERVER_TARGETS.map((target) => [target, { file: serverArtifact(target, version) as string, sha256: SHA, size: 10, serverVersion: `${version}+${buildOf(target)}` }])),
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function desktopDir(content?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'server-manifest-'));
  dirs.push(dir);
  if (content !== undefined) writeFileSync(path.join(dir, SERVER_MANIFEST_FILE), content);
  return dir;
}

describe('the server manifest', () => {
  it('names the targets scripts/server-targets.ts builds', () => {
    expect([...SERVER_TARGETS].sort()).toEqual(Object.keys(SCRIPT_TARGETS).sort());
  });

  it('parses what build-server.ts writes', () => {
    expect(parseServerManifest(full('3.7.0'))).toEqual(full('3.7.0'));
  });

  it('refuses an unknown target, a path in a file name, a malformed hash or size', () => {
    const base = full('3.7.0');
    const pkg = base.packages['linux-x64']!;
    for (const packages of [
      { 'plan9-x64': pkg },
      { 'linux-x64': { ...pkg, file: '../damocles-server-3.7.0-linux-x64.tar.gz' } },
      { 'linux-x64': { ...pkg, file: 'damocles-server-3.7.0-linux-x64.sh' } },
      { 'linux-x64': { ...pkg, sha256: 'A'.repeat(64) } },
      { 'linux-x64': { ...pkg, size: 0 } },
    ]) expect(parseServerManifest({ ...base, packages })).toBeUndefined();
    expect(parseServerManifest({ version: '3.7.0', packages: {} })).toBeUndefined();
  });

  it('refuses a version that is not an app version, since the artifact cache names a folder after it', () => {
    for (const version of ['', '..', '.', '../3.7.0', '3.7.0/..', '3.7']) expect(parseServerManifest({ ...full('3.7.0'), version }), version).toBeUndefined();
    expect(parseServerManifest(full('3.8.0-beta.1'))).toEqual(full('3.8.0-beta.1'));
    // the build follows the one +, so the app version carries none
    expect(parseServerManifest(full('3.7.0+local'))).toBeUndefined();
  });

  it('needs each package\'s server version to be the version and a 12 hex digit build, and published to be a boolean', () => {
    const base = full('3.7.0');
    const pkg = base.packages['linux-x64']!;
    for (const serverVersion of [undefined, '3.7.0', '3.7.1+0123456789ab', '3.7.0+0123456789AB', '3.7.0+0123456789a', '3.7.0+0123456789abc', '3.7.0-0123456789ab', '3.7.0+01234567 9ab']) {
      expect(parseServerManifest({ ...base, packages: { 'linux-x64': { ...pkg, serverVersion } } }), String(serverVersion)).toBeUndefined();
    }
    for (const published of [undefined, 'true', 1]) expect(parseServerManifest({ ...base, published }), String(published)).toBeUndefined();
    expect(parseServerManifest({ ...base, published: true })).toEqual({ ...base, published: true });
  });

  it('gives the server versions of its packages, and the app version of a server version', () => {
    expect(serverVersionsOf(full('3.7.0'))).toEqual(new Set(SERVER_TARGETS.map((target) => `3.7.0+${buildOf(target)}`)));
    expect(serverVersionsOf({ ...full('3.7.0'), packages: {} })).toEqual(new Set());
    expect(appVersionOf('3.7.0+0123456789ab')).toBe('3.7.0');
    expect(appVersionOf('3.8.0-beta.1+0123456789ab')).toBe('3.8.0-beta.1');
    expect(appVersionOf('3.7.0')).toBe('3.7.0');
  });

  it('refuses remote features in a packaged app without a manifest, with an incomplete one or another version\'s', async () => {
    expect(await readServerManifest(desktopDir(), '3.7.0', true)).toMatchObject({ refused: 'missing' });
    expect(await readServerManifest(desktopDir('{"version":'), '3.7.0', true)).toMatchObject({ refused: 'invalid' });
    const partial = { ...full('3.7.0'), packages: { 'win32-x64': full('3.7.0').packages['win32-x64'] } };
    expect(await readServerManifest(desktopDir(JSON.stringify(partial)), '3.7.0', true)).toMatchObject({ refused: 'incomplete' });
    expect(await readServerManifest(desktopDir(JSON.stringify(full('3.6.0'))), '3.7.0', true)).toMatchObject({ refused: 'incomplete' });
    expect(await readServerManifest(desktopDir(JSON.stringify(full('3.7.0'))), '3.7.0', true)).toEqual({ manifest: full('3.7.0') });
  });

  it('takes the packages a dev build has', async () => {
    const partial = { ...full('3.7.0'), packages: { 'win32-x64': full('3.7.0').packages['win32-x64'] } };
    expect(await readServerManifest(desktopDir(JSON.stringify(partial)), '3.7.0', false)).toEqual({ manifest: partial });
  });
});
