import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASES_URL } from '../../src/desktop/main/updater';
// @ts-expect-error -- plain .mjs helper, no types
import { manifestProblem, matchesPackage, outputDirectory, packagedUserData, refuseReleased, releasesUrl } from '../dist-local.mjs';
// @ts-expect-error -- plain .mjs helper, no types
import { sha256 } from '../server-archive.mjs';

describe('the packaged app\'s userData', () => {
  it('is under APPDATA on Windows, and refuses before any build when APPDATA is unset', () => {
    expect(packagedUserData({ platform: 'win32', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, home: 'C:\\Users\\a' })).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'damocles'));
    expect(() => packagedUserData({ platform: 'win32', env: {}, home: 'C:\\Users\\a' })).toThrow('APPDATA is not set');
  });

  it('is under Application Support on macOS', () => {
    expect(packagedUserData({ platform: 'darwin', env: {}, home: '/Users/a', uid: 501 })).toBe(join('/Users/a', 'Library', 'Application Support', 'damocles'));
  });

  it('follows an absolute XDG_CONFIG_HOME on Linux and, as Chromium does, ignores a relative one', () => {
    expect(packagedUserData({ platform: 'linux', env: { XDG_CONFIG_HOME: '/srv/config' }, home: '/home/a', uid: 1000 })).toBe(join('/srv/config', 'damocles'));
    expect(packagedUserData({ platform: 'linux', env: { XDG_CONFIG_HOME: 'config' }, home: '/home/a', uid: 1000 })).toBe(join('/home/a', '.config', 'damocles'));
    expect(packagedUserData({ platform: 'linux', env: {}, home: '/home/a', uid: 1000 })).toBe(join('/home/a', '.config', 'damocles'));
  });

  it('refuses sudo on Linux, whose home is root\'s, but not a user who merely has SUDO_USER set', () => {
    expect(() => packagedUserData({ platform: 'linux', env: { SUDO_USER: 'a' }, home: '/root', uid: 0 })).toThrow('Run npm run dist:local as a, not under sudo');
    expect(packagedUserData({ platform: 'linux', env: { SUDO_USER: 'a' }, home: '/home/a', uid: 1000 })).toBe(join('/home/a', '.config', 'damocles'));
  });
});

describe('the release check', () => {
  const url = 'https://github.com/o/r/releases/download/v1.2.3/damocles-server-1.2.3-linux-x64.tar.gz';
  const answering = (status: number) => vi.fn(async () => new Response(null, { status }));

  it('derives the releases URL updater.ts uses from package.json', () => {
    expect(releasesUrl(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')))).toBe(RELEASES_URL);
  });

  it('proceeds only on a 404, asking with a HEAD that follows redirects', async () => {
    const fetchImpl = answering(404);
    await expect(refuseReleased(url, '1.2.3', fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'HEAD', redirect: 'follow' }));
  });

  it('refuses a version GitHub has packages for, naming the fix', async () => {
    await expect(refuseReleased(url, '1.2.3', answering(200))).rejects.toThrow('bump the version in package.json');
  });

  it('refuses when the check cannot decide', async () => {
    await expect(refuseReleased(url, '1.2.3', answering(503))).rejects.toThrow(`${url} answered 503`);
    await expect(refuseReleased(url, '1.2.3', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND github.com'); }))).rejects.toThrow('Could not check whether 1.2.3 has a GitHub release');
  });
});

describe('the manifest the app is packaged with', () => {
  const targets = ['linux-x64', 'win32-x64'];
  const packages = { 'linux-x64': { file: 'damocles-server-1.2.3-linux-x64.tar.gz' }, 'win32-x64': { file: 'damocles-server-1.2.3-win32-x64.zip' } };

  it('passes with every target at this version', () => {
    expect(manifestProblem({ version: '1.2.3', packages }, '1.2.3', targets)).toBeUndefined();
  });

  it('names the other version alone, or the missing targets too', () => {
    const other = manifestProblem({ version: '1.2.2', packages }, '1.2.3', targets);
    expect(other).toMatch(/is for 1\.2\.2; this build is 1\.2\.3$/);
    expect(manifestProblem({ version: '1.2.3', packages: { 'linux-x64': packages['linux-x64'] } }, '1.2.3', targets)).toMatch(/is for 1\.2\.3 and lacks win32-x64; this build is 1\.2\.3$/);
  });
});

describe('the copy into the server cache', () => {
  it('accepts only the bytes the manifest names, by SHA-256 and size', () => {
    const data = Buffer.from('package bytes');
    expect(matchesPackage(data, { sha256: sha256(data), size: data.length })).toBe(true);
    expect(matchesPackage(Buffer.from('rebuilt bytes'), { sha256: sha256(data), size: data.length })).toBe(false);
    expect(matchesPackage(data, { sha256: sha256(data), size: data.length + 1 })).toBe(false);
  });

  it('names dist-desktop/ only when no output directory was passed through', () => {
    expect(outputDirectory([])).toBe('dist-desktop/');
    expect(outputDirectory(['--dir'])).toBe('dist-desktop/');
    expect(outputDirectory(['-c.directories.output=out'])).toBe('the output directory you passed');
    expect(outputDirectory(['-c.directories.output', 'out'])).toBe('the output directory you passed');
    expect(outputDirectory(['--config.directories.output=out'])).toBe('the output directory you passed');
  });
});
