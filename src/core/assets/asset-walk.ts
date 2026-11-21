import { promises as fs, type Dirent, type Stats } from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';
import picomatch from 'picomatch';
import { stripBom } from '../config/bom';
import { readFileBytes } from '../file-bytes';
import { followsLocalLinksOnly } from '../local-links';
import { folderKey } from '../workspace-folders/folder-key';
import { isInsideRealRoot } from '../workspace-folders/real-root';

export const MAX_ASSET_BYTES: number = 1024 * 1024;
const MAX_ROOT_ENTRIES = 5000;

/**
 * How a walk treats a link (docs/invariants.md "Asset discovery and links"). follow: user roots and trusted projects.
 * insideProject: an untrusted project, whose realpath `project` is; a link whose realpath leaves it is withheld unopened.
 */
export type FollowPolicy = { readonly kind: 'follow' } | { readonly kind: 'insideProject'; readonly project: string };

export type WithheldReason = 'linkOutside' | 'share' | 'loop' | 'unreachable' | 'tooLarge' | { readonly broken: string };

// why a link is not followed; the reasons a folder, never read itself, can have
export type LinkWithheld = Exclude<WithheldReason, 'tooLarge'>;

/**
 * files: realpaths in base; a FileWatcherFactory watch of base filtered to them. retry: a verdict no file event changes (a
 * drive that did not answer), so the owner walks again once the drive probe's cached answer expired.
 */
export type WatchTarget = { readonly base: string; readonly glob: string } | { readonly base: string; readonly files: readonly string[] } | { readonly retry: true };

// path and segments name the entry through its links, segments from the walk's root
export type AssetEntry =
  | { readonly kind: 'file'; readonly path: string; readonly realPath: string; readonly segments: readonly string[]; readonly text: string }
  | { readonly kind: 'withheld'; readonly reason: WithheldReason; readonly path: string; readonly segments: readonly string[] };

export interface AssetWalkOptions {
  // the home or project folder the policy and the network check judge links from; holds root
  readonly scopeRoot: string;
  readonly root: string;
  readonly policy: FollowPolicy;
  // folder levels below root the walk enters
  readonly maxDepth: number;
  // basename glob of the files read in each folder below root
  readonly dirGlob: string;
  // basename glob of the files read in root itself; dirGlob when absent
  readonly rootGlob?: string;
  // a folder holding a regular file of this name has that file read and nothing else in it, as pi's skill walk stops at SKILL.md
  readonly leafFile?: string;
  // a folder whose realpath the walk entered elsewhere, not above it: walked again, or skipped unlogged
  readonly repeatFolders: 'walk' | 'skip';
  // ignore files whose patterns, read in each folder entered, hide entries below it, as pi's skill walk reads them
  readonly ignoreFiles?: readonly string[];
  // skips dot entries and node_modules
  readonly skipHidden: boolean;
  readonly log: (line: string) => void;
}

export interface AssetWalk {
  readonly entries: AssetEntry[];
  // what to watch so a change behind a followed or broken link rescans
  readonly followed: WatchTarget[];
  // the policy admitted root and it is a folder
  readonly rootAdmitted: boolean;
  // why root itself is withheld; absent when root was admitted or is simply absent
  readonly rootWithheld?: LinkWithheld;
}

// What judging and reading one entry needs, and what it records.
interface Judge {
  readonly scopeRoot: string;
  readonly policy: FollowPolicy;
  readonly log: (line: string) => void;
  readonly entries: AssetEntry[];
  readonly followed: WatchTarget[];
  retry: boolean;
}

interface Walk extends Judge {
  readonly options: AssetWalkOptions;
  readonly rootSegments: readonly string[];
  readonly readsAtRoot: (name: string) => boolean;
  readonly readsBelow: (name: string) => boolean;
  // the ignoreFiles patterns read so far, matched against paths below root
  readonly ignored: ReturnType<typeof ignore> | undefined;
  // folderKey(realpath) of every folder entered
  readonly entered: Set<string>;
  // folder links met so far, entered only after every folder reached before them, so a real folder keeps its real path
  readonly links: PendingFolder[];
  count: number;
  stoppedAtCount: boolean;
  stoppedAtDepth: boolean;
}

interface PendingFolder {
  readonly dir: string;
  readonly realDir: string;
  readonly segments: readonly string[];
  readonly depth: number;
  // folderKey of the realpath of every folder from root down to the one holding this folder
  readonly above: readonly string[];
  readonly linked: boolean;
}

type LinkVerdict = { readonly kind: 'withheld'; readonly reason: LinkWithheld } | { readonly kind: 'skip' } | { readonly kind: 'admitted'; readonly real: string };

function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorText(err: unknown): string {
  return errnoCode(err) ?? (err instanceof Error ? err.message : String(err));
}

const isMissing = (err: unknown): boolean => errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR';

function reasonText(reason: WithheldReason): string {
  return typeof reason === 'string' ? reason : `broken link to ${reason.broken}`;
}

// path's segments below scopeRoot; throws for a path outside it, which no link check could judge
function segmentsBelow(scopeRoot: string, file: string): string[] {
  const relative = path.relative(scopeRoot, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${file} is not under ${scopeRoot}`);
  return relative.split(path.sep).filter(Boolean);
}

function isBelow(scopeRoot: string, file: string): boolean {
  const relative = path.relative(scopeRoot, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Paths as segment lists in name order: code unit order within a folder, so it is the same on every file system. */
export function compareInNameOrder(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]! ? -1 : 1;
  }
  return a.length - b.length;
}

// One retry target however many verdicts a walk found transient.
function followedOf(judge: Judge): WatchTarget[] {
  return judge.retry ? [...judge.followed, { retry: true }] : judge.followed;
}

/** The asset files under root, and the entries withheld from it, judged link by link from scopeRoot down. */
export async function walkAssetTree(options: AssetWalkOptions): Promise<AssetWalk> {
  const walk: Walk = {
    options,
    scopeRoot: options.scopeRoot,
    policy: options.policy,
    log: options.log,
    rootSegments: segmentsBelow(options.scopeRoot, options.root),
    // case-sensitive on every OS, as pi's loaders compare names
    readsAtRoot: picomatch(options.rootGlob ?? options.dirGlob, { dot: true }),
    readsBelow: picomatch(options.dirGlob, { dot: true }),
    ignored: options.ignoreFiles === undefined ? undefined : ignore(),
    entries: [],
    followed: [],
    retry: false,
    entered: new Set(),
    links: [],
    count: 0,
    stoppedAtCount: false,
    stoppedAtDepth: false,
  };
  const root = await admitRoot(walk);
  if (root.kind !== 'admitted') {
    return { entries: walk.entries, followed: followedOf(walk), rootAdmitted: false, ...(root.kind === 'withheld' ? { rootWithheld: root.reason } : {}) };
  }
  await enterFolder(walk, { dir: options.root, realDir: root.real, segments: [], depth: 0, above: [], linked: await crossesLink(options.scopeRoot, walk.rootSegments) });
  for (let next = walk.links.shift(); next !== undefined && !walk.stoppedAtCount; next = walk.links.shift()) await enterFolder(walk, next);
  return { entries: walk.entries, followed: followedOf(walk), rootAdmitted: true };
}

// The glob a followed folder at depth is watched with: the files the walk reads there and below, ignore files included.
function folderGlob(walk: Walk, depth: number, leaf: boolean): string {
  const { maxDepth, dirGlob, rootGlob = dirGlob, leafFile, ignoreFiles = [] } = walk.options;
  const below = leaf || depth >= maxDepth ? [] : [dirGlob, ...ignoreFiles];
  // a name the walk reads below also matches here through `**/`
  const here = [leaf ? leafFile! : depth === 0 ? rootGlob : dirGlob, ...ignoreFiles].filter((glob) => !below.includes(glob));
  const globs = [...here, ...below.map((glob) => `**/${glob}`)];
  return globs.length === 1 ? globs[0]! : `{${globs.join(',')}}`;
}

// Whether the walk reads a file named name in a folder at depth.
function reads(walk: Walk, name: string, depth: number): boolean {
  return name === walk.options.leafFile || (depth === 0 ? walk.readsAtRoot(name) : walk.readsBelow(name));
}

// The root's verdict, admitted only when it is a folder; an absent root, no link naming it, is no error.
// A realpath that differs from the spelling is no proof of a link: Windows also expands 8.3 names there.
async function crossesLink(scopeRoot: string, segments: readonly string[]): Promise<boolean> {
  for (let depth = 1; depth <= segments.length; depth++) {
    if ((await fs.lstat(path.join(scopeRoot, ...segments.slice(0, depth)))).isSymbolicLink()) return true;
  }
  return false;
}

async function admitRoot(walk: Walk): Promise<LinkVerdict> {
  const { root, log } = walk.options;
  const verdict = await judgeLink(walk, root, walk.rootSegments);
  if (verdict.kind === 'withheld') log(`[assets] ${root}: ${reasonText(verdict.reason)}`);
  if (verdict.kind !== 'admitted') return verdict;
  let stats: Stats;
  try {
    stats = await fs.stat(root);
  } catch (err) {
    log(`[assets] ${root}: ${errorText(err)}`);
    return { kind: 'skip' };
  }
  if (stats.isDirectory()) return verdict;
  log(`[assets] ${root}: not a folder`);
  return { kind: 'skip' };
}

// A link back to a folder above it is a loop; one to a folder entered elsewhere is a repeat, walked or skipped as asked.
async function enterFolder(walk: Walk, folder: PendingFolder): Promise<void> {
  const key = folderKey(folder.realDir);
  if (folder.above.includes(key)) {
    withhold(walk, folder.dir, folder.segments, 'loop');
    return;
  }
  if (walk.options.repeatFolders === 'skip' && walk.entered.has(key)) return;
  walk.entered.add(key);
  const leaf = await listFolder(walk, folder, [...folder.above, key]);
  if (folder.linked) walk.followed.push({ base: folder.realDir, glob: folderGlob(walk, folder.depth, leaf) });
}

// Whether the folder is a leaf: it holds leafFile as a regular file, which is all of it the walk reads.
async function listFolder(walk: Walk, folder: PendingFolder, ancestors: readonly string[]): Promise<boolean> {
  const { log, skipHidden, leafFile } = walk.options;
  let dirents: Dirent[];
  try {
    // the folder the policy judged, not the path through links, which could be swapped since
    dirents = await fs.readdir(folder.realDir, { withFileTypes: true });
  } catch (err) {
    log(`[assets] ${folder.dir}: ${errorText(err)}`);
    return false;
  }
  await addIgnoreRules(walk, folder, dirents);
  const leaf = leafFile === undefined ? undefined : dirents.find((dirent) => dirent.name === leafFile);
  if (leaf !== undefined && (await visitEntry(walk, folder, ancestors, leaf)) === 'file') return true;
  const ordered = dirents
    .filter((dirent) => dirent !== leaf && !(skipHidden && (dirent.name.startsWith('.') || dirent.name === 'node_modules')))
    .sort((a, b) => compareInNameOrder([a.name], [b.name]));
  for (const dirent of ordered) {
    if (walk.stoppedAtCount) break;
    await visitEntry(walk, folder, ancestors, dirent);
  }
  return false;
}

// 'file' when the entry is, or links to, a regular file the walk reads.
async function visitEntry(walk: Walk, folder: PendingFolder, ancestors: readonly string[], dirent: Dirent): Promise<'file' | undefined> {
  if (++walk.count > MAX_ROOT_ENTRIES) {
    if (!walk.stoppedAtCount) walk.log(`[assets] ${walk.options.root}: stopped after ${MAX_ROOT_ENTRIES} entries`);
    walk.stoppedAtCount = true;
    return undefined;
  }
  const entryPath = path.join(folder.dir, dirent.name);
  const realPath = path.join(folder.realDir, dirent.name);
  const segments = [...folder.segments, dirent.name];
  if (dirent.isSymbolicLink()) return visitLink(walk, folder, ancestors, entryPath, segments);
  if (dirent.isDirectory()) {
    if (isIgnored(walk, segments, true)) return undefined;
    if (folder.depth < walk.options.maxDepth) await enterFolder(walk, { dir: entryPath, realDir: realPath, segments, depth: folder.depth + 1, above: ancestors, linked: false });
    else stopAtDepth(walk, entryPath);
    return undefined;
  }
  if (!reads(walk, dirent.name, folder.depth) || isIgnored(walk, segments, false)) return undefined;
  if (!dirent.isFile()) {
    walk.log(`[assets] ${entryPath}: not a regular file`);
    return undefined;
  }
  await readEntry(walk, entryPath, realPath, segments);
  return 'file';
}

// A walk that reads only its root says nothing of the folders in it.
function stopAtDepth(walk: Walk, dir: string): void {
  const { maxDepth } = walk.options;
  if (maxDepth > 0 && !walk.stoppedAtDepth) walk.log(`[assets] ${dir}: below the ${maxDepth}-level limit, not read`);
  walk.stoppedAtDepth = true;
}

function isIgnored(walk: Walk, segments: readonly string[], folder: boolean): boolean {
  return walk.ignored !== undefined && walk.ignored.ignores(folder ? `${segments.join('/')}/` : segments.join('/'));
}

// Each ignore file of the folder, its patterns scoped to the folder, as pi's addIgnoreRules reads them (pi dist/core/skills.js).
async function addIgnoreRules(walk: Walk, folder: PendingFolder, dirents: readonly Dirent[]): Promise<void> {
  const { ignored } = walk;
  if (ignored === undefined) return;
  const prefix = folder.segments.length === 0 ? '' : `${folder.segments.join('/')}/`;
  for (const name of walk.options.ignoreFiles ?? []) {
    const dirent = dirents.find((entry) => entry.name === name);
    if (dirent === undefined) continue;
    const text = await readIgnoreFile(walk, folder, dirent);
    if (text !== undefined) ignored.add(text.split(/\r?\n/).flatMap((line) => scopedPattern(line, prefix) ?? []));
  }
}

async function readIgnoreFile(walk: Walk, folder: PendingFolder, dirent: Dirent): Promise<string | undefined> {
  const file = path.join(folder.dir, dirent.name);
  let realPath = path.join(folder.realDir, dirent.name);
  if (dirent.isSymbolicLink()) {
    const verdict = await judgeLink(walk, file, [...walk.rootSegments, ...folder.segments, dirent.name], folder.realDir);
    if (verdict.kind === 'withheld') walk.log(`[assets] ${file}: ${reasonText(verdict.reason)}`);
    if (verdict.kind !== 'admitted') return undefined;
    realPath = verdict.real;
  } else if (!dirent.isFile()) {
    return undefined;
  }
  const read = await readFileBytes(file, MAX_ASSET_BYTES);
  if (read.kind === 'bytes') {
    if (walk.policy.kind === 'insideProject' && !(await isJudgedFile(walk, realPath, read))) return undefined;
    return stripBom(read.bytes.toString('utf8'));
  }
  walk.log(`[assets] ${file}: ${read.kind === 'unreadable' ? read.code ?? read.error : read.kind}`);
  return undefined;
}

// One line of an ignore file in the folder prefix names, as pi's prefixIgnorePattern scopes it; undefined for a blank or comment line.
function scopedPattern(line: string, prefix: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || (trimmed.startsWith('#') && !trimmed.startsWith('\\#'))) return undefined;
  let pattern = line;
  const negated = pattern.startsWith('!');
  if (negated || pattern.startsWith('\\!')) pattern = pattern.slice(1);
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  return negated ? `!${prefix}${pattern}` : `${prefix}${pattern}`;
}

async function visitLink(walk: Walk, folder: PendingFolder, ancestors: readonly string[], link: string, segments: readonly string[]): Promise<'file' | undefined> {
  const fileCandidate = reads(walk, segments[segments.length - 1]!, folder.depth);
  const folderCandidate = folder.depth < walk.options.maxDepth;
  // A link the walk would neither read nor enter is never looked through.
  if (!fileCandidate && !folderCandidate) return undefined;
  const verdict = await judgeLink(walk, link, [...walk.rootSegments, ...segments], folder.realDir);
  if (verdict.kind === 'skip') return undefined;
  // a link the walk cannot look through has no known kind, so an ignore pattern naming it either way hides it
  const hidden = (): boolean => isIgnored(walk, segments, false) || isIgnored(walk, segments, true);
  if (verdict.kind === 'withheld') {
    if (!hidden()) withhold(walk, link, segments, verdict.reason);
    return undefined;
  }
  let stats: Stats;
  try {
    stats = await fs.stat(link);
  } catch (err) {
    if (!hidden()) await withholdFailedStat(walk, link, folder.realDir, segments, err);
    return undefined;
  }
  if (stats.isDirectory()) {
    if (folderCandidate && !isIgnored(walk, segments, true)) walk.links.push({ dir: link, realDir: verdict.real, segments, depth: folder.depth + 1, above: ancestors, linked: true });
    return undefined;
  }
  if (!fileCandidate || isIgnored(walk, segments, false)) return undefined;
  if (!stats.isFile()) {
    walk.log(`[assets] ${link}: not a regular file`);
    return undefined;
  }
  walk.followed.push({ base: path.dirname(verdict.real), files: [verdict.real] });
  await readEntry(walk, link, verdict.real, segments);
  return 'file';
}

export interface AssetPathOptions {
  readonly scopeRoot: string;
  readonly root: string;
  // below root
  readonly segments: readonly string[];
  readonly policy: FollowPolicy;
  readonly log: (line: string) => void;
}

/** The one file at root/segments, judged and read as a walk reads it, found by the file system's own name rules (case included). */
export async function readAssetPath(options: AssetPathOptions): Promise<AssetEntry | undefined> {
  const judge: Judge = { scopeRoot: options.scopeRoot, policy: options.policy, log: options.log, entries: [], followed: [], retry: false };
  const file = path.join(options.root, ...options.segments);
  const verdict = await judgeLink(judge, file, segmentsBelow(options.scopeRoot, file));
  if (verdict.kind === 'withheld') withhold(judge, file, options.segments, verdict.reason);
  if (verdict.kind === 'admitted') await readEntry(judge, file, verdict.real, options.segments);
  return judge.entries[0];
}

/**
 * The policy's verdict on following file, whose path below scopeRoot is segments: the network check first, so no
 * share or device target is ever touched; then, in an untrusted project, the link's realpath must stay inside it.
 */
async function judgeLink(judge: Judge, file: string, segments: readonly string[], realDir?: string): Promise<LinkVerdict> {
  const { scopeRoot, policy } = judge;
  try {
    if (!(await followsLocalLinksOnly(scopeRoot, segments))) return { kind: 'withheld', reason: 'share' };
  } catch (err) {
    return failedLink(judge, file, err, realDir);
  }
  let real: string;
  try {
    real = await fs.realpath(file);
  } catch (err) {
    return failedLink(judge, file, err, realDir);
  }
  if (policy.kind === 'insideProject' && !isInsideRealRoot(policy.project, real)) return { kind: 'withheld', reason: 'linkOutside' };
  return { kind: 'admitted', real };
}

async function failedLink(judge: Judge, file: string, err: unknown, realDir: string | undefined): Promise<LinkVerdict> {
  const code = errnoCode(err);
  if (code === 'ETIMEDOUT') {
    judge.retry = true;
    return { kind: 'withheld', reason: 'unreachable' };
  }
  if (code === 'ELOOP') return { kind: 'withheld', reason: 'loop' };
  if (isMissing(err)) return missingTarget(judge, file, realDir);
  judge.log(`[assets] ${file}: ${errorText(err)}`);
  return { kind: 'skip' };
}

async function withholdFailedStat(judge: Judge, link: string, realDir: string, segments: readonly string[], err: unknown): Promise<void> {
  const verdict = await failedLink(judge, link, err, realDir);
  if (verdict.kind === 'withheld') withhold(judge, link, segments, verdict.reason);
}

/**
 * A file whose realpath is missing, after the network check found no link leading off: a broken link, watched in the folder
 * holding it and, where the policy lets the walk look, in the folder its target would be in, so a restored target rescans;
 * else an absent entry, skipped. realDir: the folder holding file, as a realpath, when the walk already knows it; without
 * it a missing folder on the way below scopeRoot is looked at the same way, so a broken `~/.claude` withholds its roots.
 */
async function missingTarget(judge: Judge, file: string, realDir: string | undefined): Promise<LinkVerdict> {
  const { policy, log, scopeRoot } = judge;
  let holder = realDir;
  if (holder === undefined) {
    const parent = path.dirname(file);
    try {
      holder = await fs.realpath(parent);
    } catch (err) {
      if (isMissing(err)) return isBelow(scopeRoot, parent) ? missingTarget(judge, parent, undefined) : { kind: 'skip' };
      log(`[assets] ${parent}: ${errorText(err)}`);
      return { kind: 'skip' };
    }
  }
  if (policy.kind === 'insideProject' && !isInsideRealRoot(policy.project, holder)) return { kind: 'withheld', reason: 'linkOutside' };
  const entry = path.join(holder, path.basename(file));
  let text: string;
  try {
    text = await fs.readlink(entry);
  } catch (err) {
    // EINVAL: the entry is not a link
    if (!isMissing(err) && errnoCode(err) !== 'EINVAL') log(`[assets] ${file}: ${errorText(err)}`);
    return { kind: 'skip' };
  }
  judge.followed.push({ base: holder, files: [entry] });
  const target = path.resolve(holder, text);
  const targetDir = await targetFolder(judge, path.dirname(target));
  if (targetDir !== undefined) judge.followed.push({ base: targetDir, files: [path.join(targetDir, path.basename(target))] });
  return { kind: 'withheld', reason: { broken: text } };
}

// The folder a broken link's target would be in, to watch; in an untrusted project only its realpath inside the project, as a watcher follows links in its base.
async function targetFolder(judge: Judge, dir: string): Promise<string | undefined> {
  const { policy, log } = judge;
  if (policy.kind === 'follow') return dir;
  let real: string;
  try {
    real = await fs.realpath(dir);
  } catch (err) {
    if (!isMissing(err)) log(`[assets] ${dir}: ${errorText(err)}`);
    return undefined;
  }
  return isInsideRealRoot(policy.project, real) ? real : undefined;
}

// Whether the file read is still the one at realPath, which the policy judged; a swap since is a link the check never saw.
async function isJudgedFile(judge: Judge, realPath: string, read: { readonly dev: number; readonly ino: number }): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await fs.lstat(realPath);
  } catch (err) {
    judge.log(`[assets] ${realPath}: ${errorText(err)}`);
    return false;
  }
  if (stats.dev === read.dev && stats.ino === read.ino) return true;
  judge.log(`[assets] ${realPath}: changed while read`);
  return false;
}

function withhold(judge: Judge, file: string, segments: readonly string[], reason: WithheldReason): void {
  judge.log(`[assets] ${file}: ${reasonText(reason)}`);
  judge.entries.push({ kind: 'withheld', reason, path: file, segments });
}

async function readEntry(judge: Judge, file: string, realPath: string, segments: readonly string[]): Promise<void> {
  const read = await readFileBytes(file, MAX_ASSET_BYTES);
  switch (read.kind) {
    case 'bytes':
      if (judge.policy.kind === 'insideProject' && !(await isJudgedFile(judge, realPath, read))) return;
      judge.entries.push({ kind: 'file', path: file, realPath, segments, text: stripBom(read.bytes.toString('utf8')) });
      return;
    case 'tooLarge':
      withhold(judge, file, segments, 'tooLarge');
      return;
    case 'notAFile':
      judge.log(`[assets] ${file}: not a regular file`);
      return;
    case 'missing':
      judge.log(`[assets] ${file}: removed while read`);
      return;
    case 'unreadable':
      judge.log(`[assets] ${file}: ${read.code ?? read.error}`);
      return;
  }
}
