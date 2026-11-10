import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { hasUnsafeWindowsSegment, isRelativeFilePath, isUnsafeWindowsName } from '../../shared/relative-path';
import { isSafeAgentPathId } from '../../shared/agent-path-id';
import { isDesignId, isDesignScreenFile, MAX_DESIGN_ID_CHARS } from '../../shared/design-paths';
import { canonicalPath, spelledPath } from '../canonical-path';
import { DAMOCLES_DESIGNS_DIR, hasOtherHardLink, planFileStem } from '../paths';

export const MANIFEST_FILE = 'manifest.json';
export const DECISIONS_FILE = 'decisions.md';
export const INVENTORY_FILE = 'inventory.json';
export const TOKENS_FILE = 'tokens.css';
export const DESIGN_DOC_FILE = 'design.md';
export const ASSETS_DIR = 'assets';
export const SCREENS_DIR = 'screens';
export const REFERENCES_DIR = 'references';

/** At most this many screens and files per design. */
export const MAX_DESIGN_SCREENS = 64;
export const MAX_DESIGN_FILES = 256;
/** The largest screen DesignCheck, the preview and a question preview read. */
export const MAX_SCREEN_BYTES: number = 2 * 1024 * 1024;
export const MAX_DESIGN_DOC_BYTES: number = 256 * 1024;

function assertDesignId(designId: string): void {
  if (!isDesignId(designId)) throw new Error(`Not a design id: ${JSON.stringify(designId.slice(0, MAX_DESIGN_ID_CHARS + 1))}`);
}

/** `~/.damocles/designs/<designId>`; throws for an id that is not a design id (`isDesignId`). */
export function designFolderOf(designId: string): string {
  assertDesignId(designId);
  return path.join(DAMOCLES_DESIGNS_DIR, designId);
}

/** `~/.damocles/designs/.state/<designId>`, core's own: link, outboxes, version records. */
export function designStateDirOf(designId: string): string {
  assertDesignId(designId);
  // `.state` is never a design folder, since it fails `isSafeAgentPathId`.
  return path.join(DAMOCLES_DESIGNS_DIR, '.state', designId);
}

/** A new design's id: the parent's plan file stem, so a plan and its design pair by name (PD-3). */
export function newDesignId(parentSessionId: string, firstMessage: string): string {
  const designId = planFileStem(parentSessionId, firstMessage);
  assertDesignId(designId);
  return designId;
}

const FORK_SUFFIX = /-f[0-9a-f]{8}$/;

/**
 * A fork's own design of an inherited one (PD-37, D71): `<base>-f<sha256(forkSessionId)[0:8]>`, where the base is the inherited
 * id without its own fork suffix, so a fork of a fork is no longer than a fork.
 */
export function forkDesignId(inheritedDesignId: string, forkSessionId: string): string {
  const suffix = `-f${crypto.createHash('sha256').update(forkSessionId).digest('hex').slice(0, 8)}`;
  const designId = inheritedDesignId.replace(FORK_SUFFIX, '').slice(0, MAX_DESIGN_ID_CHARS - suffix.length) + suffix;
  assertDesignId(designId);
  return designId;
}

const VARIANTS_DIR = 'variants';
export const SHARED_DIR = 'shared';
const HTML_EXTENSION = '.html';
const SHARED_EXTENSIONS: readonly string[] = ['.css', '.js'];

// ASCII only, on every platform: a case-insensitive volume folds non-ASCII letters too (APFS reads `ſ` as `s`), so a wider fold
// would let such a spelling match an allowed name while it opens another file.
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** `target` relative to `folder` with forward slashes, as spelled: '' for the folder itself, undefined when it is outside it. */
function relativeWithin(folder: string, target: string): string | undefined {
  const relative = path.relative(folder, target);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return undefined;
  return relative.split(path.sep).join('/');
}

/** Whether `name`, one ASCII-lowercased segment, ends in one of `extensions` after a non-empty stem. */
const hasStemAndExtension = (name: string, extensions: readonly string[]): boolean =>
  extensions.some((extension) => name.length > extension.length && name.endsWith(extension));

/**
 * Whether a design-folder-relative path (forward slashes) is a file the designer writes (D65): `design.md`, `screens/<name>.html`,
 * `shared/<name>.css`, `shared/<name>.js` or a file below `variants/`, in any ASCII case, with no segment Windows resolves to
 * another entry (a trailing dot or space, a device name, a `:` stream). Every other file of a design folder is core's.
 */
export function isDesignerRelative(relative: string): boolean {
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || isUnsafeWindowsName(segment))) return false;
  const [first, ...rest] = segments.map(asciiLower);
  if (rest.length === 0) return first === DESIGN_DOC_FILE;
  if (first === SCREENS_DIR) return rest.length === 1 && hasStemAndExtension(rest[0]!, [HTML_EXTENSION]);
  if (first === SHARED_DIR) return rest.length === 1 && hasStemAndExtension(rest[0]!, SHARED_EXTENSIONS);
  return first === VARIANTS_DIR;
}

/**
 * The design and screen `filePath` names, `<designs folder>/<designId>/screens/<name>.html`, against the designs folder as
 * spelled or as it resolves; undefined for any other path. The screen's own reads check it again below its design folder.
 */
export function designScreenOf(filePath: string): { readonly designId: string; readonly relPath: string } | undefined {
  const target = path.resolve(filePath);
  const relative = relativeWithin(DAMOCLES_DESIGNS_DIR, target) ?? relativeWithin(canonicalPath(DAMOCLES_DESIGNS_DIR), target);
  const slash = relative?.indexOf('/') ?? -1;
  if (relative === undefined || slash <= 0) return undefined;
  const designId = relative.slice(0, slash);
  const relPath = relative.slice(slash + 1);
  return isDesignId(designId) && isDesignScreenFile(relPath) ? { designId, relPath } : undefined;
}

/** Whether `target` is a designer file (`isDesignerRelative`) of design folder `folder`, by its path as written and by the path it resolves to. */
export function isDesignerFile(folder: string, target: string): boolean {
  const requested = path.resolve(target);
  const spelled = relativeWithin(spelledPath(folder), spelledPath(requested));
  const canonical = relativeWithin(canonicalPath(folder), canonicalPath(requested));
  return spelled !== undefined && canonical !== undefined && isDesignerRelative(spelled) && isDesignerRelative(canonical);
}

/**
 * Whether any chat's write tool may write `target` under one writer per design file (D65): each of its path as written and the
 * path it resolves to that lies in the designs folder must be a designer file of a design folder `<designId>/`, and a canonical
 * path there must have no other hard link. The designs folder itself, `.state/` and every core-owned file are refused.
 */
export function designsFolderAllowsWrite(target: string): boolean {
  const requested = path.resolve(target);
  const spelled = relativeWithin(spelledPath(DAMOCLES_DESIGNS_DIR), spelledPath(requested));
  const canonical = canonicalPath(requested);
  const canonicalRelative = relativeWithin(canonicalPath(DAMOCLES_DESIGNS_DIR), canonical);
  return (spelled === undefined || isDesignFolderDesignerFile(spelled))
    && (canonicalRelative === undefined
      // A hard link shares its content with a core-owned file, which no path comparison sees.
      || (isDesignFolderDesignerFile(canonicalRelative) && !hasOtherHardLink(canonical)));
}

/** Whether a designs-folder-relative path is `<designId>/<designer file>`. */
function isDesignFolderDesignerFile(relative: string): boolean {
  const slash = relative.indexOf('/');
  return slash > 0 && isSafeAgentPathId(relative.slice(0, slash)) && isDesignerRelative(relative.slice(slash + 1));
}

// A design-kind question preview names a screen of the chat's own design: an .html file below screens/ or variants/ (PD-18).
const DESIGN_PREVIEW_PATH = /^(?:screens|variants)\/(?:[^/]+\/)*[^/]+\.html$/i;

/** Whether `relPath` may be a design-kind preview's path; the file itself is checked by `readDesignFile`. */
export function isDesignPreviewPath(relPath: string): boolean {
  return DESIGN_PREVIEW_PATH.test(relPath) && isRelativeFilePath(relPath) && !hasUnsafeWindowsSegment(relPath);
}
