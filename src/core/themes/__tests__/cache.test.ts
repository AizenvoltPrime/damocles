import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CACHE_FOLDER, FLASH_CHECK_VERSION, FLASH_FILE, PALETTE_FILE, STATS_FILE, STILL_FILE, THUMB_FILE } from '../../../shared/themes/wallpapers';
import { createWallpaperCache, type WallpaperCache } from '../cache';
import { writeFileAtomic } from '../store';

// A stored flash check counts only under the rule it ran under (docs/invariants.md "Desktop themes").

const SHA = 'a'.repeat(64);
let root: string;
let cache: WallpaperCache;
const flashFile = (): string => path.join(root, CACHE_FOLDER, SHA, FLASH_FILE);
const stored = (): unknown => JSON.parse(fs.readFileSync(flashFile(), 'utf8'));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-cache-'));
  fs.mkdirSync(path.join(root, CACHE_FOLDER, SHA), { recursive: true });
  for (const name of [THUMB_FILE, STATS_FILE, PALETTE_FILE, STILL_FILE]) fs.writeFileSync(path.join(root, CACHE_FOLDER, SHA, name), '{}');
  cache = createWallpaperCache(root, writeFileAtomic);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the stored flash check', () => {
  it('is written with the version of the flash rule and read back without it', async () => {
    await cache.writeSprite(SHA, { flash: { flagged: true, atMs: 250, kind: 'general' } });
    expect(stored()).toEqual({ version: FLASH_CHECK_VERSION, flagged: true, atMs: 250, kind: 'general' });
    expect(await cache.flash(SHA)).toEqual({ flagged: true, atMs: 250, kind: 'general' });
    expect(await cache.has(SHA, true)).toBe(true);
  });

  it.each([
    ['no version', { flagged: false }],
    ['an older version', { version: FLASH_CHECK_VERSION - 1, flagged: false }],
    ['a newer version', { version: FLASH_CHECK_VERSION + 1, flagged: false }],
  ])('reads a check of %s as none, so a moving image stays still and is analysed again', async (_what, record) => {
    fs.writeFileSync(flashFile(), JSON.stringify(record));
    expect(await cache.flash(SHA)).toBeUndefined();
    expect(await cache.has(SHA, true)).toBe(false);
    // a still wallpaper has no flash check to redo
    expect(await cache.has(SHA)).toBe(true);
    expect(await cache.allowFlash(SHA)).toBe(false);
  });

  it('keeps the allowance an older check held when the image is analysed again', async () => {
    fs.writeFileSync(flashFile(), JSON.stringify({ flagged: true, atMs: 900, allowed: true }));
    await cache.writeSprite(SHA, { flash: { flagged: true, atMs: 125, kind: 'general' } });
    expect(stored()).toEqual({ version: FLASH_CHECK_VERSION, flagged: true, atMs: 125, kind: 'general', allowed: true });
    expect(await cache.flash(SHA)).toEqual({ flagged: true, atMs: 125, kind: 'general', allowed: true });
  });

  it('writes an allowance beside the version', async () => {
    await cache.writeSprite(SHA, { flash: { flagged: true, atMs: 125 } });
    expect(await cache.allowFlash(SHA)).toBe(true);
    expect(stored()).toEqual({ version: FLASH_CHECK_VERSION, flagged: true, atMs: 125, allowed: true });
  });
});
