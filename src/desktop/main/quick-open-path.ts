import { parseQuickOpenQuery } from '../../core/quick-open/fuzzy-match';
import { folderKeyOn } from '../../core/workspace-folders/folder-key';
import { authorityKeyOfProject, isUncOrDevicePath, pathFor } from '../../shared/project-location';
import type { Project } from '../local-services/confine';
import { MAX_QUICK_OPEN_LISTING_RESULTS, MAX_QUICK_OPEN_QUERY_LENGTH, quickOpenRowKey, type QuickOpenCompletion, type QuickOpenMatch, type QuickOpenPathResult, type QuickOpenProjectResult, type QuickOpenResponse, type QuickOpenResult } from '../preload/overlay-channels';
import type { OutsideListing, OutsideListingEntry } from '../workspace/file-system';
import { MAX_NAME_PREFIX_LENGTH, namePrefixMatches } from '../workspace/outside-listing';
import type { ProjectWorkspace } from '../workspace/project-workspace';
import { compareEntries } from './files/file-tree';
import { ListingUnsupportedError } from './workspace/remote-workspace';
import type { RootSpellings } from './workspace/root-spellings';
import { NotConnectedError, type Workspaces } from './workspace/workspaces';

// A path the user typed in Quick Open, as VS Code's anythingQuickAccess.ts getAbsolutePathFileResult takes one, before any
// file system call.
export interface TypedPath {
  // drive: from `C:\` or `C:/`; posix: from its leading '/'; home: what follows '~', '' or from its separator; unc: from
  // `\\server\share`
  readonly form: 'drive' | 'posix' | 'home' | 'unc';
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  // typed between double quotes
  readonly quoted?: true;
}

// C0 and C1 controls, NUL included
const CONTROL = /\p{Cc}/u;
// `\\server\share`, either separator, whose server is no device namespace (`?`, `.`)
const UNC_PATH = /^[\\/]{2}(?![?.](?:[\\/]|$))[^\\/]+[\\/][^\\/]/;

/**
 * The typed path in raw, or undefined for text that is no absolute path: trimmed, a double-quoted path taken verbatim, and
 * the `:line[:column]` suffix read as Quick Open reads it (`(12)` included). A leading '@' (a mention), a control character, a
 * device path (`\\?\`, `\\.\`), a drive-relative (`C:x`) and a root-relative (`\x`) path are refused.
 */
export function parseTypedPath(raw: string): TypedPath | undefined {
  const text = raw.trim();
  if (text.startsWith('@') || CONTROL.test(text)) return undefined;
  const parts = unquoted(text);
  if (!parts) return undefined;
  const { filter: typed, line, column } = parts;
  const position = { ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}), ...(text.startsWith('"') ? { quoted: true as const } : {}) };
  if (isUncOrDevicePath(typed)) return UNC_PATH.test(typed) ? { form: 'unc', path: typed, ...position } : undefined;
  if (/^[A-Za-z]:[\\/]/.test(typed)) return { form: 'drive', path: typed, ...position };
  if (/^[A-Za-z]:/.test(typed) || typed.startsWith('\\')) return undefined;
  if (typed.startsWith('/')) return { form: 'posix', path: typed, ...position };
  if (typed === '~' || typed.startsWith('~/') || typed.startsWith('~\\')) return { form: 'home', path: typed.slice(1), ...position };
  return undefined;
}

// `"path"` or `"path":12`, the path between the quotes as written, spaces and colons included; unquoted text as Quick Open
// parses it. Undefined for a quote left open or text after the closing quote that is no position.
function unquoted(text: string): { readonly filter: string; readonly line?: number; readonly column?: number } | undefined {
  if (!text.startsWith('"')) return parseQuickOpenQuery(text);
  const close = text.indexOf('"', 1);
  if (close < 0) return undefined;
  const filter = text.slice(1, close);
  const tail = text.slice(close + 1);
  if (tail === '') return { filter };
  const suffix = parseQuickOpenQuery(tail);
  if (suffix.mention || suffix.filter !== '') return undefined;
  return { filter, ...(suffix.line !== undefined ? { line: suffix.line } : {}), ...(suffix.column !== undefined ? { column: suffix.column } : {}) };
}

/** Whether a typed path names a file by the rules of an OS: a drive path only win32's, a POSIX one only the others'. */
export function fitsOs(typed: TypedPath, os: NodeJS.Platform): boolean {
  if (typed.form === 'drive' || typed.form === 'unc') return os === 'win32';
  if (typed.form === 'posix') return os !== 'win32';
  return !typed.path.startsWith('\\') || os === 'win32';
}

/**
 * The authority a typed path is resolved on: the selected project's when its rules fit, else this computer's when they fit,
 * else none. Another host is never asked. osOf: undefined for an authority whose OS is not known.
 */
export function typedPathAuthority(typed: TypedPath, selected: string | undefined, osOf: (authority: string) => NodeJS.Platform | undefined): string | undefined {
  if (selected !== undefined) {
    const os = osOf(selected);
    if (os !== undefined && fitsOs(typed, os)) return selected;
  }
  const local = osOf('local');
  return selected !== 'local' && local !== undefined && fitsOs(typed, local) ? 'local' : undefined;
}

export interface TypedPathDeps {
  // Quick Open's roots
  readonly projects: () => readonly Project[];
  readonly workspaces: Workspaces;
  // the spellings of the local roots' folders; a UNC path names a root's file only through them
  readonly spellings: Pick<RootSpellings, 'holding' | 'match' | 'confirms'>;
  // an authority's OS: this computer's, or a host's as its connection, its projects or its saved record name it; undefined when not known
  readonly authorityOs: (authority: string) => NodeJS.Platform | undefined;
  // an authority's home folder: os.homedir() on this computer, a connected host's from its connection; undefined otherwise
  readonly homedir: (authority: string) => string | undefined;
  // a host's name, for the path row's chip
  readonly hostName: (authority: string) => string;
}

function whole(text: string): QuickOpenMatch[] {
  return text === '' ? [] : [[0, text.length]];
}

/** A project-relative path as a Quick Open row names it: the file name, and the '/'-separated folder above it, '' at the root. */
export function relativeLabel(relativePath: string): { readonly label: string; readonly description: string } {
  const slash = relativePath.lastIndexOf('/');
  return { label: relativePath.slice(slash + 1), description: slash < 0 ? '' : relativePath.slice(0, slash) };
}

export interface TypedPathSplit {
  // the text up to and including the last separator as typed: its opening quote, `~`, and each separator as written
  readonly folderText: string;
  // the absolute folder in its authority's rules, `~` expanded and a win32 path normalized
  readonly folder: string;
  // the text after the last separator, without the `:line[:column]` suffix
  readonly segment: string;
}

/** Where a typed path resolves: its authority, that authority's OS, and the absolute path in that OS's rules. */
export interface TypedPathTarget {
  readonly authority: string;
  readonly os: NodeJS.Platform;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  // undefined where no folder lists: a bare `~`, a `..` segment after the last separator, a POSIX path with a dot segment
  // before it, a UNC path; a `.` segment lists its folder's names that start with '.'
  readonly split?: TypedPathSplit;
}

function splitOf(typed: TypedPath, os: NodeJS.Platform, home: string | undefined): TypedPathSplit | undefined {
  const written = typed.form === 'home' ? `~${typed.path}` : typed.path;
  const last = os === 'win32' ? Math.max(written.lastIndexOf('/'), written.lastIndexOf('\\')) : written.lastIndexOf('/');
  if (last < 0) return undefined;
  const folderPart = written.slice(0, last + 1);
  const segment = written.slice(last + 1);
  // the wire refuses a longer prefix or one holding a separator
  if (segment === '..' || segment.length > MAX_NAME_PREFIX_LENGTH || segment.includes('\\')) return undefined;
  // no Windows name holds these, so nothing could match; ':' would name a stream
  if (os === 'win32' && /[<>:"|?*]/.test(segment)) return undefined;
  if (os !== 'win32' && folderPart.split('/').some((part) => part === '.' || part === '..')) return undefined;
  let folder = folderPart;
  if (typed.form === 'home') {
    if (home === undefined) return undefined;
    folder = home.replace(/[\\/]+$/, '') + folderPart.slice(1);
  }
  if (os === 'win32') folder = pathFor({ os }).normalize(folder);
  return { folderText: `${typed.quoted ? '"' : ''}${folderPart}`, folder, segment };
}

/**
 * The target of raw as a typed path, with no file system call; undefined for text that is no typed path, a path no authority
 * fits, or `~` where that authority's home is not known. A win32 path has its '.' and '..' segments resolved by text, as
 * Windows resolves them; a POSIX path keeps them, since the kernel resolves '..' after the link before it.
 */
export function typedPathTarget(raw: string, selectedProjectKey: string | undefined, deps: Pick<TypedPathDeps, 'authorityOs' | 'homedir'>): TypedPathTarget | undefined {
  const typed = parseTypedPath(raw);
  if (!typed) return undefined;
  const authority = typedPathAuthority(typed, selectedProjectKey === undefined ? undefined : authorityKeyOfProject(selectedProjectKey), deps.authorityOs);
  const os = authority === undefined ? undefined : deps.authorityOs(authority);
  if (authority === undefined || os === undefined) return undefined;
  let target = typed.path;
  const home = typed.form === 'home' ? deps.homedir(authority) : undefined;
  if (typed.form === 'home') {
    if (home === undefined) return undefined;
    target = home.replace(/[\\/]+$/, '') + typed.path;
    if (target === '') target = home;
  }
  if (os === 'win32') target = pathFor({ os }).normalize(target);
  // no UNC folder is listed, even one a project's spelling holds
  const split = typed.form === 'unc' ? undefined : splitOf(typed, os, home);
  return {
    authority,
    os,
    path: target,
    ...(typed.line !== undefined ? { line: typed.line } : {}),
    ...(typed.column !== undefined ? { column: typed.column } : {}),
    ...(split ? { split } : {}),
  };
}

// Whether input reads back as a typed path whose text is exactly text, with no position.
function parsesBackTo(input: string, text: string): boolean {
  const typed = parseTypedPath(input);
  return typed !== undefined && typed.line === undefined && typed.column === undefined && (typed.form === 'home' ? `~${typed.path}` : typed.path) === text;
}

// Quoted with the caret before the closing quote when the plain text would not read back as the path; undefined when no
// query main accepts can name it.
export function typedInput(folderText: string, tail: string): QuickOpenCompletion | undefined {
  const quoted = folderText.startsWith('"');
  const text = (quoted ? folderText.slice(1) : folderText) + tail;
  if (!quoted && parsesBackTo(text, text)) return text.length <= MAX_QUICK_OPEN_QUERY_LENGTH ? { input: text } : undefined;
  const input = `"${text}"`;
  return parsesBackTo(input, text) && input.length <= MAX_QUICK_OPEN_QUERY_LENGTH ? { input, caret: input.length - 1 } : undefined;
}

// Absolute when nothing typed names the parent: `~/`, or a last segment of '.' or '..' that Windows resolved.
function parentInput(split: TypedPathSplit, os: NodeJS.Platform): QuickOpenCompletion | undefined {
  const flavor = pathFor({ os });
  const parent = flavor.dirname(split.folder.replace(os === 'win32' ? /(?<=[^\\/:])[\\/]+$/ : /(?<=[^/])\/+$/, ''));
  if (parent === split.folder) return undefined;
  const quote = split.folderText.startsWith('"') ? '"' : '';
  const body = split.folderText.slice(quote.length).replace(os === 'win32' ? /[\\/]+$/ : /\/+$/, '');
  const last = os === 'win32' ? Math.max(body.lastIndexOf('/'), body.lastIndexOf('\\')) : body.lastIndexOf('/');
  const lastName = body.slice(last + 1);
  if (last >= 0 && lastName !== '.' && lastName !== '..') return typedInput(`${quote}${body.slice(0, last + 1)}`, '');
  return typedInput(`${quote}${parent.endsWith(flavor.sep) ? parent : `${parent}${flavor.sep}`}`, '');
}

export interface TypedPathRows {
  readonly results: readonly QuickOpenResult[];
  // the typed `:line[:column]`, which only the exact file row takes
  readonly line?: number;
  readonly column?: number;
  readonly truncated?: NonNullable<QuickOpenResponse['truncated']>;
  readonly emptyText?: NonNullable<QuickOpenResponse['emptyText']>;
  readonly emptyName?: string;
}

// Only a listing the bounds did not cut may serve a longer prefix; it lives as long as its open request.
export interface ListingCache {
  last?: { readonly authority: string; readonly folder: string; readonly prefix: string; readonly listing: Extract<OutsideListing, { kind: 'folder' }> };
}

async function listingOf(workspace: ProjectWorkspace, authority: string, split: TypedPathSplit, cache: ListingCache): Promise<OutsideListing | undefined> {
  const { last } = cache;
  if (last && last.authority === authority && last.folder === split.folder && namePrefixMatches(split.segment, last.prefix)) {
    return { ...last.listing, entries: last.listing.entries.filter((entry) => namePrefixMatches(entry.name, split.segment)) };
  }
  let listing: OutsideListing;
  try {
    listing = await workspace.files.listOutside(split.folder, split.segment);
  } catch (err) {
    // a server too old to list, or a host gone meanwhile, gives no listing and leaves the exact row alone
    if (err instanceof ListingUnsupportedError || err instanceof NotConnectedError) return undefined;
    throw err;
  }
  if (listing.kind === 'folder' && !listing.truncated) cache.last = { authority, folder: split.folder, prefix: split.segment, listing };
  return listing;
}

// The file lookup and the listing settle apart: a failure of either goes to report, and the other still answers.
export async function typedPathRowsAt(typed: TypedPathTarget, deps: TypedPathDeps, cache: ListingCache, report: (err: unknown) => void): Promise<TypedPathRows | undefined> {
  const { authority, os, split } = typed;
  let workspace: ProjectWorkspace;
  try {
    workspace = deps.workspaces.forAuthority(authority);
  } catch (err) {
    if (err instanceof NotConnectedError) return undefined;
    throw err;
  }
  const roots = deps.projects().filter((project) => authorityKeyOfProject(project.key) === authority);
  const [fileLookup, folderLookup] = await Promise.allSettled([exactRowAt(typed, workspace, roots, deps), split ? listingOf(workspace, authority, split, cache) : undefined]);
  if (fileLookup.status === 'rejected') report(fileLookup.reason);
  if (folderLookup.status === 'rejected') report(folderLookup.reason);
  const found = fileLookup.status === 'fulfilled' ? fileLookup.value : undefined;
  const listing = folderLookup.status === 'fulfilled' ? folderLookup.value : undefined;
  const exact = found && { ...found.row, exact: true as const };
  const position = { ...(typed.line !== undefined ? { line: typed.line } : {}), ...(typed.column !== undefined ? { column: typed.column } : {}) };
  const alone = exact && { results: [exact], ...position };
  if (!split || !listing || (listing.kind !== 'folder' && listing.kind !== 'denied')) return alone;
  if (listing.kind !== 'folder') return alone ?? { results: [], emptyText: 'folderDenied' };
  const host = authority !== 'local' ? { host: deps.hostName(authority) } : {};
  const context: ListedFolder = { os, authority, folderText: split.folderText, folderPath: listing.path, roots, spellings: deps.spellings, labelMatches: split.segment === '' ? [] : [[0, split.segment.length]], host };
  const parent = split.segment === '' ? parentInput(split, os) : undefined;
  const rows: ListedRow[] = parent ? [{ row: { kind: 'folder', authority, label: '..', labelMatches: [], ...folderInput(parent), ...host } }] : [];
  for (const entry of [...listing.entries].sort(compareEntries)) {
    const listed = entryRow(entry, context);
    if (listed) rows.push(listed);
  }
  // match by realpath too: a junction, a subst drive or another letter case spells the typed file differently
  const exactKey = exact && quickOpenRowKey(exact);
  const realKey = found && folderKeyOn(os, found.real);
  const duplicate = exact && rows.find(({ row, real }) => quickOpenRowKey(row) === exactKey || (real !== undefined && folderKeyOn(os, real) === realKey));
  const first = exact && duplicate && duplicate.row.kind !== 'folder' && duplicate.row.complete ? { ...exact, complete: duplicate.row.complete } : exact;
  // a file and a link to it, or two links to one file, share a key and show once, as the first in order
  const seen = new Set(first ? [quickOpenRowKey(first)] : []);
  const all: QuickOpenResult[] = first ? [first] : [];
  for (const listed of rows) {
    const key = quickOpenRowKey(listed.row);
    if (listed === duplicate || seen.has(key)) continue;
    seen.add(key);
    all.push(listed.row);
  }
  const results = all.slice(0, MAX_QUICK_OPEN_LISTING_RESULTS);
  const truncated = listing.truncated || all.length > results.length;
  // the typed file row stands for a listed entry only when it took that entry's place
  const listed = results.filter((row) => row !== first || duplicate).length - (parent ? 1 : 0);
  return {
    results,
    ...(first ? position : {}),
    ...(truncated ? { truncated: { listed } } : {}),
    ...(results.length === 0 && !truncated ? (split.segment === '' ? { emptyText: 'folderEmpty' as const } : { emptyText: 'folderNoMatch' as const, emptyName: split.segment }) : {}),
  };
}

function folderInput(completion: QuickOpenCompletion): { readonly input: string; readonly caret?: number } {
  return { input: completion.input, ...(completion.caret !== undefined ? { caret: completion.caret } : {}) };
}

interface ListedFolder {
  readonly os: NodeJS.Platform;
  readonly authority: string;
  readonly folderText: string;
  // the folder's realpath
  readonly folderPath: string;
  // the authority's projects
  readonly roots: readonly Project[];
  readonly spellings: TypedPathDeps['spellings'];
  // the typed name's range in a listed name
  readonly labelMatches: readonly QuickOpenMatch[];
  readonly host: { readonly host?: string };
}

// A listing's row; real: a file row's realpath
interface ListedRow {
  readonly row: QuickOpenResult;
  readonly real?: string;
}

interface ExactRow {
  readonly row: QuickOpenProjectResult | QuickOpenPathResult;
  readonly real: string;
}

// A project's file maps by its realpath in any spelling of the project's folder, with no file system call.
function entryRow(entry: OutsideListingEntry, listed: ListedFolder): ListedRow | undefined {
  const { os, authority, folderText, labelMatches, host } = listed;
  // no Windows name holds a separator, so a host that sends one names another folder
  if (os === 'win32' && /[\\/]/.test(entry.name)) return undefined;
  if (entry.kind === 'dir') {
    const descend = typedInput(folderText, `${entry.name}${folderText.slice(-1)}`);
    return descend && { row: { kind: 'folder', authority, label: entry.name, labelMatches, ...folderInput(descend), ...host } };
  }
  const flavor = pathFor({ os });
  const complete = typedInput(folderText, entry.name);
  const real = entry.target ?? flavor.join(listed.folderPath, entry.name);
  const held = listed.spellings.holding({ authority, os }, listed.roots, real);
  // a link keeps its own name as the label, which the typed prefix matched
  if (held) return { row: { ...projectRow(held.root, held.relativePath), label: entry.name, labelMatches, descriptionMatches: [], ...(complete ? { complete } : {}) }, real };
  const row: QuickOpenPathResult = {
    kind: 'path',
    authority,
    path: real,
    label: entry.name,
    description: flavor.dirname(real),
    labelMatches,
    descriptionMatches: [],
    ...host,
    recent: false,
    ...(complete ? { complete } : {}),
  };
  return { row, real };
}

function projectRow(project: Project, relativePath: string): QuickOpenProjectResult {
  const { label, description } = relativeLabel(relativePath);
  return { kind: 'project', projectKey: project.key, projectName: project.name, relativePath, label, description, labelMatches: whole(label), descriptionMatches: whole(description), recent: false };
}

// real: the realpath the lookup confirmed, which the listing's rows are matched against.
async function exactRowAt(typed: TypedPathTarget, workspace: ProjectWorkspace, roots: readonly Project[], deps: TypedPathDeps): Promise<ExactRow | undefined> {
  const { authority, os, path: target } = typed;
  // a project confines the paths it holds in any spelling before any outside rule, which refuses every path of a share
  const held = await deps.spellings.match({ authority, os }, roots, target);
  const confined = held && (await workspace.files.confineExisting(held.root, held.relativePath));
  if (held && confined?.ok && deps.spellings.confirms(held, confined.path)) {
    return (await workspace.files.isDirectory(confined.path)) ? undefined : { row: projectRow(held.root, held.relativePath), real: confined.path };
  }
  // a UNC path names a project's file or nothing, so the outside rule never sees one
  if (os === 'win32' && isUncOrDevicePath(target)) return undefined;
  const resolved = await workspace.files.resolveOutside(target);
  // a share's file is only a project's, matched in its spellings and confined by it, with no call naming the share path
  if (resolved.kind === 'share') {
    if (resolved.entry !== 'file') return undefined;
    const onShare = await deps.spellings.match({ authority, os }, roots, resolved.path);
    const shareFile = onShare && (await workspace.files.confineExisting(onShare.root, onShare.relativePath));
    if (!onShare || !shareFile?.ok || !deps.spellings.confirms(onShare, shareFile.path) || folderKeyOn(os, shareFile.path) !== folderKeyOn(os, resolved.path)) return undefined;
    return { row: projectRow(onShare.root, onShare.relativePath), real: shareFile.path };
  }
  if (resolved.kind !== 'file') return undefined;
  const inRoot = await workspace.files.projectOfPath(roots, resolved.path);
  if (inRoot) return { row: projectRow(inRoot.project, inRoot.relativePath), real: resolved.path };
  const flavor = pathFor({ os });
  const label = flavor.basename(resolved.path);
  const description = flavor.dirname(resolved.path);
  const row: QuickOpenPathResult = {
    kind: 'path',
    authority,
    path: resolved.path,
    label,
    description,
    labelMatches: whole(label),
    descriptionMatches: whole(description),
    ...(authority !== 'local' ? { host: deps.hostName(authority) } : {}),
    recent: false,
  };
  return { row, real: resolved.path };
}
