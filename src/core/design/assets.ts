// ImportAsset (PD-46): copies a project font or image into the design's assets/, which the designer cannot write.
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import type { ImportAssetDetails } from '../../shared/types/design';
import type { ProjectFiles } from './citations';
import { ASSETS_DIR, MAX_DESIGN_FILES } from './design-paths';
import { writeTextAtomic } from './design-state';

export const MAX_ASSET_BYTES: number = 5 * 1024 * 1024;
export const ASSET_EXTENSIONS: ReadonlySet<string> = new Set(['woff', 'woff2', 'ttf', 'otf', 'png', 'jpg', 'webp', 'gif', 'svg', 'ico']);

/** Thrown for a source ImportAsset refuses; its message tells the model why. */
export class AssetRefusedError extends Error {}

/** A name safe as one file of assets/: letters, digits, `.`, `-` and `_`. */
function assetName(source: string): string {
  const base = path.basename(source).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return base === '' ? 'asset' : base;
}

/**
 * The bytes of source `source` (named `file` to the model), read through one handle whose identity matches the walked entry:
 * a regular file, not a link, with one hard link and at most MAX_ASSET_BYTES bytes.
 */
async function readAssetSource(source: string, file: string): Promise<Buffer> {
  const linked = await fs.lstat(source, { bigint: true });
  if (!linked.isFile()) throw new AssetRefusedError(`${file} is not a regular file`);
  let handle: FileHandle;
  try {
    // O_NOFOLLOW is POSIX only; on win32 the identity check below catches a link swapped in after the lstat.
    handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new AssetRefusedError(`${file} is not a regular file`);
    throw err;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino) throw new AssetRefusedError(`${file} is not a regular file`);
    // A hard link shares its bytes with a name outside the project, which no path check sees.
    if (opened.nlink !== 1n) throw new AssetRefusedError(`${file} has more than one hard link`);
    if (opened.size > BigInt(MAX_ASSET_BYTES)) throw new AssetRefusedError(`${file} is larger than 5 MiB`);
    // At most one byte past the cap, so a file that grew after the stat is refused, never read whole.
    const buffer = Buffer.allocUnsafe(MAX_ASSET_BYTES + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_ASSET_BYTES) throw new AssetRefusedError(`${file} is larger than 5 MiB`);
    }
    return Buffer.from(buffer.subarray(0, total));
  } finally {
    await handle.close();
  }
}

/**
 * Copies project file `file` (relative to the working folder, resolved through the host's confinement rule) into
 * `<folder>/assets/`. It must be a regular file with one link, of an allowed type, at most 5 MiB. A file of the same
 * name and bytes is reused; another one gets a numbered name.
 */
export async function importAsset(files: ProjectFiles, file: string, folder: string): Promise<ImportAssetDetails> {
  const resolved = await files.resolve(file);
  if (!resolved.ok) throw new AssetRefusedError(resolved.reason);
  const extension = path.extname(resolved.path).slice(1).toLowerCase();
  if (!ASSET_EXTENSIONS.has(extension)) throw new AssetRefusedError(`${file} is not a font or image ImportAsset copies (${[...ASSET_EXTENSIONS].join(', ')})`);
  const bytes = await readAssetSource(resolved.path, file);
  const name = assetName(resolved.path);
  const stem = name.slice(0, name.length - path.extname(name).length);
  const ext = path.extname(name);
  for (let n = 1; n <= MAX_DESIGN_FILES; n++) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
    const target = path.join(folder, ASSETS_DIR, candidate);
    let existing: Buffer | undefined;
    try {
      existing = await fs.readFile(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (existing && !existing.equals(bytes)) continue;
    if (!existing) await writeTextAtomic(target, bytes);
    return { asset: `${ASSETS_DIR}/${candidate}`, bytes: bytes.length };
  }
  throw new AssetRefusedError(`assets/ already holds ${MAX_DESIGN_FILES} other files named like ${name}`);
}
