import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tarGz } from '../server-archive.mjs';
import { pluginDigest, pluginFiles, subscriptionPluginFiles, subscriptionPluginProblems, vendorSubscriptionPlugin } from '../subscription-plugin.mjs';
import { SUBSCRIPTION_COMMIT, SUBSCRIPTION_REPO } from '../../src/core/pi-session/subscription-pin.ts';
import { SUBSCRIPTION_SOURCE } from '../../src/core/pi-session/subscription.ts';

const TOP = `pi-anthropic-auth-${SUBSCRIPTION_COMMIT}`;
const FILES = [
  { path: 'package.json', data: Buffer.from('{"pi":{"extensions":["./src/index.ts"]}}') },
  { path: 'LICENSE', data: Buffer.from('MIT License') },
  { path: 'src/index.ts', data: Buffer.from('export default function () {}\n') },
];

/** GitHub's archive of the commit: everything under one top folder, tests and docs included. */
function archive(files = FILES): Buffer {
  return tarGz([...files, { path: 'README.md', data: Buffer.from('#') }, { path: 'test/a.test.ts', data: Buffer.from('') }].map((file) => ({ path: `${TOP}/${file.path}`, mode: 0o644, data: file.data })));
}

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'damocles-subscription-plugin-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the subscription plugin a server package bundles', () => {
  it('pins the commit this computer installs, from one source', () => {
    expect(SUBSCRIPTION_SOURCE).toBe(`${SUBSCRIPTION_REPO}@${SUBSCRIPTION_COMMIT}`);
  });

  it('takes package.json, LICENSE and src/ from the archive, without its top folder', () => {
    expect(pluginFiles(archive()).map((file) => file.path).sort()).toEqual(['LICENSE', 'package.json', 'src/index.ts']);
  });

  it('vendors files whose digest matches the pin, and caches the archive for the next build', async () => {
    const cacheDir = tempDir();
    const dest = join(tempDir(), 'subscription-plugin');
    const expected = pluginDigest(FILES);
    let downloads = 0;
    const fetchArchive = async () => {
      downloads++;
      return archive();
    };

    expect(await vendorSubscriptionPlugin(dest, { cacheDir, fetchArchive, expected })).toBe(expected);
    expect(readFileSync(join(dest, 'LICENSE'), 'utf8')).toBe('MIT License');
    expect(existsSync(join(dest, 'README.md'))).toBe(false);
    await subscriptionPluginFiles({ cacheDir, fetchArchive, expected });
    expect(downloads).toBe(1);
  });

  it('refuses an archive whose files differ from the pinned digest, writing and caching nothing', async () => {
    const cacheDir = tempDir();
    const dest = join(tempDir(), 'subscription-plugin');
    const tampered = FILES.map((file) => (file.path === 'src/index.ts' ? { ...file, data: Buffer.from('export default function () { steal(); }\n') } : file));

    await expect(vendorSubscriptionPlugin(dest, { cacheDir, fetchArchive: async () => archive(tampered), expected: pluginDigest(FILES) })).rejects.toThrow(/subscription-pin\.ts pins/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(cacheDir, `pi-anthropic-auth-${SUBSCRIPTION_COMMIT}.tar.gz`))).toBe(false);
  });

  it('verify finds the pinned plugin with its LICENSE in a package, and names a tampered, unlicensed or missing one', () => {
    const expected = pluginDigest(FILES);
    const entries = (files: typeof FILES) => [{ path: 'dist/daemon.js', data: Buffer.from('') }, ...files.map((file) => ({ path: `dist/subscription-plugin/${file.path}`, data: file.data }))];

    expect(subscriptionPluginProblems(entries(FILES), expected)).toEqual([]);
    expect(subscriptionPluginProblems(entries(FILES.map((file) => ({ ...file, data: Buffer.concat([file.data, Buffer.from(' ')]) }))), expected)).toEqual([expect.stringMatching(/has digest .* not the pinned/)]);
    expect(subscriptionPluginProblems(entries(FILES.filter((file) => file.path !== 'LICENSE')), expected)).toContain('no dist/subscription-plugin/LICENSE');
    expect(subscriptionPluginProblems(entries([]), expected)).toEqual(['no dist/subscription-plugin/']);
  });
});
