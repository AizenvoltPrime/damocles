// What one design page renders from (D86): the hash width checks reuse a probe at, a journey vouches for, and DesignParity
// compares with the delivered version's.
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { hashDesignFile, MAX_SERVED_DESIGN_BYTES, readDesignFile } from './design-file-read';
import { designContentHash, listDesignFiles } from './design-files';
import { ASSETS_DIR, SHARED_DIR, TOKENS_FILE } from './design-paths';
import { designRefPath, pageRefs, stylesheetRefs } from './design-refs';

/**
 * The scheme every render input hash starts with. A hash without it was made by an earlier formula, so it matches no hash
 * made now; a version record holding one is judged by its folder content hash instead (`renderInputsMatch`).
 */
export const RENDER_HASH_SCHEME = 'r2:';

const CSS_FILE = /\.css$/i;
// an @import chain is followed this deep and this many stylesheets a page, so a cycle or a long chain costs a bounded read
const MAX_IMPORT_DEPTH = 8;
const MAX_STYLESHEETS = 64;

interface InputRead {
  readonly hash: string;
  readonly text?: string;
}

/** One call's reads, so an input many pages load is read and hashed once. */
interface InputCache {
  readonly reads: Map<string, Promise<InputRead>>;
  scripted?: Promise<readonly string[]>;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * One input's hash through the confined read, or what kept it from being read, so a file that appears, goes or turns into a
 * link changes the hash; a stylesheet's text too, whose own refs are inputs, and any other file streamed.
 */
function inputRead(folder: string, relPath: string, cache: InputCache): Promise<InputRead> {
  let read = cache.reads.get(relPath);
  if (!read) {
    read = CSS_FILE.test(relPath)
      ? readDesignFile(folder, relPath, MAX_SERVED_DESIGN_BYTES).then((file) => (file.kind === 'file' ? { hash: sha256(file.bytes), text: file.bytes.toString('utf8') } : { hash: file.kind }))
      : hashDesignFile(folder, relPath, MAX_SERVED_DESIGN_BYTES).then((file) => ({ hash: file.kind === 'file' ? file.hash : file.kind }));
    cache.reads.set(relPath, read);
  }
  return read;
}

/** Every file below shared/ and assets/, which a page that runs script may load by any name it builds. */
function scriptReachable(folder: string, cache: InputCache): Promise<readonly string[]> {
  cache.scripted ??= Promise.all([SHARED_DIR, ASSETS_DIR].map(async (dir) => (await listDesignFiles(path.join(folder, dir))).map((file) => `${dir}/${file.path}`))).then((lists) => lists.flat());
  return cache.scripted;
}

/**
 * Each render input of page `page` by design-folder-relative path, with its bytes' hash: the page, tokens.css, every local file
 * the page loads, every file under shared/ and assets/ when the page runs any script, and what each stylesheet among those
 * loads: its `@import`s, followed transitively (MAX_IMPORT_DEPTH deep, MAX_STYLESHEETS a page, each once), and the files its
 * declarations load.
 */
export async function screenRenderInputs(folder: string, page: string, cache: InputCache = { reads: new Map() }): Promise<ReadonlyMap<string, string>> {
  const inputs = new Map<string, string>();
  const pageRead = await readDesignFile(folder, page, MAX_SERVED_DESIGN_BYTES);
  inputs.set(page, pageRead.kind === 'file' ? sha256(pageRead.bytes) : pageRead.kind);
  // a stylesheet's @imports are followed; any other file is an input only
  const queue: { readonly file: string; readonly sheet: boolean; readonly depth: number }[] = [{ file: TOKENS_FILE, sheet: true, depth: 0 }];
  const enqueue = (from: string, refs: readonly string[], sheet: boolean | undefined, depth: number): void => {
    for (const ref of refs) {
      const file = designRefPath(from, ref);
      if (file !== undefined) queue.push({ file, sheet: sheet ?? CSS_FILE.test(file), depth });
    }
  };
  if (pageRead.kind === 'file') {
    const loaded = pageRefs(pageRead.bytes.toString('utf8'));
    enqueue(page, loaded.refs, undefined, 0);
    enqueue(page, loaded.imports, true, 0);
    if (loaded.scripted) for (const file of await scriptReachable(folder, cache)) queue.push({ file, sheet: false, depth: 0 });
  }
  let sheets = 0;
  for (let at = 0; at < queue.length; at++) {
    const { file, sheet, depth } = queue[at]!;
    if (inputs.has(file)) continue;
    const read = await inputRead(folder, file, cache);
    inputs.set(file, read.hash);
    if (!sheet || read.text === undefined || ++sheets > MAX_STYLESHEETS) continue;
    const refs = stylesheetRefs(read.text);
    enqueue(file, refs.resources, false, depth);
    if (depth < MAX_IMPORT_DEPTH) enqueue(file, refs.imports, true, depth + 1);
  }
  return inputs;
}

/** Each screen's render inputs (`screenRenderInputs`) hashed into one value, by screen file, each starting RENDER_HASH_SCHEME. */
export async function renderInputHashes(folder: string, screenFiles: readonly string[]): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const cache: InputCache = { reads: new Map() };
  for (const file of screenFiles) {
    const inputs = await screenRenderInputs(folder, file, cache);
    const hash = createHash('sha256').update(`${file}\n`);
    for (const relPath of [...inputs.keys()].sort()) hash.update(`${relPath}\0${inputs.get(relPath)!}\n`);
    hashes[file] = `${RENDER_HASH_SCHEME}${hash.digest('hex')}`;
  }
  return hashes;
}

/**
 * Whether page `file` renders now from what a version record with `renderHashes` and `contentHash` was made at: by its render
 * input hash when the record holds one of the current scheme, else by the folder's content hash, which covers every render input,
 * so a record of an earlier scheme, or of none, still matches an unchanged design.
 */
export async function renderInputsMatch(folder: string, file: string, renderHashes: Readonly<Record<string, string>> | undefined, contentHash: string): Promise<boolean> {
  const recorded = renderHashes?.[file];
  if (recorded?.startsWith(RENDER_HASH_SCHEME)) return recorded === (await renderInputHashes(folder, [file]))[file];
  return contentHash === (await designContentHash(folder));
}
