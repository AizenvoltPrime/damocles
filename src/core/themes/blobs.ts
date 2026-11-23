// Content-addressed theme assets under ~/.damocles/themes/blobs/<sha256> (docs/invariants.md "Desktop themes"). Core writes
// them inside the write lane; main reads one only while a theme or draft it read names it.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createThemePathRule, type ThemePathRule } from './network-rule';

// Must match BLOBS_FOLDER in src/desktop/main/themes/theme-blobs.ts.
export const BLOBS_FOLDER = 'blobs';
export const SHA256: RegExp = /^[0-9a-f]{64}$/;
const SHA256_IN_TEXT = /[0-9a-f]{64}/g;
// An unreferenced blob younger than this is kept: the theme editor may hold it in a draft that is not saved yet.
export const BLOB_GRACE_MS: number = 24 * 60 * 60 * 1000;

export const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface BlobStore {
  // stores `bytes` once under their sha256 and returns it; a blob already there is checked against them and counts as
  // written now, so the grace period starts again. Call inside the write lane.
  put(bytes: Uint8Array): Promise<string>;
  // removes every blob none of `texts` names and older than BLOB_GRACE_MS; call inside the write lane
  collect(texts: readonly string[], now: number): Promise<number>;
}

export function createBlobStore(root: string, writeText: (file: string, bytes: Uint8Array) => Promise<void>, rule: ThemePathRule = createThemePathRule(root)): BlobStore {
  const dir = path.join(root, BLOBS_FOLDER);
  return {
    async put(bytes) {
      const sha = sha256Of(bytes);
      const file = path.join(dir, sha);
      await rule.writable(file);
      let stored: Uint8Array | undefined;
      try {
        stored = await fs.readFile(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (stored !== undefined && sha256Of(stored) === sha) {
        const now = new Date();
        await fs.utimes(file, now, now);
        return sha;
      }
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await writeText(file, bytes);
      return sha;
    },
    async collect(texts, now) {
      const live = new Set(texts.flatMap((text) => text.match(SHA256_IN_TEXT) ?? []));
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
        const file = path.join(dir, name);
        const stat = await rule.writable(file).then(() => fs.stat(file)).catch(() => undefined);
        if (!stat?.isFile() || now - stat.mtimeMs < BLOB_GRACE_MS) continue;
        await fs.rm(file, { force: true });
        removed++;
      }
      return removed;
    },
  };
}
