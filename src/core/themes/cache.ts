// What the theme renderer derived from each wallpaper and character sprite, under ~/.damocles/themes/cache/<sha256>/
// (docs/invariants.md "Desktop themes"): core writes it inside the write lane from main's answer to themes.analyze or
// themes.analyzeSprite; main reads it. flash.json also holds this computer's "Allow flashing for this file", which core writes
// only on the theme editor's request.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { SHA256 } from './blobs';
import { createThemePathRule, type ThemePathRule } from './network-rule';
import { readCapped } from './state-file';
import {
  CACHE_FOLDER, FLASH_CHECK_VERSION, FLASH_FILE, isFlashRecord, isImageStats, isStoredFlashRecord, isWallpaperPalette, PALETTE_FILE, STATS_FILE, STILL_FILE, THUMB_FILE,
  type FlashRecord, type ImageStats, type WallpaperPalette,
} from '../../shared/themes/wallpapers';

// stats.json, palette.json and flash.json hold a few numbers and colors each
const MAX_CACHE_JSON_BYTES = 64 * 1024;

export interface WallpaperAnalysis {
  readonly thumb: Uint8Array;
  readonly stats: ImageStats;
  readonly palette: WallpaperPalette;
  // a moving wallpaper's first frame as PNG and its flash check
  readonly still?: Uint8Array;
  readonly flash?: Omit<FlashRecord, 'allowed'>;
}

/** What the theme renderer derived from a character sprite. */
export interface SpriteAnalysis {
  readonly still?: Uint8Array;
  readonly flash: Omit<FlashRecord, 'allowed'>;
}

export interface WallpaperCache {
  // whether every derived file of `sha256` is there, a moving one's still frame and a flash check of today's rule included
  has(sha256: string, moving?: boolean): Promise<boolean>;
  // call inside the write lane; an allowance flash.json held is kept
  write(sha256: string, analysis: WallpaperAnalysis): Promise<void>;
  stats(sha256: string): Promise<ImageStats | undefined>;
  palette(sha256: string): Promise<WallpaperPalette | undefined>;
  // the flash check made under today's rule (FLASH_CHECK_VERSION); undefined for none and for an older rule's
  flash(sha256: string): Promise<FlashRecord | undefined>;
  // this computer's user allowed the flagged file to play; false when it has no flash check yet. Call inside the write lane.
  allowFlash(sha256: string): Promise<boolean>;
  // a character sprite's analysis: its flash check, and the still frame of an animated image or an SVG; call inside the write lane
  writeSprite(sha256: string, analysis: SpriteAnalysis): Promise<void>;
  // removes the folder of every sha256 `live` lacks; call inside the write lane
  collect(live: ReadonlySet<string>): Promise<number>;
}

export function createWallpaperCache(root: string, writeRaw: (file: string, bytes: Uint8Array | string) => Promise<void>, rule: ThemePathRule = createThemePathRule(root)): WallpaperCache {
  const dir = path.join(root, CACHE_FOLDER);
  const folder = (sha256: string): string => {
    if (!SHA256.test(sha256)) throw new Error(`${sha256} is not a sha256`);
    return path.join(dir, sha256);
  };
  const writeFile = async (file: string, bytes: Uint8Array | string): Promise<void> => {
    await rule.writable(file);
    await writeRaw(file, bytes);
  };
  const madeFolder = async (sha256: string): Promise<string> => {
    const target = folder(sha256);
    await rule.writable(target);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    return target;
  };
  const readJson = async (file: string): Promise<unknown> => {
    try {
      await rule.readable(file);
      return JSON.parse(await readCapped(file, MAX_CACHE_JSON_BYTES));
    } catch {
      return undefined;
    }
  };
  const flashFile = (sha256: string): string => path.join(folder(sha256), FLASH_FILE);
  const plain = ({ flagged, atMs, kind, allowed }: FlashRecord): FlashRecord => ({ flagged, ...(atMs !== undefined ? { atMs } : {}), ...(kind !== undefined ? { kind } : {}), ...(allowed === true ? { allowed } : {}) });
  const flash = async (sha256: string): Promise<FlashRecord | undefined> => {
    const value = await readJson(flashFile(sha256));
    return isStoredFlashRecord(value) ? plain(value) : undefined;
  };
  const writeRecord = (sha256: string, record: FlashRecord): Promise<void> => writeFile(flashFile(sha256), `${JSON.stringify({ version: FLASH_CHECK_VERSION, ...plain(record) })}\n`);
  const writeFlash = async (sha256: string, verdict: Omit<FlashRecord, 'allowed'>): Promise<void> => {
    // the allowance was given for the file, so it outlives a check an older rule made
    const before = await readJson(flashFile(sha256));
    await writeRecord(sha256, { ...verdict, ...(isFlashRecord(before) && before.allowed === true ? { allowed: true } : {}) });
  };
  return {
    async has(sha256, moving = false) {
      const names = moving ? [THUMB_FILE, STATS_FILE, PALETTE_FILE, STILL_FILE, FLASH_FILE] : [THUMB_FILE, STATS_FILE, PALETTE_FILE];
      const stats = await Promise.all(names.map((name) => {
        const file = path.join(folder(sha256), name);
        return rule.readable(file).then(() => fs.stat(file)).catch(() => undefined);
      }));
      return stats.every((stat) => stat?.isFile() === true) && (!moving || (await flash(sha256)) !== undefined);
    },
    async write(sha256, analysis) {
      const target = await madeFolder(sha256);
      await writeFile(path.join(target, THUMB_FILE), analysis.thumb);
      await writeFile(path.join(target, STATS_FILE), `${JSON.stringify(analysis.stats)}\n`);
      if (analysis.still) await writeFile(path.join(target, STILL_FILE), analysis.still);
      if (analysis.flash) await writeFlash(sha256, analysis.flash);
      // last, so a folder holding palette.json holds the rest too
      await writeFile(path.join(target, PALETTE_FILE), `${JSON.stringify(analysis.palette)}\n`);
    },
    async stats(sha256) {
      const value = await readJson(path.join(folder(sha256), STATS_FILE));
      return isImageStats(value) ? value : undefined;
    },
    async palette(sha256) {
      const value = await readJson(path.join(folder(sha256), PALETTE_FILE));
      return isWallpaperPalette(value) ? value : undefined;
    },
    flash,
    async allowFlash(sha256) {
      const record = await flash(sha256);
      if (!record) return false;
      if (record.allowed !== true) await writeRecord(sha256, { ...record, allowed: true });
      return true;
    },
    async writeSprite(sha256, analysis) {
      await madeFolder(sha256);
      if (analysis.still) await writeFile(path.join(folder(sha256), STILL_FILE), analysis.still);
      // last, so a folder holding flash.json holds the still frame too
      await writeFlash(sha256, analysis.flash);
    },
    async collect(live) {
      await rule.writable(dir);
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw err;
      }
      let removed = 0;
      for (const name of names) {
        if (!SHA256.test(name) || live.has(name)) continue;
        if (!(await rule.writable(path.join(dir, name)).then(() => true, () => false))) continue;
        await fs.rm(path.join(dir, name), { recursive: true, force: true });
        removed++;
      }
      return removed;
    },
  };
}
