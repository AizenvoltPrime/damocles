import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import { feedProblems, rewriteFeed } from '../signed-windows-feed.mjs';

const INSTALLER = 'Damocles-Setup-1.2.3-x64.exe';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'signed-feed-test-'));
  writeFileSync(join(dir, INSTALLER), Buffer.alloc(200_000, 7));
  writeFileSync(join(dir, `${INSTALLER}.blockmap`), 'stale');
  // The shape electron-builder writes, with values that match no file.
  writeFileSync(join(dir, 'latest-x64.yml'), [
    'version: 1.2.3',
    'files:',
    `  - url: ${INSTALLER}`,
    '    sha512: bm90LXRoZS1maWxl',
    '    size: 1',
    `path: ${INSTALLER}`,
    'sha512: bm90LXRoZS1maWxl',
    "releaseDate: '2026-10-10T04:38:04.881Z'",
    '',
  ].join('\n'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the update feed of a signed Windows installer', () => {
  it('fails until rewritten from the installer, then passes', async () => {
    expect(await feedProblems(dir, 'x64')).toHaveLength(4);
    await rewriteFeed(dir, 'x64');
    expect(await feedProblems(dir, 'x64')).toEqual([]);
  });

  it('fails again when the installer changes after the rewrite, as signing it would', async () => {
    await rewriteFeed(dir, 'x64');
    appendFileSync(join(dir, INSTALLER), 'signature');
    expect(await feedProblems(dir, 'x64')).toEqual([
      expect.stringContaining('sha512 of'),
      expect.stringContaining('size of'),
      expect.stringContaining('top-level sha512'),
      expect.stringContaining('.blockmap was not built from the file'),
    ]);
  });

  // js-yaml, which electron-updater reads the feed with, turns an unquoted timestamp into a Date.
  it('keeps every other field as electron-builder wrote it', async () => {
    await rewriteFeed(dir, 'x64');
    const text = readFileSync(join(dir, 'latest-x64.yml'), 'utf8');
    expect(text).toContain("releaseDate: '2026-10-10T04:38:04.881Z'");
    expect(text).toMatch(/^version: 1\.2\.3$/m);
    expect(text).toMatch(new RegExp(`^path: ${INSTALLER.replaceAll('.', '\\.')}$`, 'm'));
  });

  it('refuses a file that is not an update feed', async () => {
    writeFileSync(join(dir, 'latest-x64.yml'), 'version: 1.2.3\n');
    await expect(feedProblems(dir, 'x64')).rejects.toThrow(/not an electron-builder update feed/);
  });
});
