import { parseQuickOpenQuery } from '../../core/quick-open/fuzzy-match';
import { authorityKeyOfProject, pathFor, rootHolding } from '../../shared/project-location';
import type { Project } from '../local-services/confine';
import type { QuickOpenMatch, QuickOpenResult } from '../preload/overlay-channels';
import type { ProjectWorkspace } from '../workspace/project-workspace';
import { NotConnectedError, type Workspaces } from './workspace/workspaces';

// A path the user typed in Quick Open, as VS Code's anythingQuickAccess.ts getAbsolutePathFileResult takes one, before any
// file system call.
export interface TypedPath {
  // drive: from `C:\` or `C:/`; posix: from its leading '/'; home: what follows '~', '' or from its separator
  readonly form: 'drive' | 'posix' | 'home';
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

// C0 and C1 controls, NUL included
const CONTROL = /\p{Cc}/u;

/**
 * The typed path in raw, or undefined for text that is no absolute path: trimmed, a double-quoted path taken verbatim, and
 * the `:line[:column]` suffix read as Quick Open reads it (`(12)` included). A leading '@' (a mention), a control character, a
 * leading `\\` or `//` (UNC and device paths), a drive-relative (`C:x`) and a root-relative (`\x`) path are refused.
 */
export function parseTypedPath(raw: string): TypedPath | undefined {
  const text = raw.trim();
  if (text.startsWith('@') || CONTROL.test(text)) return undefined;
  const parts = unquoted(text);
  if (!parts) return undefined;
  const { filter: typed, line, column } = parts;
  const position = { ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) };
  if (typed.startsWith('\\\\') || typed.startsWith('//')) return undefined;
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
  if (typed.form === 'drive') return os === 'win32';
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
  // an authority's OS: this computer's, or a host's as its connection, its projects or its saved record name it; undefined when not known
  readonly authorityOs: (authority: string) => NodeJS.Platform | undefined;
  // an authority's home folder: os.homedir() on this computer, a connected host's from its connection; undefined otherwise
  readonly homedir: (authority: string) => string | undefined;
  // a host's name, for the path row's chip
  readonly hostName: (authority: string) => string;
}

export interface TypedPathRow {
  readonly result: QuickOpenResult;
  readonly line?: number;
  readonly column?: number;
}

function whole(text: string): QuickOpenMatch[] {
  return text === '' ? [] : [[0, text.length]];
}

/** Where a typed path resolves: its authority, that authority's OS, and the absolute path in that OS's rules. */
export interface TypedPathTarget {
  readonly authority: string;
  readonly os: NodeJS.Platform;
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
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
  if (typed.form === 'home') {
    const home = deps.homedir(authority);
    if (home === undefined) return undefined;
    target = home.replace(/[\\/]+$/, '') + typed.path;
    if (target === '') target = home;
  }
  if (os === 'win32') target = pathFor({ os }).normalize(target);
  return { authority, os, path: target, ...(typed.line !== undefined ? { line: typed.line } : {}), ...(typed.column !== undefined ? { column: typed.column } : {}) };
}

/**
 * The one Quick Open row of a typed path that resolves to a file on its authority: the project row when it lies in one of
 * that authority's roots, else the path row. Undefined for anything else (no typed path, no authority fits, its host is not
 * connected, a folder, a missing file, a path the host's rules refuse), and the query is a text search.
 */
export async function typedPathRow(raw: string, selectedProjectKey: string | undefined, deps: TypedPathDeps): Promise<TypedPathRow | undefined> {
  const target = typedPathTarget(raw, selectedProjectKey, deps);
  return target && (await typedPathRowAt(target, deps));
}

/** typedPathRow of a target typedPathTarget gave. */
export async function typedPathRowAt(typed: TypedPathTarget, deps: TypedPathDeps): Promise<TypedPathRow | undefined> {
  const { authority, os, path: target } = typed;
  let workspace: ProjectWorkspace;
  try {
    workspace = deps.workspaces.forAuthority(authority);
  } catch (err) {
    if (err instanceof NotConnectedError) return undefined;
    throw err;
  }
  const position = { ...(typed.line !== undefined ? { line: typed.line } : {}), ...(typed.column !== undefined ? { column: typed.column } : {}) };
  const projectRow = (project: Project, relativePath: string): TypedPathRow => {
    const slash = relativePath.lastIndexOf('/');
    const label = relativePath.slice(slash + 1);
    const description = slash < 0 ? '' : relativePath.slice(0, slash);
    return {
      result: { kind: 'project', projectKey: project.key, projectName: project.name, relativePath, label, description, labelMatches: whole(label), descriptionMatches: whole(description), recent: false },
      ...position,
    };
  };
  const roots = deps.projects().filter((project) => authorityKeyOfProject(project.key) === authority);
  // a project confines the paths it holds before any outside rule, which refuses every path of a share or a mapped drive
  const held = rootHolding({ os }, roots, target);
  const confined = held && (await workspace.files.confineExisting(held.root, held.relativePath));
  if (held && confined?.ok) return (await workspace.files.isDirectory(confined.path)) ? undefined : projectRow(held.root, held.relativePath);
  const resolved = await workspace.files.resolveOutside(target, {});
  if (resolved.kind !== 'file') return undefined;
  const inRoot = await workspace.files.projectOfPath(roots, resolved.path);
  if (inRoot) return projectRow(inRoot.project, inRoot.relativePath);
  const flavor = pathFor({ os });
  const label = flavor.basename(resolved.path);
  const description = flavor.dirname(resolved.path);
  return {
    result: {
      kind: 'path',
      authority,
      path: resolved.path,
      label,
      description,
      labelMatches: whole(label),
      descriptionMatches: whole(description),
      ...(authority !== 'local' ? { host: deps.hostName(authority) } : {}),
      recent: false,
    },
    ...position,
  };
}
