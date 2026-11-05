import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LocalizedError, type LocalizedText } from '../shared/localized-text';
import { createFolderProbe } from './folder-probe';
import { l } from './l10n';

// Windows follows at most 63 links in one open, each giving a folder one more name, so the walk refuses no chain Windows opens.
const MAX_NAMES = 64;
// The links one walk follows across every reading of the path; each path's lstat and readlink run once per walk.
const MAX_LINK_STEPS = 4096;
const DRIVE_ANSWER_MS = 1000;

// Whether a drive or share root answers an lstat within DRIVE_ANSWER_MS. An offline one fails it only after about 21 s,
// holding a thread of the pool every file system call shares, so it is asked once at a time, a check that never settles is
// never repeated, and at most two hang at once: half of libuv's default pool of four.
const driveAnswers = createFolderProbe(DRIVE_ANSWER_MS, 60_000, {
  access: async (root) => {
    const started = performance.now();
    await fs.lstat(root).catch((err: unknown) => {
      if (performance.now() - started > DRIVE_ANSWER_MS) throw err;
    });
  },
  maxHung: 2,
});

// A link target as a local Windows path: \??\C:\ is how a junction names a drive; any other \??\ path, and a drive-relative
// C:x, which resolves against a per-drive cwd the OS keeps, is undefined.
function localLinkTarget(target: string): string | undefined {
  const spelled = target.replace(/\//g, '\\');
  if (!spelled.startsWith('\\??\\')) return /^[a-z]:(?!\\)/i.test(spelled) ? undefined : spelled;
  return /^\\\?\?\\[a-z]:\\/i.test(spelled) ? spelled.slice(4) : undefined;
}

// A path as the walk compares and keys it: resolved, with an upper-case drive letter, and otherwise as spelled, since an NTFS
// folder can be case-sensitive and hold both a and A.
function exact(file: string): string {
  const resolved = path.resolve(file);
  return /^[a-z]:/.test(resolved) ? resolved[0]!.toUpperCase() + resolved.slice(1) : resolved;
}

function isUnder(base: string, target: string): boolean {
  const folder = exact(base);
  const file = exact(target);
  return file === folder || file.startsWith(folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`);
}

// The parts of file below folder, which holds it (isUnder).
function segmentsUnder(folder: string, file: string): string[] {
  const from = exact(folder);
  return exact(file).slice(from.length).split(path.sep).filter(Boolean);
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// A share root keeps its trailing separator only once resolved.
const rootOf = (file: string): string => path.parse(path.resolve(file)).root;
const rootKey = (file: string): string => rootOf(file).toLowerCase();

function walkError(text: LocalizedText, code: 'ELOOP' | 'ETIMEDOUT'): Error {
  return Object.assign(new LocalizedError(text), { code });
}

// A name Windows may hold for a folder, against which it resolves a relative link there. origin is the folder the name was
// parsed from: the walk's start or a root.
interface Name {
  readonly path: string;
  readonly origin: string;
  // the mapped drive's share a reading on it was parsed through, which a reading from this name keeps
  readonly share?: string;
}

// A path a relative target may resolve to; share is the root of a mapped drive's realpath it was resolved through.
interface Reading {
  readonly path: string;
  readonly share?: string;
}

// The file system answers of one walk, which its readings share. links: by exact path, a link's local target, undefined for a
// target the walk refuses, null for an entry that is no link.
interface Seen {
  readonly links: Map<string, Promise<string | undefined | null>>;
  readonly realpaths: Map<string, Promise<string>>;
  steps: number;
}

interface Walk {
  // the folder a reading it holds is parsed from, and whether it is its own realpath
  readonly start: string;
  readonly startIsReal: boolean;
  // the walk's base, whose roots, its path's and its realpath's, are the shares a reading may lead onto
  readonly owner: string;
  readonly seen: Seen;
  readonly parsed: Map<string, Promise<readonly Name[] | false>>;
  // the readings being parsed, in the order they opened; tainted: one reached a reading opened before it, so its result holds
  // only in that reading's context and is not kept
  readonly parsing: Map<string, { tainted: boolean }>;
  startNames?: Promise<readonly Name[] | false>;
}

/**
 * Whether following every link along segments under base stays off UNC and device roots other than base's own (its path's
 * or its realpath's), decided by lstat and readlink alone (docs/invariants.md "Desktop host", Confinement). Rejects with the
 * error of a missing entry or a loop when every reading meets one, with a LocalizedError coded ELOOP past MAX_LINK_STEPS or
 * MAX_NAMES, and coded ETIMEDOUT when a drive other than base's that a link leads onto does not answer within
 * DRIVE_ANSWER_MS. baseIsReal: base is its own realpath. Always true off win32.
 */
export async function followsLocalLinksOnly(base: string, segments: readonly string[], options: { readonly baseIsReal?: boolean } = {}): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const seen: Seen = { links: new Map(), realpaths: new Map(), steps: 0 };
  const walk: Walk = { start: base, startIsReal: options.baseIsReal ?? false, owner: base, seen, parsed: new Map(), parsing: new Map() };
  return (await parse(walk, base, [{ path: base, origin: base }], segments)) !== false;
}

// The names of the folder segments lead to from start, whose names are startNames; false when a link leads off.
async function parse(walk: Walk, start: string, startNames: readonly Name[], segments: readonly string[]): Promise<readonly Name[] | false> {
  let current = start;
  let names = startNames;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const next = path.join(current, segment);
    const below = names.map((name) => ({ ...name, path: path.join(name.path, segment) }));
    const target = await linkAt(walk, next);
    if (target === null) {
      current = next;
      names = below;
      continue;
    }
    if (++walk.seen.steps > MAX_LINK_STEPS) throw tooManyLinks(walk);
    if (target === undefined) return false;
    if (/^(?:[a-z]:\\|\\\\)/i.test(target)) {
      // a junction keeps the link's own name for what follows, a symlink takes its target's
      const targetNames = await parseFrom(walk, { path: target });
      if (targetNames === false) return false;
      current = target;
      names = distinct(walk, [...below, ...targetNames]);
      continue;
    }
    const readings = await readingsOf(walk, names, target);
    return readings === false ? false : parseEach(walk, readings, segments.slice(index + 1));
  }
  return names;
}

function linkAt(walk: Walk, file: string): Promise<string | undefined | null> {
  const key = exact(file);
  let link = walk.seen.links.get(key);
  if (link === undefined) {
    link = fs.lstat(file).then(async (stats) => (stats.isSymbolicLink() ? localLinkTarget(await fs.readlink(file)) : null));
    walk.seen.links.set(key, link);
  }
  return link;
}

// Windows parses a path a link leads to afresh, so its walk starts at the walk's start when that holds it, else at its root.
function parseFrom(walk: Walk, reading: Reading): Promise<readonly Name[] | false> {
  const key = `${reading.share ?? ''}\0${exact(reading.path)}`;
  if (walk.parsing.has(key)) {
    let after = false;
    for (const [open, frame] of walk.parsing) {
      if (after) frame.tainted = true;
      after ||= open === key;
    }
    return Promise.reject(loop(walk));
  }
  let parsed = walk.parsed.get(key);
  if (parsed === undefined) {
    const frame = { tainted: false };
    walk.parsing.set(key, frame);
    parsed = parseReading(walk, reading).finally(() => {
      walk.parsing.delete(key);
      if (frame.tainted) walk.parsed.delete(key);
    });
    walk.parsed.set(key, parsed);
  }
  return parsed;
}

async function parseReading(walk: Walk, reading: Reading): Promise<readonly Name[] | false> {
  const target = reading.path;
  if (target.startsWith('\\\\') && rootKey(target) !== reading.share && !(await isOwnShare(walk, target))) return false;
  const share = reading.share === undefined ? {} : { share: reading.share };
  if (isUnder(walk.start, target)) return parse(walk, walk.start, [{ path: walk.start, origin: walk.start, ...share }], segmentsUnder(walk.start, target));
  const root = rootOf(target);
  if (/^[a-z]:\\$/i.test(root) && rootKey(root) !== rootKey(walk.start)) await requireAnswer(root.toUpperCase());
  return parse(walk, root, [{ path: root, origin: root, ...share }], segmentsUnder(root, target));
}

// root: a drive root, 'X:\', or a share root, '\\server\share\'
async function requireAnswer(root: string): Promise<void> {
  if (await driveAnswers(root)) return;
  const text = root.startsWith('\\\\') ? l('The network share {0} did not answer within a second.', root) : l('The drive {0} did not answer within a second.', root);
  throw walkError(text, 'ETIMEDOUT');
}

/**
 * Rejects as the walk does, with a LocalizedError coded ETIMEDOUT, when the root of target, an absolute win32 path, does not
 * answer within DRIVE_ANSWER_MS: a drive other than the system drive, or a share, never a device path. Resolves at once off
 * win32 and for any other path.
 */
export async function requireRootAnswers(target: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const root = rootOf(target);
  if (/^[a-z]:\\$/i.test(root)) {
    if (rootKey(root) !== `${process.env['SystemDrive'] ?? ''}\\`.toLowerCase()) await requireAnswer(root.toUpperCase());
    return;
  }
  if (root.startsWith('\\\\') && !/^\\\\[?.]\\/.test(root)) await requireAnswer(root);
}

async function parseEach(walk: Walk, readings: readonly Reading[], rest: readonly string[]): Promise<readonly Name[] | false> {
  const found: Name[] = [];
  let missing: unknown;
  for (const reading of readings) {
    let names: readonly Name[] | false;
    try {
      names = await parseFrom(walk, { ...reading, path: path.join(reading.path, ...rest) });
    } catch (err) {
      if (!isMissing(err) && !loops.has(err as Error)) throw err;
      missing ??= err;
      continue;
    }
    if (names === false) return false;
    found.push(...names);
  }
  if (found.length === 0) throw missing;
  return distinct(walk, found);
}

// Every path target may resolve to from names; false when the names of the walk's start, which a climb above it needs, lead off.
async function readingsOf(walk: Walk, names: readonly Name[], target: string): Promise<Reading[] | false> {
  const readings: Reading[] = [];
  for (const name of names) {
    readings.push(name.share === undefined ? { path: path.resolve(name.path, target) } : { path: path.resolve(name.path, target), share: name.share });
    if (!climbsAbove(name, target)) continue;
    const below = segmentsUnder(name.origin, name.path).join(path.sep);
    if (exact(name.origin) === exact(rootOf(name.origin))) {
      // a subst or mapped drive's root is named by its realpath
      const real = await realpathOf(walk, name.origin);
      if (exact(real) === exact(name.origin)) continue;
      const resolved = path.resolve(real, below, target);
      readings.push(real.startsWith('\\\\') && !name.origin.startsWith('\\\\') ? { path: resolved, share: rootKey(real) } : { path: resolved });
      continue;
    }
    const startNames = await namesOfStart(walk);
    if (startNames === false) return false;
    const derived = await readingsOf(walk, startNames.map((start) => ({ path: path.join(start.path, below), origin: start.origin })), target);
    if (derived === false) return false;
    readings.push(...derived);
  }
  return [...new Map(readings.map((reading) => [`${reading.share ?? ''}\0${exact(reading.path)}`, reading])).values()];
}

// The names Windows may hold for the walk's start, parsed from its root so every link above it gives its own; a realpath has
// no link above it.
function namesOfStart(walk: Walk): Promise<readonly Name[] | false> {
  const root = rootOf(walk.start);
  if (walk.startIsReal) return Promise.resolve([{ path: walk.start, origin: root }]);
  if (walk.startNames === undefined) {
    const above: Walk = { start: root, startIsReal: false, owner: walk.owner, seen: walk.seen, parsed: new Map(), parsing: new Map() };
    walk.startNames = parse(above, root, [{ path: root, origin: root }], segmentsUnder(root, walk.start));
  }
  return walk.startNames;
}

// Whether target, read from name, rises above name's origin on the way, a root-relative one always.
function climbsAbove(name: Name, target: string): boolean {
  if (/^[\\/]/.test(target)) return true;
  let depth = segmentsUnder(name.origin, name.path).length;
  for (const part of target.split(/[\\/]/)) {
    if (part === '..') {
      if (--depth < 0) return true;
    } else if (part !== '' && part !== '.') depth++;
  }
  return false;
}

async function isOwnShare(walk: Walk, target: string): Promise<boolean> {
  return rootKey(target) === rootKey(walk.owner) || rootKey(target) === rootKey(await realpathOf(walk, walk.owner));
}

function realpathOf(walk: Walk, folder: string): Promise<string> {
  if (walk.startIsReal && exact(folder) === exact(walk.start)) return Promise.resolve(folder);
  const key = exact(folder);
  let real = walk.seen.realpaths.get(key);
  if (real === undefined) walk.seen.realpaths.set(key, (real = fs.realpath(folder)));
  return real;
}

function distinct(walk: Walk, names: readonly Name[]): readonly Name[] {
  const kept = [...new Map(names.map((name) => [`${name.share ?? ''}\0${exact(name.path)}\0${exact(name.origin)}`, name])).values()];
  if (new Set(kept.map((name) => exact(name.path))).size > MAX_NAMES) throw tooManyLinks(walk);
  return kept;
}

// Errors of a reading that needs a reading still open above it: Windows would loop there too, so it leads nowhere there.
const loops = new WeakSet<Error>();

function loop(walk: Walk): Error {
  const err = tooManyLinks(walk);
  loops.add(err);
  return err;
}

function tooManyLinks(walk: Walk): Error {
  return walkError(l('The path under {0} goes through too many links.', walk.owner), 'ELOOP');
}
