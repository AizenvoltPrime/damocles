// The walk process's messages, shared by its hosts and the process: one JSON text a line on its stdin and stdout, or structured
// clones over a utility process's parent port (walk-channels.ts).
import { BATCH_COMMAND_LINE, commandLineCost } from './command-line';
import type { WalkIgnore } from './walk';

// Files in a batch the walk sends by count; quickOpen.files carries one such batch, so the wire's bound is this.
export const WALK_BATCH_FILES = 1000;
// A count batch also ends before its paths pass this many UTF-16 units, so its line stays within MAX_WALK_LINE_BYTES.
export const WALK_BATCH_UNITS: number = 512 * 1024;
// The longest reply line a host reads: WALK_BATCH_UNITS units of JSON at most 6 bytes each (\uXXXX), the quotes and commas of
// WALK_BATCH_FILES files, and the envelope; an end's MAX_WALK_ERRORS messages take less.
export const MAX_WALK_LINE_BYTES: number = 4 * 1024 * 1024;
// A batch is sent when the walk next lists a folder, one with no file listed included, once its first file waited this long, so a
// slow walk still delivers; a folder whose read takes longer holds it until the read returns.
export const WALK_FLUSH_MS = 200;
// Batches a walk sends ahead of its host's acks; the walk reads no further folder while its credit is spent.
export const WALK_CREDIT = 4;
// Of a walk's unreadable folders, the ones its end names, each message cut to MAX_WALK_MESSAGE_CHARS.
export const MAX_WALK_ERRORS = 100;
export const MAX_WALK_MESSAGE_CHARS = 2000;
// The longest path a reply may name: Windows' extended path limit.
const MAX_WALKED_PATH_CHARS = 32_767;
// The most files any reply may carry: a command-line batch within BATCH_COMMAND_LINE at a one-character file's cost each, at least
// WALK_BATCH_FILES.
const MAX_REPLY_FILES: number = Math.max(WALK_BATCH_FILES, Math.ceil(BATCH_COMMAND_LINE / commandLineCost('x')));

/** One walk of the search walk (`walkFiles`), as its host asks for it. */
export interface WalkSpec {
  readonly root: string;
  // git's ignore rules apply only inside a repository; 'insideRepo' decides it from root and the folders above it, as pi's find does
  readonly requireGit: boolean | 'insideRepo';
  readonly ignore: WalkIgnore;
  readonly gitFolders: 'skip' | 'list';
  // rg --glob lines: an include, or an exclude after '!'
  readonly overrides: readonly string[];
  // the network hosts a `.git` file's pointer may lead onto (networkReach); the root's own (rootHosts) when left out
  readonly allowedHosts?: readonly string[];
  // the walk ends once it listed this many files
  readonly maxFiles?: number;
  // batches by command line instead of by count: a file costs commandLineCost(path), and a batch of more than one file stays
  // within this many units; at most BATCH_COMMAND_LINE, which MAX_REPLY_FILES assumes
  readonly lineBudget?: number;
}

/**
 * host → process. ack: the host took one of the walk's batches, which gives the walk one more. cancel: stop, and send nothing more
 * but the walk's released.
 */
export type WalkRequest =
  | ({ readonly kind: 'walk'; readonly id: number } & WalkSpec)
  | { readonly kind: 'ack'; readonly id: number }
  | { readonly kind: 'cancel'; readonly id: number };

/**
 * process → host. files: listed files, '/'-separated paths below the root. end: the walk is over, after its last batch; errors
 * names folders below the root it could not read (the walk went on), error the failure that ended it early, and reading that
 * folders it read ahead are still being read. released: a walk cancelled, or ended while reading, has no read left running.
 */
export type WalkReply =
  | { readonly kind: 'files'; readonly id: number; readonly files: readonly string[] }
  | { readonly kind: 'end'; readonly id: number; readonly errors: readonly string[]; readonly error?: string; readonly reading?: true }
  | { readonly kind: 'released'; readonly id: number };

/** The most files one batch of spec holds: a file of one character costs the least of a line budget. */
export function maxBatchFiles(spec: Pick<WalkSpec, 'lineBudget'>): number {
  return spec.lineBudget === undefined ? WALK_BATCH_FILES : Math.max(1, Math.floor(spec.lineBudget / commandLineCost('x')));
}

/** One message as a line; JSON escapes every line break and lone surrogate, so a path round-trips whole. */
export function walkLine(message: WalkRequest | WalkReply): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Splits a byte stream into its lines, each passed to onLine without its '\n'. A line that grows past maxBytes before its '\n'
 * goes to onOverflow instead, and the reader takes nothing more.
 */
export function lineReader(maxBytes: number, onLine: (line: string) => void, onOverflow: () => void): (chunk: Buffer) => void {
  let held: Buffer[] = [];
  let heldBytes = 0;
  let overflowed = false;
  return (chunk) => {
    if (overflowed) return;
    let start = 0;
    for (let end = chunk.indexOf(0x0a); end >= 0; end = chunk.indexOf(0x0a, start)) {
      if (heldBytes + end - start > maxBytes) break;
      const line = heldBytes === 0 ? chunk.subarray(start, end) : Buffer.concat([...held, chunk.subarray(start, end)]);
      held = [];
      heldBytes = 0;
      start = end + 1;
      onLine(line.toString('utf8'));
    }
    if (heldBytes + chunk.length - start > maxBytes) {
      overflowed = true;
      held = [];
      onOverflow();
      return;
    }
    if (start < chunk.length) {
      held.push(chunk.subarray(start));
      heldBytes += chunk.length - start;
    }
  };
}

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isMessage = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_WALK_MESSAGE_CHARS;

/** A path below a root as the walk sends it: '/'-separated, no empty, '.' or '..' segment, no NUL, and on Windows no '\' or ':'. */
export function isWalkedPath(value: unknown, platform: NodeJS.Platform = process.platform): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_WALKED_PATH_CHARS || value.includes('\0')) return false;
  if (platform === 'win32' && /[\\:]/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** A reply from the process, checked as untrusted data: anything outside the contract or its bounds is undefined. */
export function parseWalkReply(raw: unknown): WalkReply | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const kind = own(value, 'kind');
  const id = own(value, 'id');
  if (!isId(id)) return undefined;
  if (kind === 'files') {
    const files = own(value, 'files');
    // the host holds each walk to its own maxBatchFiles once it knows the id; the units bound is the line bound's on a channel without lines
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_REPLY_FILES || !files.every((file) => isWalkedPath(file))) return undefined;
    return (files as string[]).reduce((units, file) => units + file.length, 0) <= WALK_BATCH_UNITS ? { kind, id, files: files as string[] } : undefined;
  }
  if (kind === 'released') return { kind, id };
  if (kind !== 'end') return undefined;
  const errors = own(value, 'errors');
  const error = own(value, 'error');
  const reading = own(value, 'reading');
  if (!Array.isArray(errors) || errors.length > MAX_WALK_ERRORS || !errors.every(isMessage)) return undefined;
  if (error !== undefined && !isMessage(error)) return undefined;
  if (reading !== undefined && reading !== true) return undefined;
  return { kind, id, errors: errors as string[], ...(error !== undefined ? { error } : {}), ...(reading === true ? { reading } : {}) };
}
