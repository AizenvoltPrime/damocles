import { lstatSync, promises as fs, readlinkSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { LocalizedError, type LocalizedText } from '../shared/localized-text';
import { createFolderProbe, PROCESS_HUNG_GATE } from './folder-probe';
import { l } from './l10n';
import { leavesLocalDrives, networkPathHost } from './network-fs';
import { mappedDrivePath } from './mapped-drives';

// Windows follows at most 63 links in one open, each giving a folder one more name, so the walk refuses no chain Windows opens.
const MAX_NAMES = 64;
// The links one walk follows across every reading of the path; each path's lstat and readlink run once per walk.
const MAX_LINK_STEPS = 4096;
// Each drive a mapping names is another letter, so a chain longer than the alphabet repeats one: a loop Windows cannot open.
const MAX_DRIVE_HOPS = 26;
const DRIVE_ANSWER_MS = 1000;
/** How long the drive probe keeps an answer, a drive that did not answer included. */
export const DRIVE_ANSWER_TTL_MS = 60_000;

// Whether a drive or share root answers an lstat within DRIVE_ANSWER_MS. An offline one fails it only after about 21 s,
// holding a thread of the pool every file system call shares, so it is asked once at a time, a check that never settles is
// never repeated, and none starts while the process's gate holds two hung checks.
const driveAnswers = createFolderProbe(DRIVE_ANSWER_MS, DRIVE_ANSWER_TTL_MS, {
  access: async (root) => {
    const started = performance.now();
    await fs.lstat(root).catch((err: unknown) => {
      if (performance.now() - started > DRIVE_ANSWER_MS) throw err;
    });
  },
  gate: PROCESS_HUNG_GATE,
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
export function exact(file: string): string {
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

/** Whether err is a missing entry, which stops a walk before anything past it is followed. */
export function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// A share root keeps its trailing separator only once resolved.
const rootOf = (file: string): string => path.parse(path.resolve(file)).root;
const rootKey = (file: string): string => rootOf(file).toLowerCase();
const isDriveRoot = (root: string): boolean => /^[a-z]:\\$/i.test(root);
// Every spelling Windows reads as a UNC or device path, `\??\` included.
const UNC_OR_DEVICE = /^(?:[\\/]{2}|[\\/]\?\?[\\/])/;
// The share component after the server of `\\server\share`, `\\?\UNC\server\share`, `\\.\UNC\...` and `\??\UNC\...`.
const UNC_SHARE = /^(?:[\\/]{2}[?.][\\/]unc[\\/]|[\\/]\?\?[\\/]unc[\\/]|[\\/]{2})[^\\/]*[\\/]([^\\/]+)/i;

/**
 * The share file is on, as one key for every spelling of it: host and share for a UNC path in any spelling (networkPathHost,
 * so FQDN and NetBIOS names of one server are different shares), the drive root for a drive path, and undefined for any other
 * device path, which no base owns.
 */
function shareKey(file: string): string | undefined {
  const host = networkPathHost(file);
  if (host === undefined) return UNC_OR_DEVICE.test(file) ? undefined : rootKey(file);
  const share = UNC_SHARE.exec(file)?.[1];
  return host === '' || share === undefined ? undefined : `\\\\${host}\\${share.toLowerCase()}`;
}

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

// A path a relative target may resolve to; share is the shareKey of a mapped drive's realpath it was resolved through.
interface Reading {
  readonly path: string;
  readonly share?: string;
}

// What the walk asks the file system, run by runAsync or runBlocking: link answers readlink's target or null for an entry that is
// no link; realpath the path's realpath; mapping mappedDrivePath's answer, which touches no volume; drive driveReach's answer;
// answer settles once requireAnswer does.
type Io =
  | { readonly op: 'link'; readonly file: string }
  | { readonly op: 'realpath'; readonly file: string }
  | { readonly op: 'mapping'; readonly root: string }
  | { readonly op: 'drive'; readonly root: string; readonly allowedHosts: ReadonlySet<string>; readonly hops: number }
  | { readonly op: 'answer'; readonly root: string };

type Step<T> = Generator<Io, T, unknown>;

export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/**
 * File system answers that synchronous walks run back to back may share, so a path several of them pass is read once: links
 * by exact path, readlink's target or null for an entry that is no link, and realpaths.
 */
export interface WalkAnswers {
  readonly links: Map<string, Outcome<string | null>>;
  readonly realpaths: Map<string, Outcome<string>>;
}

export function walkAnswers(): WalkAnswers {
  return { links: new Map(), realpaths: new Map() };
}

function* ask<T>(request: Io): Step<T> {
  return (yield request) as T;
}

function* settled<T>(step: Step<T>): Step<Outcome<T>> {
  try {
    return { ok: true, value: yield* step };
  } catch (error) {
    return { ok: false, error };
  }
}

function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.ok) return outcome.value;
  throw outcome.error;
}

async function runAsync<T>(step: Step<T>): Promise<T> {
  let next = step.next();
  while (!next.done) {
    let answer: unknown;
    try {
      answer = await performAsync(next.value);
    } catch (err) {
      next = step.throw(err);
      continue;
    }
    next = step.next(answer);
  }
  return next.value;
}

function performAsync(request: Io): Promise<unknown> {
  switch (request.op) {
    case 'link':
      return fs.lstat(request.file).then(async (stats) => (stats.isSymbolicLink() ? fs.readlink(request.file) : null));
    case 'realpath':
      return fs.realpath(request.file);
    case 'mapping':
      return Promise.resolve().then(() => mappedDrivePath(request.root));
    case 'drive':
      return driveReach(request.root, request.allowedHosts, request.hops);
    case 'answer':
      return requireAnswer(request.root);
  }
}

function runBlocking<T>(step: Step<T>): T {
  let next = step.next();
  while (!next.done) {
    let answer: unknown;
    try {
      answer = performBlocking(next.value);
    } catch (err) {
      next = step.throw(err);
      continue;
    }
    next = step.next(answer);
  }
  return next.value;
}

// A drive is never placed and never probed: the walk follows it as the user's own mapping, as a plain stat would.
function performBlocking(request: Io): unknown {
  switch (request.op) {
    case 'link':
      // eslint-disable-next-line damocles/no-sync -- for synchronous callers (pi's link policy, the sync config readers, the desktop watch factory), right before their own sync access of the path
      return lstatSync(request.file).isSymbolicLink() ? readlinkSync(request.file) : null;
    case 'realpath':
      return realpathSync.native(request.file);
    case 'mapping':
      return mappedDrivePath(request.root);
    case 'drive':
      return null;
    case 'answer':
      return undefined;
  }
}

// The file system answers of one walk, which its readings share (WalkAnswers). offHosts: the hosts of the link targets that led
// the walk off; offUnplaced: one of them names no host.
interface Seen extends WalkAnswers {
  readonly offHosts: Set<string>;
  offUnplaced: boolean;
  steps: number;
}

interface Walk {
  // the folder a reading it holds is parsed from, and whether it is its own realpath
  readonly start: string;
  readonly startIsReal: boolean;
  // the walk's base, whose shares (its path's, its realpath's and its drive's mapping's) a reading may lead onto
  readonly owner: string;
  // further shares (shareKey) a reading may lead onto: those of the bases a file outside every base sits beside
  readonly ownShares: ReadonlySet<string>;
  // whether a drive other than the start's that a link leads onto must answer (requireAnswer); only an async run waits
  readonly probesDrives: boolean;
  // hosts whose shares a reading may also lead onto (leavesLocalDrives); given, a drive is placed where Windows maps it
  readonly allowedHosts: ReadonlySet<string> | undefined;
  // the drive mappings followed to reach this walk (driveReach)
  readonly driveHops: number;
  readonly seen: Seen;
  readonly parsed: Map<string, Outcome<readonly Name[] | false>>;
  // the readings being parsed, in the order they opened; tainted: one reached a reading opened before it, so its result holds
  // only in that reading's context and is not kept
  readonly parsing: Map<string, { tainted: boolean }>;
  startNames?: Outcome<readonly Name[] | false>;
}

/**
 * Whether following every link along segments under base stays off UNC and device roots other than base's own shares (its
 * path's, its realpath's and, for a drive base, the share Windows maps its letter to; shareKey), decided by lstat and readlink
 * of the path's entries, the realpaths of base and of the drive roots a climbing link passes, and where Windows maps base's
 * drive and the drives a link leads onto (docs/invariants.md "Desktop host", Confinement). Rejects with the error of a missing
 * entry or a loop when every reading meets one, with a LocalizedError coded ELOOP past MAX_LINK_STEPS or MAX_NAMES, and coded
 * ETIMEDOUT when a drive other than base's that a link leads onto does not answer within DRIVE_ANSWER_MS. Without
 * allowedHosts that probe runs only for a drive Windows maps to a network redirector, or cannot say where it maps; a local
 * volume, and a subst onto a local path, is the user's own mapping and followed unprobed. baseIsReal: base is its own
 * realpath; allowedHosts: hosts whose shares, and WSL's, a link may also lead onto, and with them a drive other than base's
 * that a link leads onto counts as where Windows maps it (driveReach), which rejects when Windows cannot be asked. Always
 * true off win32.
 */
export async function followsLocalLinksOnly(base: string, segments: readonly string[], options: { readonly baseIsReal?: boolean; readonly allowedHosts?: ReadonlySet<string> } = {}): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  return (await runAsync(hostsOffLocalLinks(base, segments, { ...options, probesDrives: true }))) === null;
}

/**
 * followsLocalLinksOnly's walk of file from its root, synchronous and without allowedHosts: whether following every link on
 * file stays off UNC, WSL and device roots other than the one file starts on (its spelling's or, for a drive root, its
 * realpath's and its mapping's). A drive a link leads onto is followed without the drive probe, as the user's own mapping.
 * True when every reading meets a missing entry, which a stat of file then reports; false for any other failure, a loop
 * included. answers: what earlier walks of the same run read; ownShares: further shares (shareKey) a link may lead onto. Always
 * true off win32.
 */
export function linkStaysLocalSync(file: string, answers?: WalkAnswers, ownShares: ReadonlySet<string> = new Set()): boolean {
  if (process.platform !== 'win32') return true;
  const root = rootOf(file);
  try {
    return runBlocking(hostsOffLocalLinks(root, segmentsUnder(root, file), { ownShares, ...(answers === undefined ? {} : { answers }) })) === null;
  } catch (err) {
    return isMissing(err);
  }
}

/**
 * linkStaysLocalSync for a file outside every one of bases, with the bases' shares (each base's spelling's, its realpath's
 * and, for a drive base, its drive's mapping's) counted as the walk's own: a UNC or device spelling on none of them is refused
 * without anything on it being touched; any other file is walked from its root, and a link on its path may lead onto them.
 * Always true off win32.
 */
export function linkStaysLocalBesideSync(file: string, bases: readonly string[], answers: WalkAnswers = walkAnswers()): boolean {
  if (process.platform !== 'win32') return true;
  // as Node opens it: a `\??\` spelling resolves onto the current drive
  const resolved = path.resolve(file);
  const shares = runBlocking(sharesOfBases(bases, answers));
  if (UNC_OR_DEVICE.test(resolved)) {
    const key = shareKey(resolved);
    if (key === undefined || !shares.has(key)) return false;
  }
  // eslint-disable-next-line damocles/no-sync -- the synchronous form of this same check
  return linkStaysLocalSync(resolved, answers, shares);
}

/**
 * followsLocalLinksOnly without options, synchronous: the same walk from base, except that a drive a link leads onto is followed
 * without the drive probe, as linkStaysLocalSync does, so it never rejects with ETIMEDOUT. Throws as followsLocalLinksOnly
 * rejects otherwise. answers: what earlier walks of the same run read. Always true off win32.
 */
export function followsLocalLinksOnlySync(base: string, segments: readonly string[], answers?: WalkAnswers): boolean {
  if (process.platform !== 'win32') return true;
  return runBlocking(hostsOffLocalLinks(base, segments, answers === undefined ? {} : { answers })) === null;
}

// The walk of followsLocalLinksOnly on win32: null when it stays local, else the hosts of the link targets that led a reading
// off, and whether one of them names no host (a device path). Each reading stops at its first such link.
function* hostsOffLocalLinks(base: string, segments: readonly string[], options: { readonly baseIsReal?: boolean; readonly allowedHosts?: ReadonlySet<string>; readonly driveHops?: number; readonly answers?: WalkAnswers; readonly ownShares?: ReadonlySet<string>; readonly probesDrives?: boolean }): Step<{ hosts: ReadonlySet<string>; unplaced: boolean } | null> {
  const answers = options.answers ?? walkAnswers();
  const seen: Seen = { links: answers.links, realpaths: answers.realpaths, offHosts: new Set(), offUnplaced: false, steps: 0 };
  const walk: Walk = { start: base, startIsReal: options.baseIsReal ?? false, owner: base, ownShares: options.ownShares ?? new Set(), probesDrives: options.probesDrives ?? false, allowedHosts: options.allowedHosts, driveHops: options.driveHops ?? 0, seen, parsed: new Map(), parsing: new Map() };
  return (yield* parse(walk, base, [{ path: base, origin: base }], segments)) === false ? { hosts: seen.offHosts, unplaced: seen.offUnplaced } : null;
}

// false for a reading that leads off through target, whose host the walk keeps.
function ledOff(walk: Walk, target: string): false {
  const host = networkPathHost(target);
  if (host) walk.seen.offHosts.add(host);
  else walk.seen.offUnplaced = true;
  return false;
}

// The names of the folder segments lead to from start, whose names are startNames; false when a link leads off.
function* parse(walk: Walk, start: string, startNames: readonly Name[], segments: readonly string[]): Step<readonly Name[] | false> {
  let current = start;
  let names = startNames;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const next = path.join(current, segment);
    const below = names.map((name) => ({ ...name, path: path.join(name.path, segment) }));
    const linked = yield* linkAt(walk, next);
    if (linked === null) {
      current = next;
      names = below;
      continue;
    }
    if (++walk.seen.steps > MAX_LINK_STEPS) throw tooManyLinks(walk);
    const target = localLinkTarget(linked);
    if (target === undefined) return ledOff(walk, linked);
    if (/^(?:[a-z]:\\|\\\\)/i.test(target)) {
      // a junction keeps the link's own name for what follows, a symlink takes its target's
      const targetNames = yield* parseFrom(walk, { path: target });
      if (targetNames === false) return false;
      current = target;
      names = distinct(walk, [...below, ...targetNames]);
      continue;
    }
    const readings = yield* readingsOf(walk, names, target);
    return readings === false ? false : yield* parseEach(walk, readings, segments.slice(index + 1));
  }
  return names;
}

function* linkAt(walk: Walk, file: string): Step<string | null> {
  const key = exact(file);
  let link = walk.seen.links.get(key);
  if (link === undefined) {
    link = yield* settled(ask<string | null>({ op: 'link', file }));
    walk.seen.links.set(key, link);
  }
  return unwrap(link);
}

// Windows parses a path a link leads to afresh, so its walk starts at the walk's start when that holds it, else at its root.
function* parseFrom(walk: Walk, reading: Reading): Step<readonly Name[] | false> {
  const key = `${reading.share ?? ''}\0${exact(reading.path)}`;
  if (walk.parsing.has(key)) {
    let after = false;
    for (const [open, frame] of walk.parsing) {
      if (after) frame.tainted = true;
      after ||= open === key;
    }
    throw loop(walk);
  }
  let parsed = walk.parsed.get(key);
  if (parsed === undefined) {
    const frame = { tainted: false };
    walk.parsing.set(key, frame);
    try {
      parsed = yield* settled(parseReading(walk, reading));
    } finally {
      walk.parsing.delete(key);
    }
    if (!frame.tainted) walk.parsed.set(key, parsed);
  }
  return unwrap(parsed);
}

function* parseReading(walk: Walk, reading: Reading): Step<readonly Name[] | false> {
  const target = reading.path;
  if (target.startsWith('\\\\')) {
    const key = shareKey(target);
    if ((key === undefined || key !== reading.share) && !(yield* isOwnShare(walk, target)) && !allowedShare(walk, target)) return ledOff(walk, target);
  }
  const share = reading.share === undefined ? {} : { share: reading.share };
  if (isUnder(walk.start, target)) return yield* parse(walk, walk.start, [{ path: walk.start, origin: walk.start, ...share }], segmentsUnder(walk.start, target));
  const root = rootOf(target);
  if (isDriveRoot(root) && rootKey(root) !== rootKey(walk.start)) {
    if (walk.allowedHosts !== undefined) {
      const drive = yield* ask<Reach | null>({ op: 'drive', root, allowedHosts: walk.allowedHosts, hops: walk.driveHops });
      if (drive !== null) return ledOffTo(walk, drive);
    }
    if (walk.probesDrives && (walk.allowedHosts !== undefined || (yield* mapsOffLocalVolumes(root)))) yield* ask<void>({ op: 'answer', root: root.toUpperCase() });
  }
  return yield* parse(walk, root, [{ path: root, origin: root, ...share }], segmentsUnder(root, target));
}

// Whether Windows sends the paths of drive root past this computer's volumes: a network drive, a subst onto one through any
// chain of drives, or a drive it cannot place; a local volume and a subst onto a local path are not.
function* mapsOffLocalVolumes(root: string): Step<boolean> {
  let drive = root;
  for (let hops = 0; hops < MAX_DRIVE_HOPS; hops++) {
    const mapped = yield* settled(ask<string | null>({ op: 'mapping', root: drive }));
    if (!mapped.ok) return true;
    if (mapped.value === null) return false;
    const next = rootOf(mapped.value);
    if (!isDriveRoot(next)) return true;
    drive = next;
  }
  return true;
}

/**
 * What a drive root reaches by where Windows maps its letter, asked before anything on it is touched: null for a local volume,
 * a letter no drive has, or a mapping onto allowedHosts or WSL; else as networkReach answers for the mapped path (a network
 * drive's share, a subst drive's target with its own walk). hops counts the drives followed so far.
 */
async function driveReach(root: string, allowedHosts: ReadonlySet<string>, hops: number): Promise<Reach | null> {
  const mapped = mappedDrivePath(root);
  if (mapped === null) return null;
  if (hops >= MAX_DRIVE_HOPS) throw walkError(l('The path under {0} goes through too many links.', root), 'ELOOP');
  return reachOf(mapped, allowedHosts, hops + 1);
}

// false for a reading that leads off onto what reach names, whose hosts the walk keeps.
function ledOffTo(walk: Walk, reach: Reach): false {
  for (const host of reach.hosts) walk.seen.offHosts.add(host);
  walk.seen.offUnplaced ||= reach.unplaced;
  return false;
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

// Every reading is parsed, since Windows opens one the walk cannot tell, so the walk keeps the hosts of all that lead off.
function* parseEach(walk: Walk, readings: readonly Reading[], rest: readonly string[]): Step<readonly Name[] | false> {
  const found: Name[] = [];
  let missing: unknown;
  let off = false;
  for (const reading of readings) {
    let names: readonly Name[] | false;
    try {
      names = yield* parseFrom(walk, { ...reading, path: path.join(reading.path, ...rest) });
    } catch (err) {
      if (!isMissing(err) && !loops.has(err as Error)) throw err;
      missing ??= err;
      continue;
    }
    if (names === false) off = true;
    else found.push(...names);
  }
  if (off) return false;
  if (found.length === 0) throw missing;
  return distinct(walk, found);
}

// Every path target may resolve to from names; false when the names of the walk's start, which a climb above it needs, lead off.
function* readingsOf(walk: Walk, names: readonly Name[], target: string): Step<Reading[] | false> {
  const readings: Reading[] = [];
  for (const name of names) {
    readings.push(name.share === undefined ? { path: path.resolve(name.path, target) } : { path: path.resolve(name.path, target), share: name.share });
    if (!climbsAbove(name, target)) continue;
    const below = segmentsUnder(name.origin, name.path).join(path.sep);
    if (exact(name.origin) === exact(rootOf(name.origin))) {
      // a subst or mapped drive's root is named by its realpath
      const real = yield* realpathOf(walk, name.origin);
      if (exact(real) === exact(name.origin)) continue;
      const resolved = path.resolve(real, below, target);
      const share = real.startsWith('\\\\') && !name.origin.startsWith('\\\\') ? shareKey(real) : undefined;
      readings.push(share === undefined ? { path: resolved } : { path: resolved, share });
      continue;
    }
    const startNames = yield* namesOfStart(walk);
    if (startNames === false) return false;
    const derived = yield* readingsOf(walk, startNames.map((start) => ({ path: path.join(start.path, below), origin: start.origin })), target);
    if (derived === false) return false;
    readings.push(...derived);
  }
  return [...new Map(readings.map((reading) => [`${reading.share ?? ''}\0${exact(reading.path)}`, reading])).values()];
}

// The names Windows may hold for the walk's start, parsed from its root so every link above it gives its own; a realpath has
// no link above it.
function* namesOfStart(walk: Walk): Step<readonly Name[] | false> {
  const root = rootOf(walk.start);
  if (walk.startIsReal) return [{ path: walk.start, origin: root }];
  if (walk.startNames === undefined) {
    const above: Walk = { start: root, startIsReal: false, owner: walk.owner, ownShares: walk.ownShares, probesDrives: walk.probesDrives, allowedHosts: walk.allowedHosts, driveHops: walk.driveHops, seen: walk.seen, parsed: new Map(), parsing: new Map() };
    walk.startNames = yield* settled(parse(above, root, [{ path: root, origin: root }], segmentsUnder(root, walk.start)));
  }
  return unwrap(walk.startNames);
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

function allowedShare(walk: Walk, target: string): boolean {
  return walk.allowedHosts !== undefined && !leavesLocalDrives(target, walk.allowedHosts);
}

function* isOwnShare(walk: Walk, target: string): Step<boolean> {
  const key = shareKey(target);
  if (key === undefined) return false;
  return walk.ownShares.has(key) || key === shareKey(walk.owner) || key === shareKey(yield* realpathOf(walk, walk.owner)) || key === (yield* mappedShareOf(walk.owner));
}

// The share Windows maps the drive folder is on to, as the user spelled the mapping; a letter it cannot place adds none,
// which refuses more, never less.
function* mappedShareOf(folder: string): Step<string | undefined> {
  const root = rootOf(folder);
  if (!isDriveRoot(root)) return undefined;
  const mapped = yield* settled(ask<string | null>({ op: 'mapping', root }));
  return mapped.ok && mapped.value !== null && mapped.value.startsWith('\\\\') ? shareKey(mapped.value) : undefined;
}

// The shares of bases as isOwnShare counts a walk's base's; a base that does not resolve adds only its spelling's and mapping's.
function* sharesOfBases(bases: readonly string[], answers: WalkAnswers): Step<Set<string>> {
  const shares = new Set<string>();
  for (const base of bases) {
    const real = yield* settled(cachedRealpath(answers, base));
    for (const key of [shareKey(base), real.ok ? shareKey(real.value) : undefined, yield* mappedShareOf(base)]) {
      if (key !== undefined) shares.add(key);
    }
  }
  return shares;
}

/**
 * Whether real, the realpath a confinement took of a path under base once followsLocalLinksOnly passed it, may be used: on win32
 * a UNC or device realpath only on base's own shares (sharesOfBases: its spelling's, realBase's and its drive's mapping's) or on
 * the share a drive letter Windows maps now (a link onto that letter is the user's own mapping). Asks only QueryDosDeviceW, so
 * nothing touches a share; a realpath on any other share means a link was swapped after the walk. Always true off win32.
 */
export function realpathOnOwnShare(base: string, realBase: string, real: string): boolean {
  if (process.platform !== 'win32') return true;
  const resolved = path.resolve(real);
  if (!UNC_OR_DEVICE.test(resolved)) return true;
  const key = shareKey(resolved);
  if (key === undefined) return false;
  const answers = walkAnswers();
  answers.realpaths.set(exact(base), { ok: true, value: realBase });
  return runBlocking(ownOrMappedShare(base, answers, key));
}

function* ownOrMappedShare(base: string, answers: WalkAnswers, key: string): Step<boolean> {
  if ((yield* sharesOfBases([base], answers)).has(key)) return true;
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if ((yield* mappedShareOf(`${letter}:\\`)) === key) return true;
  }
  return false;
}

function* realpathOf(walk: Walk, folder: string): Step<string> {
  if (walk.startIsReal && exact(folder) === exact(walk.start)) return folder;
  return yield* cachedRealpath(walk.seen, folder);
}

function* cachedRealpath(answers: WalkAnswers, folder: string): Step<string> {
  const key = exact(folder);
  let real = answers.realpaths.get(key);
  if (real === undefined) {
    real = yield* settled(ask<string>({ op: 'realpath', file: folder }));
    answers.realpaths.set(key, real);
  }
  return unwrap(real);
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

/**
 * The hosts of folders' network spellings (`networkPathHost`), as written and as their realpath names them (a mapped drive's
 * share), and of `asWritten`'s spellings without a realpath. A realpath that fails leaves out only that spelling's host, which
 * makes more paths ask, never fewer.
 */
export async function networkHostsOf(folders: readonly string[], asWritten: readonly string[] = []): Promise<ReadonlySet<string>> {
  const spellings = await Promise.all(folders.map(async (folder) => [folder, await fs.realpath(folder).catch(() => folder)]));
  return new Set([...spellings.flat(), ...asWritten].map(networkPathHost).filter((host): host is string => host !== undefined && host !== ''));
}

/** What a path may reach past this computer's drives: the hosts it names, and whether some reach names none. */
export interface Reach {
  readonly hosts: string[];
  readonly unplaced: boolean;
}

/**
 * What opening target, an absolute path, may reach past this computer's drives on win32: null when it stays on them, else the
 * hosts it names and whether some reach names none (`unplaced`). Its spelling leaves them (`leavesLocalDrives`), naming its
 * own host; a drive letter it starts with, or one a link on its walk leads onto, is mapped by Windows (QueryDosDeviceW, asked
 * before anything on the drive is touched) onto a share or a subst target that reaches; or a link or junction on its walk
 * leads onto a share or device path off allowedHosts, naming the link target's host; a device path names none. Hosts come only
 * from spellings and drive mappings, never from reading a remote path. A missing segment ends the walk, since nothing past it
 * is followed; rejects as `followsLocalLinksOnly` does otherwise, and when Windows cannot be asked about a drive. Always null
 * off win32.
 */
export async function networkReach(target: string, allowedHosts: ReadonlySet<string>): Promise<Reach | null> {
  if (process.platform !== 'win32') return null;
  return reachOf(target, allowedHosts, 0);
}

// networkReach of target, reached through driveHops drive mappings.
async function reachOf(target: string, allowedHosts: ReadonlySet<string>, driveHops: number): Promise<Reach | null> {
  if (leavesLocalDrives(target, allowedHosts)) {
    const host = networkPathHost(target);
    return host ? { hosts: [host], unplaced: false } : { hosts: [], unplaced: true };
  }
  const root = rootOf(target);
  const drive = /^[a-z]:\\$/i.test(root) ? await driveReach(root, allowedHosts, driveHops) : null;
  if (drive !== null) return drive;
  try {
    const off = await runAsync(hostsOffLocalLinks(root, segmentsUnder(root, target), { allowedHosts, driveHops, probesDrives: true }));
    return off === null ? null : { hosts: [...off.hosts], unplaced: off.unplaced };
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}
