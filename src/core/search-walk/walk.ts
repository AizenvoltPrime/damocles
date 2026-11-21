import { promises as fs, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { WalkIgnore } from '../../shared/walk-ignore';
import { exact, followsLocalLinksOnly, networkHostsOf, networkReach, type Reach } from '../local-links';
import { isInsideRealRoot } from '../workspace-folders/real-root';
import { candidateOf, ignoreFileRules, textLines, matchOverrides, matchRules, NO_RULES, pathBytes, type IgnoreMatch, type IgnoreRules } from './rg-ignore';

/**
 * rg 15's walk with `--hidden`, and `--follow` only under followLinks (docs/invariants.md "Tool overrides"). Every entry's type
 * comes from its folder's listing: without followLinks a link is never listed, entered, stat'd or opened, and only a regular file
 * is listed. Ignore files are read as rg reads them, unless they are links.
 */

export type { WalkIgnore };

/** A `.git` file's pointer that leads off this computer (`networkReach`), as the file spells it. */
export interface PointerReach {
  readonly written: string;
  readonly reach: Reach;
}

interface FolderRules {
  readonly custom: IgnoreRules;
  readonly ignore: IgnoreRules;
  readonly git: IgnoreRules;
  readonly exclude: IgnoreRules;
  readonly hasGit: boolean;
  // no rule in any of the four
  readonly empty: boolean;
}

// One folder's rules as an entry below another reads them: the entry's path below the root made relative to the rules' folder.
interface RuleSource {
  readonly rules: FolderRules;
  // the bytes of `<rel>/` of the rules' folder, dropped from the path; 0 at the root
  readonly strip: number;
  // `<below>/` of a folder above the root, put before the path
  readonly prefix: string;
  // git's rules apply: inside a repository, and no nearer folder marks one
  readonly git: boolean;
}

interface Folder {
  // posix path below the walk's root, '' for the root
  readonly rel: string;
  readonly anyGit: boolean;
  // the rules each entry of the folder reads, nearest folder first, sets with no rule left out
  readonly sources: readonly RuleSource[];
}

function topFolder(rules: FolderRules, ancestors: readonly Ancestor[], requireGit: boolean): Folder {
  const anyGit = !requireGit || rules.hasGit || ancestors.some((ancestor) => ancestor.rules.hasGit);
  const levels = [{ rules, strip: 0, prefix: '' }, ...ancestors.map((ancestor) => ({ rules: ancestor.rules, strip: 0, prefix: pathBytes(`${ancestor.below}/`) }))];
  const sources: RuleSource[] = [];
  let sawGit = false;
  for (const level of levels) {
    if (!level.rules.empty) sources.push({ ...level, git: anyGit && !sawGit });
    sawGit ||= level.rules.hasGit;
  }
  return { rel: '', anyGit, sources };
}

function childFolder(parent: Folder, rel: string, rules: FolderRules): Folder {
  const anyGit = parent.anyGit || rules.hasGit;
  if (rules.empty && !rules.hasGit) return { rel, anyGit, sources: parent.sources };
  const above = rules.hasGit ? parent.sources.map((source) => (source.git ? { ...source, git: false } : source)) : parent.sources;
  const own: RuleSource[] = rules.empty ? [] : [{ rules, strip: pathBytes(rel).length + 1, prefix: '', git: anyGit }];
  return { rel, anyGit, sources: [...own, ...above] };
}

// A folder above the root (rg's "absolute parents"), with the root's canonical path below it.
interface Ancestor {
  readonly rules: FolderRules;
  readonly below: string;
}

/** rg's defaults, every ignore file read. */
export const ALL_IGNORE_FILES: WalkIgnore = { files: true, global: true, parents: true };

/** Files whose modified time a walk returns: those ending in `extension` under a `folder` segment or with `word` as a word of the name. */
export interface TimedFiles {
  readonly extension: string;
  readonly folder: string;
  readonly word: string;
}

/** Whether rel, '/'-separated, is a file timed names, compared case-blind; a name's words split at non-letters and at camelCase humps. */
export function isTimedFile(timed: TimedFiles, rel: string): boolean {
  const segments = rel.split('/');
  const name = segments.pop() ?? '';
  const extension = timed.extension.toLowerCase();
  if (!name.toLowerCase().endsWith(extension)) return false;
  if (segments.some((segment) => segment.toLowerCase() === timed.folder.toLowerCase())) return true;
  const words = name.slice(0, -extension.length).split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/);
  return words.some((word) => word.toLowerCase() === timed.word.toLowerCase());
}

export interface WalkOptions {
  readonly root: string;
  // git's ignore rules apply only inside a repository (rg's default); false applies them everywhere, as `--no-require-git` does
  readonly requireGit: boolean;
  readonly ignore: WalkIgnore;
  // 'list' walks a `.git` folder as any other, as rg does; its info/exclude applies under both
  readonly gitFolders: 'skip' | 'list';
  readonly overrides: IgnoreRules & { readonly includes: boolean };
  readonly allowedHosts: () => Promise<ReadonlySet<string>>;
  readonly signal: AbortSignal | undefined;
  // follows a link whose every reading stays off other UNC, WSL and device roots (followsLocalLinksOnly of its path from root,
  // which its stat and realpath then name, as ripgrep later opens it), lists a file by that path, and enters a folder through a
  // link at most once per realpath, and none it entered already; a link re-pointed after its check is followed
  readonly followLinks?: true;
  // the files whose modified time Walk.modified returns, each stat'ed once
  readonly timed?: TimedFiles;
  // under followLinks, folders whose realpath (the walk's) holds no file the walk lists through a link
  readonly skipRealUnder?: readonly string[];
}

export interface Walk {
  // each folder's listed files, one batch per folder, empty when it lists none: paths below the root, with the platform's separators
  readonly files: AsyncGenerator<readonly string[], void, undefined>;
  // a folder, or a timed file, below the root that could not be read, as rg reports one: the walk goes on
  readonly errors: string[];
  // under WalkOptions.timed, each such listed file's modified time in ms by its listed path, set before its folder's batch
  readonly modified: Map<string, number>;
  // folders read ahead whose reads have not settled; a walk left early or ended by a failure leaves them running
  readonly readsAhead: () => number;
  // settles once every folder read ahead so far has been read
  readonly readsSettled: () => Promise<void>;
}

// Folders read ahead of the one being listed; libuv's pool runs four file system calls at once.
const READ_AHEAD = 8;
// Links of one folder checked at once under followLinks.
const LINK_CHECKS = 8;

function aborted(): Error {
  return new Error('Operation aborted');
}

const errnoCode = (err: unknown): string | undefined => (err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined);

// rg reads an ignore file it cannot read as empty (the ignore crate reports it and goes on).
async function readBytes(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (err) {
    if (errnoCode(err) === undefined) throw err;
    return undefined;
  }
}

const rulesOf = async (file: string): Promise<IgnoreRules> => {
  const bytes = await readBytes(file);
  return bytes === undefined ? NO_RULES : ignoreFileRules(bytes);
};

// The entry name holds in folder, read from the folder's listing; undefined when it holds none or cannot be listed.
async function listedEntry(folder: string, name: string): Promise<Dirent | undefined> {
  try {
    return (await fs.readdir(folder, { withFileTypes: true })).find((entry) => entry.name === name);
  } catch (err) {
    if (errnoCode(err) === undefined) throw err;
    return undefined;
  }
}

const firstLine = (bytes: Buffer | undefined): string | undefined => (bytes === undefined ? undefined : textLines(bytes)[0]);

/**
 * The info/exclude file a `.git` file's `gitdir:` pointer leads to, as the ignore crate's `resolve_git_commondir` finds it: the
 * pointer and the `commondir` it holds resolve against cwd (rg's working folder, the search root) unless absolute, a commondir
 * starting with `.` against the pointer's folder. Each place is put through `networkReach` before anything there is read, and one
 * that leads off this computer is never followed: `reach` names it and `exclude` is undefined.
 */
export async function gitFileExclude(gitFile: string, cwd: string, allowedHosts: () => Promise<ReadonlySet<string>>): Promise<{ exclude?: string; reach?: PointerReach }> {
  const pointer = firstLine(await readBytes(gitFile));
  if (pointer === undefined || !pointer.startsWith('gitdir: ')) return {};
  const written = pointer.slice('gitdir: '.length);
  const gitDir = path.resolve(cwd, written);
  const commonFile = path.join(gitDir, 'commondir');
  const pointerReach = await networkReach(commonFile, await allowedHosts());
  if (pointerReach !== null) return { reach: { written, reach: pointerReach } };
  const line = firstLine(await readBytes(commonFile));
  if (line === undefined) return {};
  const exclude = path.join(line.startsWith('.') ? path.join(gitDir, line) : path.resolve(cwd, line), 'info', 'exclude');
  const excludeReach = await networkReach(exclude, await allowedHosts());
  return excludeReach === null ? { exclude } : { reach: { written: line, reach: excludeReach } };
}

/**
 * The ignore rules of one folder from its listing, as the ignore crate's `add_child_path` reads them: `.rgignore`, `.ignore` and
 * `.gitignore` when they are regular files, and the info/exclude of its `.git`: under a `.git` folder, or a `.git` file's pointer
 * (`gitFileExclude`); a `.git` that is a link marks a repository and is never read through.
 */
async function folderRules(folder: string, entries: readonly Dirent[], options: WalkOptions, cwd: string, absoluteParent: boolean): Promise<FolderRules> {
  if (!options.ignore.files) return NO_FOLDER_RULES;
  const named = new Map(entries.filter((entry) => ['.rgignore', '.ignore', '.gitignore', '.git', '.jj'].includes(entry.name)).map((entry) => [entry.name, entry]));
  const fileRules = (name: string): Promise<IgnoreRules> => (named.get(name)?.isFile() ? rulesOf(path.join(folder, name)) : Promise.resolve(NO_RULES));
  const git = named.get('.git');
  const exclude = async (): Promise<IgnoreRules> => {
    if (git?.isDirectory()) {
      const info = await listedEntry(path.join(folder, '.git'), 'info');
      if (!info?.isDirectory()) return NO_RULES;
      const file = await listedEntry(path.join(folder, '.git', 'info'), 'exclude');
      return file?.isFile() ? rulesOf(path.join(folder, '.git', 'info', 'exclude')) : NO_RULES;
    }
    // rg reads a .git file's pointer only while git's rules need a repository
    if (!git?.isFile() || !options.requireGit) return NO_RULES;
    const { exclude: file } = await gitFileExclude(path.join(folder, '.git'), cwd, options.allowedHosts);
    return file === undefined ? NO_RULES : rulesOf(file);
  };
  const [custom, ignore, gitignore, excluded] = await Promise.all([fileRules('.rgignore'), fileRules('.ignore'), fileRules('.gitignore'), exclude()]);
  const empty = [custom, ignore, gitignore, excluded].every((rules) => rules.globs.length === 0);
  return { custom, ignore, git: gitignore, exclude: excluded, hasGit: marksRepository(entries, options, absoluteParent), empty };
}

const NO_FOLDER_RULES: FolderRules = { custom: NO_RULES, ignore: NO_RULES, git: NO_RULES, exclude: NO_RULES, hasGit: false, empty: true };

// an absolute parent counts a .jj only while git's rules need a repository
const marksRepository = (entries: readonly Dirent[], options: WalkOptions, absoluteParent: boolean): boolean =>
  options.requireGit ? entries.some((entry) => entry.name === '.git' || entry.name === '.jj') : !absoluteParent && entries.some((entry) => entry.name === '.jj');

/** The folders above root's canonical path, nearest first, as rg's `add_parents` reads them. */
async function ancestorsOf(canonicalRoot: string, options: WalkOptions, cwd: string): Promise<Ancestor[]> {
  const folders: Array<{ folder: string; below: string }> = [];
  for (let current = canonicalRoot, parent = path.dirname(current); parent !== current; current = parent, parent = path.dirname(current)) {
    folders.push({ folder: parent, below: path.relative(parent, canonicalRoot).split(path.sep).join('/') });
  }
  return Promise.all(folders.map(async ({ folder, below }) => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch (err) {
      // a folder above the root that cannot be listed contributes no rules (rg would open its ignore files by name)
      if (errnoCode(err) !== 'EACCES' && errnoCode(err) !== 'EPERM') throw err;
      entries = [];
    }
    const rules = options.ignore.parents ? await folderRules(folder, entries, options, cwd, true) : { ...NO_FOLDER_RULES, hasGit: marksRepository(entries, options, true) };
    return { rules, below };
  }));
}

/** git's global excludes as the ignore crate finds them: `excludesfile` in ~/.gitconfig, then in the XDG git config, else XDG's git/ignore. */
async function globalExcludes(): Promise<IgnoreRules> {
  const home = homedir();
  const xdg = process.env['XDG_CONFIG_HOME'] || path.join(home, '.config');
  // the ignore crate's regex over the raw file: any section, and every `~` replaced by the home folder
  const excludesFile = (config: string | undefined): string | undefined => {
    const found = config === undefined ? null : /^[ \t\v\f\r]*excludesfile[ \t\v\f\r]*=[ \t\v\f\r]*"?[ \t\v\f\r]*(\S+?)[ \t\v\f\r]*"?[ \t\v\f\r]*$/im.exec(config);
    return found ? found[1]!.replaceAll('~', home) : undefined;
  };
  const file = excludesFile((await readBytes(path.join(home, '.gitconfig')))?.toString('utf8')) ?? excludesFile((await readBytes(path.join(xdg, 'git', 'config')))?.toString('utf8')) ?? path.join(xdg, 'git', 'ignore');
  return rulesOf(file);
}

/** rg's `Ignore::matched` for a path below the root: overrides first, then each source nearest first in rg's precedence. */
function matcher(options: WalkOptions, global: IgnoreRules): (rel: string, isDir: boolean, folder: Folder) => IgnoreMatch {
  return (rel, isDir, folder) => {
    const bytes = pathBytes(rel);
    const candidate = candidateOf(bytes);
    const overridden = matchOverrides(options.overrides, candidate, isDir);
    if (overridden !== undefined) return overridden;
    let custom: IgnoreMatch;
    let ignore: IgnoreMatch;
    let git: IgnoreMatch;
    let exclude: IgnoreMatch;
    for (const source of folder.sources) {
      // the basename and extension are the entry's at every level
      const local = { ...candidate, path: source.prefix + bytes.slice(source.strip) };
      custom ??= matchRules(source.rules.custom, local, isDir);
      // nothing below .rgignore's own answer outranks it
      if (custom !== undefined) break;
      ignore ??= matchRules(source.rules.ignore, local, isDir);
      if (source.git) {
        git ??= matchRules(source.rules.git, local, isDir);
        exclude ??= matchRules(source.rules.exclude, local, isDir);
      }
    }
    return custom ?? ignore ?? git ?? exclude ?? (folder.anyGit ? matchRules(global, candidate, isDir) : undefined);
  };
}

// What a followed link leads to: a regular file with the modified time its stat gave, or a folder by its realpath.
type LinkTarget = { readonly kind: 'file'; readonly modifiedAt: number } | { readonly kind: 'folder'; readonly real: string };

const NO_LINKS: ReadonlyMap<string, LinkTarget> = new Map();

// Promise.all rejects while the rest still run, which no released then waits for: this settles all, then throws the first failure.
async function settleAll<T>(work: ReadonlyArray<Promise<T>>): Promise<T[]> {
  const results = await Promise.allSettled(work);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

// The realpaths of folders, a missing one left out.
async function realpathsOf(folders: readonly string[]): Promise<string[]> {
  const reals = await settleAll(folders.map(async (folder) => {
    try {
      return await fs.realpath(folder);
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw err;
    }
  }));
  return reals.filter((real) => real !== undefined);
}

interface Listing {
  readonly folder: Folder;
  readonly entries: readonly Dirent[];
  // the path the folder was read at: below a followed link, from the link's realpath, so no read follows the link again
  readonly abs: string;
  // under followLinks, the folder's realpath
  readonly real: string | undefined;
  // reached through a followed link
  readonly linked: boolean;
  // under followLinks, the target of each entry that is a link the walk follows, by name
  readonly links: ReadonlyMap<string, LinkTarget>;
}

interface Pending {
  readonly abs: string;
  readonly rel: string;
  readonly parent: Folder;
  readonly real: string | undefined;
  readonly linked: boolean;
  // a read ahead settles to its failure, which the walk throws when it reaches the folder, so an abandoned one rejects nothing
  listing?: Promise<Listing | Error | { readonly failed: unknown }>;
}

/** Walks options.root, a folder, listing the regular files rg 15 would search there, folders read ahead and in listing order. */
export function walkFiles(options: WalkOptions): Walk {
  const errors: string[] = [];
  const modified = new Map<string, number>();
  const ahead = new Set<Promise<unknown>>();
  async function* files(): AsyncGenerator<readonly string[], void, undefined> {
    const { root, signal, ignore, followLinks, timed } = options;
    const [entries, canonicalRoot, global] = await Promise.all([fs.readdir(root, { withFileTypes: true }), fs.realpath(root), ignore.files && ignore.global ? globalExcludes() : NO_RULES]);
    const ancestors = ignore.files ? await ancestorsOf(canonicalRoot, options, root) : [];
    const rootRules = await folderRules(root, entries, options, root, false);
    const top = topFolder(rootRules, ancestors, options.requireGit);
    const matched = matcher(options, global);
    const skipReal = followLinks && options.skipRealUnder !== undefined ? await realpathsOf(options.skipRealUnder) : [];
    const skipped = (real: string): boolean => skipReal.some((folder) => isInsideRealRoot(folder, real));
    // under followLinks, the exact realpath of every folder entered; a link to one of them (a loop, or a second path) is not entered
    const entered = new Set<string>();
    const relOf = (folder: Folder, name: string): string => (folder.rel === '' ? name : `${folder.rel}/${name}`);
    // The network check runs before any call names the link's target; a missing target and a loop are left out silently.
    const linkTarget = async (rel: string, folder: Folder): Promise<LinkTarget | undefined> => {
      if (matched(rel, false, folder) === 'ignore' && matched(rel, true, folder) === 'ignore') return undefined;
      const segments = rel.split('/');
      // the path the check judges, through each link from the root, as ripgrep later opens it
      const through = path.join(root, ...segments);
      try {
        if (!(await followsLocalLinksOnly(root, segments))) return undefined;
        const stats = await fs.stat(through);
        if (stats.isFile()) {
          if (matched(rel, false, folder) === 'ignore') return undefined;
          return skipReal.length > 0 && skipped(await fs.realpath(through)) ? undefined : { kind: 'file', modifiedAt: stats.mtimeMs };
        }
        if (!stats.isDirectory() || matched(rel, true, folder) === 'ignore') return undefined;
        return { kind: 'folder', real: await fs.realpath(through) };
      } catch (err) {
        const code = errnoCode(err);
        if (code === undefined) throw err;
        if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') errors.push(`${rel.replaceAll('/', path.sep)}: ${(err as Error).message}`);
        return undefined;
      }
    };
    // a timed file gone since its folder's listing has no time
    const timeOf = async (file: string, listedAs: string): Promise<void> => {
      try {
        modified.set(listedAs, (await fs.stat(file)).mtimeMs);
      } catch (err) {
        const code = errnoCode(err);
        if (code === undefined) throw err;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') errors.push(`${listedAs}: ${(err as Error).message}`);
      }
    };
    const linksOf = async (folder: Folder, listed: readonly Dirent[]): Promise<ReadonlyMap<string, LinkTarget>> => {
      // a .git that is a link marks a repository and is never read through
      const links = followLinks ? listed.filter((entry) => entry.isSymbolicLink() && entry.name !== '.git') : [];
      if (links.length === 0) return NO_LINKS;
      const found = new Map<string, LinkTarget>();
      let next = 0;
      let failed = false;
      // at most LINK_CHECKS at once, none started after an abort or a failed check, so the walk's released waits on few
      const check = async (): Promise<void> => {
        for (let index = next++; index < links.length && !signal?.aborted && !failed; index = next++) {
          const entry = links[index]!;
          const target = await linkTarget(relOf(folder, entry.name), folder).catch((err: unknown) => {
            failed = true;
            throw err;
          });
          if (target !== undefined) found.set(entry.name, target);
        }
      };
      await settleAll(Array.from({ length: Math.min(LINK_CHECKS, links.length) }, check));
      return found;
    };
    const read = async (pending: Pending): Promise<Listing | Error> => {
      let listed: Dirent[];
      try {
        listed = await fs.readdir(pending.abs, { withFileTypes: true });
      } catch (err) {
        if (errnoCode(err) === undefined) throw err;
        return err as Error;
      }
      const rules = await folderRules(pending.abs, listed, options, root, false);
      const folder = childFolder(pending.parent, pending.rel, rules);
      return { folder, entries: listed, abs: pending.abs, real: pending.real, linked: pending.linked, links: await linksOf(folder, listed) };
    };
    const pend = (abs: string, rel: string, parent: Folder, real: string | undefined, linked: boolean): Pending => {
      if (real !== undefined) entered.add(exact(real));
      return { abs, rel, parent, real, linked };
    };
    const stack: Pending[] = [];
    const readAhead = (): void => {
      for (let index = stack.length - 1, started = 0; index >= 0 && started < READ_AHEAD; index--, started++) {
        const pending = stack[index]!;
        if (pending.listing) continue;
        const listing = read(pending).catch((failed: unknown) => ({ failed }));
        pending.listing = listing;
        ahead.add(listing);
        void listing.then(() => ahead.delete(listing));
      }
    };
    const rootReal = followLinks ? canonicalRoot : undefined;
    if (rootReal !== undefined) entered.add(exact(rootReal));
    let current: Listing = { folder: top, entries, abs: root, real: rootReal, linked: false, links: await linksOf(top, entries) };
    for (;;) {
      if (signal?.aborted) throw aborted();
      const { folder, abs, real, linked: throughLink, links } = current;
      const folders: Pending[] = [];
      const linkedFolders: Array<{ readonly rel: string; readonly real: string }> = [];
      const listed: string[] = [];
      const timing: Array<Promise<void>> = [];
      for (const entry of current.entries) {
        const rel = relOf(folder, entry.name);
        const linked = links.get(entry.name);
        if (entry.isDirectory()) {
          if ((entry.name !== '.git' || options.gitFolders === 'list') && matched(rel, true, folder) !== 'ignore') folders.push(pend(path.join(abs, entry.name), rel, folder, real === undefined ? undefined : path.join(real, entry.name), throughLink));
        } else if (linked?.kind === 'folder') {
          linkedFolders.push({ rel, real: linked.real });
        } else if ((entry.isFile() || linked?.kind === 'file') && matched(rel, false, folder) !== 'ignore') {
          // below a followed link a file's realpath is its folder's and its name
          if (throughLink && real !== undefined && entry.isFile() && skipped(path.join(real, entry.name))) continue;
          const file = path.sep === '/' ? rel : rel.replaceAll('/', path.sep);
          listed.push(file);
          if (timed === undefined || !isTimedFile(timed, rel)) continue;
          if (linked?.kind === 'file') modified.set(file, linked.modifiedAt);
          else timing.push(timeOf(path.join(abs, entry.name), file));
        }
      }
      // after the listing's own folders, so a link to a sibling is the repeat, never the sibling itself
      for (const { rel, real: target } of linkedFolders) {
        if (!entered.has(exact(target))) folders.push(pend(target, rel, folder, target, true));
      }
      await settleAll(timing);
      stack.push(...folders.reverse());
      // the reads run while the caller takes the batch
      readAhead();
      yield listed;
      let next: Listing | undefined;
      while (next === undefined) {
        const pending = stack.pop();
        if (pending === undefined) return;
        const listing = await (pending.listing ?? read(pending));
        if ('failed' in listing) throw listing.failed;
        if (listing instanceof Error) errors.push(`${pending.rel.replaceAll('/', path.sep)}: ${listing.message}`);
        else next = listing;
      }
      current = next;
    }
  }
  return { files: files(), errors, modified, readsAhead: () => ahead.size, readsSettled: () => Promise.all(ahead).then(() => undefined) };
}

/** The allowed hosts of a walk no chat runs: the root's own, so a project on a share reads its share and no other host. */
export function rootHosts(root: string): () => Promise<ReadonlySet<string>> {
  let hosts: Promise<ReadonlySet<string>> | undefined;
  return () => (hosts ??= networkHostsOf([root]));
}

/** An entry below a walked folder: its path below the root, with the platform's separators, and its type from its folder's listing. */
export interface TreeEntry {
  readonly rel: string;
  // 'link' is any reparse point on Windows (a symlink, a junction, a mount point, a cloud placeholder)
  readonly kind: 'file' | 'folder' | 'link' | 'other';
}

/**
 * Every entry below root, a folder, with walkFiles' listing and none of its ignore rules (a `.git` folder included): each entry is
 * typed by its folder's listing, so a link is reported and never entered, stat'd or opened. A folder that cannot be listed rejects.
 */
export async function* walkTree(root: string, signal: AbortSignal | undefined): AsyncGenerator<TreeEntry, void, undefined> {
  const folders = [''];
  for (let rel = folders.pop(); rel !== undefined; rel = folders.pop()) {
    if (signal?.aborted) throw aborted();
    for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : 'other';
      yield { rel: child, kind };
      if (kind === 'folder') folders.push(child);
    }
  }
}

/** Whether root or a folder above it, as written, holds a `.git` (pi's find asks this to pass `--no-require-git`), read from listings. */
export async function insideGitRepo(root: string): Promise<boolean> {
  for (let current = root; ; ) {
    if ((await listedEntry(current, '.git')) !== undefined) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Where the repository of a search rooted at root keeps its info/exclude, when its `.git` is a file whose pointer leads off this
 * computer: the nearest `.git` of root and the folders above its canonical path, as rg finds a repository. Undefined when root is
 * missing, unreadable or no folder, or its repository's pointer stays on this computer.
 */
export async function rootPointerReach(root: string, allowedHosts: () => Promise<ReadonlySet<string>>): Promise<PointerReach | undefined> {
  let canonical: string;
  let entries: Dirent[];
  try {
    canonical = await fs.realpath(root);
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    // the walk cannot read such a root either, and fails with its own error
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(errnoCode(err) ?? '')) return undefined;
    throw err;
  }
  let git = entries.find((entry) => entry.name === '.git');
  let folder = root;
  for (let current = canonical, parent = path.dirname(current); git === undefined && parent !== current; current = parent, parent = path.dirname(current)) {
    folder = parent;
    git = await listedEntry(parent, '.git');
  }
  return git?.isFile() ? (await gitFileExclude(path.join(folder, '.git'), root, allowedHosts)).reach : undefined;
}
