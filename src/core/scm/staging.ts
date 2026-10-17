// Hunk staging (Stage and Unstage Hunk and Selected Ranges) and the quick diff's base, after VS Code's
// extensions/git/src/commands.ts (_stageChanges, unstageSelectedRanges) and quickDiffProvider.ts. Core writes the index blob
// itself: hash-object -w --path, so clean filters and autocrlf apply, then update-index with the entry's own mode.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { applyLineChanges, invertLineChange, lineCountOf, type LineChange } from '../../shared/scm/apply-line-changes';
import { checkRepoPath, MAX_SHOW_BYTES, type Repository, type RepositoryStatus } from './repository';

export type TextEncoding = 'utf8' | 'utf16le' | 'utf16be';

// The open document's encoding and byte order mark, which every blob of its file is read and written in.
export interface TextCodec {
  readonly encoding: TextEncoding;
  readonly bom: boolean;
}

// Must equal BYTE_ORDER_MARK in src/desktop/main/platform/editor-document.ts.
const BYTE_ORDER_MARK: Readonly<Record<TextEncoding, readonly number[]>> = {
  utf8: [0xef, 0xbb, 0xbf],
  utf16le: [0xff, 0xfe],
  utf16be: [0xfe, 0xff],
};

// git's own binary sniff: a NUL in the first 8000 bytes (xdiff's buffer_is_binary).
export const BINARY_SNIFF_BYTES = 8000;
const LFS_POINTER = 'version https://git-lfs.github.com/spec/';
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

// One `ls-tree -z` record of a blob, its object name captured.
export const TREE_BLOB: RegExp = /^\d{6} blob ([0-9a-f]{40}|[0-9a-f]{64})\t/;

/** A blob's text in the codec's encoding, its byte order mark dropped; undefined when the bytes do not decode. */
export function decodeBlob(bytes: Buffer, codec: TextCodec): string | undefined {
  const mark = BYTE_ORDER_MARK[codec.encoding];
  const body = mark.every((byte, index) => bytes[index] === byte) ? bytes.subarray(mark.length) : bytes;
  if (codec.encoding === 'utf8') {
    try {
      return strictUtf8.decode(body);
    } catch (err) {
      if (err instanceof TypeError) return undefined;
      throw err;
    }
  }
  if (body.length % 2 !== 0) return undefined;
  const little = codec.encoding === 'utf16le' ? body : Buffer.from(body).swap16();
  return little.toString('utf16le');
}

/** The bytes of text in the codec's encoding, with its byte order mark when the codec has one. */
export function encodeBlob(text: string, codec: TextCodec): Buffer {
  const little = codec.encoding === 'utf8' ? Buffer.from(text, 'utf8') : Buffer.from(text, 'utf16le');
  const body = codec.encoding === 'utf16be' ? little.swap16() : little;
  return codec.bom ? Buffer.concat([Buffer.from(BYTE_ORDER_MARK[codec.encoding]), body]) : body;
}

/** A blob's own encoding when no document names one: its byte order mark, else UTF-8 (the editor's rule, decodeDocument). */
export function detectCodec(bytes: Buffer): TextCodec {
  for (const encoding of ['utf8', 'utf16le', 'utf16be'] as const) {
    if (BYTE_ORDER_MARK[encoding].every((byte, index) => bytes[index] === byte)) return { encoding, bom: true };
  }
  return { encoding: 'utf8', bom: false };
}

/** Whether bytes git treats as binary; a UTF-16 document holds NUL bytes by nature, so only a UTF-8 one is sniffed. */
export function isBinary(bytes: Buffer, codec: TextCodec): boolean {
  return codec.encoding === 'utf8' && bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/** HEAD's path of a file: the source of a rename or copy the index group holds, else the file's own path. */
export function headPathOf(status: RepositoryStatus | undefined, relativePath: string): string {
  const change = status?.groups.index.find((candidate) => candidate.path === relativePath);
  return (change?.status === 'INDEX_RENAMED' || change?.status === 'INDEX_COPIED') && change.originalPath !== undefined ? change.originalPath : relativePath;
}

// git converts the file between this encoding in the work tree and UTF-8 in its blobs (convert.c git_path_check_encoding):
// a value, other than UTF-8 itself.
function reencodes(value: string | undefined): boolean {
  return value !== undefined && !['unspecified', 'unset', 'set'].includes(value) && !/^utf-?8$/i.test(value);
}

// A blob's object name, in the hash a sibling object name of the same repository is in.
function blobOid(bytes: Buffer, sibling: string): string {
  return createHash(sibling.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

type Run = (args: readonly string[], options?: { readonly maxOutputBytes?: number; readonly allowFailure?: boolean; readonly literalPathspecs?: true }) => Promise<{ readonly exitCode: number; readonly stdout: Buffer }>;

// check-attr -z: path, attribute and value, NUL-separated, for each attribute asked.
async function attributesOf(run: Run, relativePath: string, names: readonly string[]): Promise<Map<string, string>> {
  const fields = (await run(['check-attr', '-z', ...names, '--', relativePath], { literalPathspecs: true })).stdout.toString('utf8').split('\0');
  const values = new Map<string, string>();
  for (let at = 0; at + 2 < fields.length; at += 3) values.set(fields[at + 1]!, fields[at + 2]!);
  return values;
}

// A blob's bytes up to MAX_SHOW_BYTES.
async function blobWith(run: Run, oid: string): Promise<Buffer | 'tooLarge'> {
  const size = Number((await run(['cat-file', '-s', oid])).stdout.toString('utf8').trim());
  if (!Number.isFinite(size) || size > MAX_SHOW_BYTES) return 'tooLarge';
  return (await run(['cat-file', 'blob', oid], { maxOutputBytes: MAX_SHOW_BYTES })).stdout;
}

// HEAD's blob of a path; undefined on an unborn branch or when HEAD lacks it.
async function headBlobOid(run: Run, headPath: string): Promise<string | undefined> {
  const listed = await run(['ls-tree', '-z', 'HEAD', '--', headPath], { allowFailure: true, literalPathspecs: true });
  return listed.exitCode === 0 ? TREE_BLOB.exec(listed.stdout.toString('utf8'))?.[1] : undefined;
}

export interface IndexEntry {
  readonly mode: string;
  readonly oid: string;
}

// ls-files -s of one path: stage 0's entry, 'conflicted' while stages 1 to 3 exist, undefined when the index lacks it.
async function indexEntry(git: (args: readonly string[]) => Promise<Buffer>, relativePath: string): Promise<IndexEntry | 'conflicted' | undefined> {
  const out = (await git(['ls-files', '-s', '-z', '--', relativePath])).toString('utf8');
  const records = out.split('\0').filter((record) => record !== '');
  const entries = records.flatMap((record) => {
    const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) (\d)\t(.*)$/s.exec(record);
    return match && match[4] === relativePath ? [{ mode: match[1]!, oid: match[2]!, stage: match[3]! }] : [];
  });
  if (entries.some((entry) => entry.stage !== '0')) return 'conflicted';
  const entry = entries[0];
  return entry ? { mode: entry.mode, oid: entry.oid } : undefined;
}

export type StageRefusal =
  // the index entry, or for an unstage HEAD's blob, is no longer the one the ranges were computed against
  | 'changed'
  // stages 1 to 3 exist: a merge conflict
  | 'conflicted'
  // the file lies in an untrusted project inside the repository, which no engine write may touch
  | 'declined'
  | 'symlink'
  | 'submodule'
  | 'lfs'
  | 'binary'
  | 'tooLarge'
  // a side does not decode in the document's encoding
  | 'encoding'
  // a range names a line past either side: the buffer is not the text the ranges were computed from
  | 'outOfRange';

export type StageOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: StageRefusal };

interface RangesRequest {
  readonly path: string;
  readonly ranges: readonly LineChange[];
  readonly indexOid: string;
  // the open document's encoding; absent, the index blob's own (an unstage from a diff tab with the file not open)
  readonly codec?: TextCodec;
}

// A stage carries the document's buffer, read when the request arrived: index → buffer ranges applied onto the index. An
// unstage carries HEAD's blob the HEAD → index ranges were computed against (null when HEAD lacks the file), applied inverted.
export type StageRangesRequest = RangesRequest & ({ readonly buffer: string } | { readonly headOid: string | null });

// Every range must fit both sides: start and end at most the side's line count (a pure insertion's start is the line it follows).
function fits(ranges: readonly LineChange[], originalLines: number, modifiedLines: number): boolean {
  return ranges.every(
    (range) =>
      range.originalStartLineNumber <= originalLines &&
      range.originalEndLineNumber <= originalLines &&
      range.modifiedStartLineNumber <= modifiedLines &&
      range.modifiedEndLineNumber <= modifiedLines,
  );
}

// The empty blob's object name, fixed per object format, read once per repository.
const emptyBlobs = new WeakMap<Repository, string>();

/**
 * Stage or unstage in one mutation slot. Refuses before writing anything when the index entry is not indexOid, or for an
 * unstage when HEAD's blob at the file's HEAD path (a staged rename's source) is not headOid. The result is encoded in the
 * document's encoding and byte order mark and written with hash-object -w --path, so git's clean filter, autocrlf and
 * working-tree-encoding turn it into the index's form; the mode stays the entry's (100644 for a new file).
 * declined: the untrusted project roots inside the repository, '/' relative to its root.
 */
export function stageRanges(repo: Repository, request: StageRangesRequest, declined: readonly string[]): Promise<StageOutcome> {
  checkRepoPath(request.path);
  const target = request.path;
  // folded on Windows and macOS, as the trust fence compares paths there
  const folded = process.platform === 'win32' || process.platform === 'darwin';
  const key = (relative: string): string => (folded ? relative.toLowerCase() : relative);
  const isDeclined = (relative: string): boolean => declined.some((root) => key(relative) === key(root) || key(relative).startsWith(`${key(root)}/`));
  if (isDeclined(target)) return Promise.resolve({ ok: false, reason: 'declined' });
  return repo.mutate(async (git) => {
    const run: Run = (args, options) => git(args, { english: true, ...options });
    const entry = await indexEntry(async (args) => (await run(args, { literalPathspecs: true })).stdout, target);
    if (entry === 'conflicted') return { ok: false, reason: 'conflicted' };
    let emptyOid = emptyBlobs.get(repo);
    if (emptyOid === undefined) {
      emptyOid = (await git(['hash-object', '-t', 'blob', '--stdin'], { english: true, input: '' })).stdout.toString('utf8').trim();
      emptyBlobs.set(repo, emptyOid);
    }
    if ((entry?.oid ?? emptyOid) !== request.indexOid) return { ok: false, reason: 'changed' };
    if (entry?.mode === '120000') return { ok: false, reason: 'symlink' };
    if (entry?.mode === '160000') return { ok: false, reason: 'submodule' };
    const stat = await fs.lstat(path.join(repo.root, ...target.split('/'))).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return undefined;
      throw err;
    });
    if (stat?.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    const attributes = await attributesOf(run, target, ['filter', 'working-tree-encoding']);
    if (attributes.get('filter') === 'lfs') return { ok: false, reason: 'lfs' };
    const indexBytes = entry ? await blobWith(run, entry.oid) : Buffer.alloc(0);
    if (indexBytes === 'tooLarge') return { ok: false, reason: 'tooLarge' };
    if (indexBytes.subarray(0, LFS_POINTER.length).toString('latin1') === LFS_POINTER) return { ok: false, reason: 'lfs' };
    // Under working-tree-encoding the blobs are UTF-8 and git re-encodes the document's bytes as it hashes them.
    const reencoded = reencodes(attributes.get('working-tree-encoding'));
    const blobCodec = reencoded ? detectCodec(indexBytes) : request.codec ?? detectCodec(indexBytes);
    const writeCodec = reencoded ? request.codec : blobCodec;
    if (isBinary(indexBytes, blobCodec)) return { ok: false, reason: 'binary' };
    let indexText = decodeBlob(indexBytes, blobCodec);
    if (indexText === undefined) return { ok: false, reason: 'encoding' };
    let result: string;
    if ('buffer' in request) {
      if (!fits(request.ranges, lineCountOf(indexText), lineCountOf(request.buffer))) return { ok: false, reason: 'outOfRange' };
      // git's safer autocrlf: with no CR in the index, clean turns CRLF into LF and core.safecrlf refuses a lone LF beside
      // them, so the index's lines take the buffer's CRLF whenever clean converts it (writeCodec is set for a stage)
      if (!indexText.includes('\r') && request.buffer.includes('\r\n') && writeCodec !== undefined) {
        const probe = await git(['hash-object', `--path=${target}`, '--stdin'], { english: true, input: encodeBlob('\r\n', writeCodec), allowFailure: true });
        if (probe.exitCode === 0 && probe.stdout.toString('utf8').trim() === blobOid(encodeBlob('\n', blobCodec), emptyOid)) indexText = indexText.replace(/\n/g, '\r\n');
      }
      result = applyLineChanges(indexText, request.buffer, request.ranges);
    } else {
      const headPath = headPathOf(repo.lastStatus, target);
      if (isDeclined(headPath)) return { ok: false, reason: 'declined' };
      const headOid = await headBlobOid(run, headPath);
      if ((headOid ?? null) !== request.headOid) return { ok: false, reason: 'changed' };
      const head = headOid === undefined ? undefined : await blobWith(run, headOid);
      if (head === 'tooLarge') return { ok: false, reason: 'tooLarge' };
      if (head !== undefined && isBinary(head, blobCodec)) return { ok: false, reason: 'binary' };
      const headText = head === undefined ? '' : decodeBlob(head, blobCodec);
      if (headText === undefined) return { ok: false, reason: 'encoding' };
      if (!fits(request.ranges, lineCountOf(headText), lineCountOf(indexText))) return { ok: false, reason: 'outOfRange' };
      result = applyLineChanges(indexText, headText, request.ranges.map(invertLineChange));
    }
    // Without a document under working-tree-encoding the result is already the index's UTF-8 form, which git must not convert again.
    const hash = writeCodec === undefined ? ['hash-object', '-w', '--stdin'] : ['hash-object', '-w', `--path=${target}`, '--stdin'];
    const oid = (await git(hash, { english: true, input: encodeBlob(result, writeCodec ?? blobCodec) })).stdout.toString('utf8').trim();
    await git(['update-index', ...(entry ? [] : ['--add']), '--cacheinfo', `${entry?.mode ?? '100644'},${oid},${target}`], { english: true });
    return { ok: true };
  });
}

export type QuickDiffBase =
  | { readonly ok: true; readonly indexText: string; readonly indexOid: string; readonly headText: string | null; readonly headOid: string | null }
  | { readonly ok: false; readonly reason: 'untracked' | 'merge' | 'symlink' | 'lfs' | 'binary' | 'tooLarge' | 'encoding' };

/**
 * The quick diff's original sides, decoded with the document's codec (else the index blob's own; under working-tree-encoding
 * the blobs' own UTF-8): the index (VS Code's working tree provider), and HEAD at the file's HEAD path when staged is set (its
 * index provider, shown for a file in the index group only). The caller has checked the file's group, ignore state and
 * repository; this reads the blobs in the read queue.
 */
export async function quickDiffBase(repo: Repository, relativePath: string, documentCodec: TextCodec | undefined, staged: boolean): Promise<QuickDiffBase> {
  checkRepoPath(relativePath);
  const run: Run = (args, options) => repo.read(args, options);
  const listed = await run(['ls-files', '-s', '-z', '--', relativePath], { literalPathspecs: true });
  const entry = await indexEntry(() => Promise.resolve(listed.stdout), relativePath);
  if (entry === 'conflicted') return { ok: false, reason: 'merge' };
  if (entry === undefined) return { ok: false, reason: 'untracked' };
  if (entry.mode === '120000' || entry.mode === '160000') return { ok: false, reason: 'symlink' };
  const attributes = await attributesOf(run, relativePath, ['filter', 'working-tree-encoding']);
  if (attributes.get('filter') === 'lfs') return { ok: false, reason: 'lfs' };
  const index = await blobWith(run, entry.oid);
  if (index === 'tooLarge') return { ok: false, reason: 'tooLarge' };
  if (index.subarray(0, LFS_POINTER.length).toString('latin1') === LFS_POINTER) return { ok: false, reason: 'lfs' };
  const codec = reencodes(attributes.get('working-tree-encoding')) ? detectCodec(index) : documentCodec ?? detectCodec(index);
  if (isBinary(index, codec)) return { ok: false, reason: 'binary' };
  const indexText = decodeBlob(index, codec);
  if (indexText === undefined) return { ok: false, reason: 'encoding' };
  const unstaged = { ok: true as const, indexText, indexOid: entry.oid, headText: null, headOid: null };
  if (!staged) return unstaged;
  const headOid = await headBlobOid(run, headPathOf(repo.lastStatus, relativePath));
  if (headOid === undefined) return unstaged;
  const head = await blobWith(run, headOid);
  if (head === 'tooLarge') return { ok: false, reason: 'tooLarge' };
  if (isBinary(head, codec)) return { ok: false, reason: 'binary' };
  const headText = decodeBlob(head, codec);
  if (headText === undefined) return { ok: false, reason: 'encoding' };
  return { ok: true, indexText, indexOid: entry.oid, headText, headOid };
}

/** A blob's bytes up to MAX_SHOW_BYTES, in the read queue. */
export function readBlob(repo: Repository, oid: string): Promise<Buffer | 'tooLarge'> {
  return blobWith((args, options) => repo.read(args, options), oid);
}
