import { promises as fs, type BigIntStats } from 'node:fs';
import * as path from 'node:path';
import { isMissing } from '../../core/local-links';
import { piAgentDirIn, sessionLeaseDirIn, sessionsRootIn } from '../../core/pi-session/session-store/session-file-path';
import { namedSegments, type DataStores, type NamedSegments } from '../../core/served-pages/data-stores';
import { hostStoreHostAsync } from '../../core/served-pages/host-data-stores';
import { isInsideRealRoot } from '../../core/workspace-folders/real-root';

// The session store and leases a host's engine alone changes (docs/invariants.md "Session store", "Files never changes a
// session file"), as the workspace's writes and Files actions check them by canonical paths, so a link into them or another
// spelling of them is one too.

// a Damocles home's session store and lease folder, as any machine lays them out below its home
const GUARDED_FOLDERS: readonly (readonly string[])[] = [['.damocles', 'pi', 'agent', 'sessions'], ['.damocles', 'locks', 'sessions']];

// A Files action's answer when reachesSessions holds for it
export const SESSION_FILE_REFUSAL = { ok: false, reason: 'sessionFile' } as const;

/** The realpath of target, or of its deepest existing folder with the missing names below it. */
export async function canonicalOf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (err) {
    const parent = path.dirname(target);
    if (!isMissing(err) || parent === target) throw err;
    return path.join(await canonicalOf(parent), path.basename(target));
  }
}

// this machine's sessions root and lease folder, canonical
const guardedRootsOf = (damoclesHome: string): Promise<string[]> => Promise.all([sessionsRootIn(piAgentDirIn(damoclesHome)), sessionLeaseDirIn(damoclesHome)].map(canonicalOf));

/**
 * Whether a write to filePath, every link followed, lands in the session store or the session leases of the Damocles home
 * damoclesHome, or in a guarded folder of any machine's home by its names (liesInNamedStore). Throws when a path cannot be
 * resolved.
 */
export async function isSessionFile(filePath: string, damoclesHome: string): Promise<boolean> {
  const [file, roots, host] = await Promise.all([canonicalOf(filePath), guardedRootsOf(damoclesHome), hostStoreHostAsync()]);
  return roots.some((root) => isInsideRealRoot(root, file)) || liesInNamedStore(file, host);
}

interface EntryAt {
  readonly path: string;
  // the link's own identity; undefined for anything else, which path names at its realpath
  readonly link?: BigIntStats;
}

// An entry as an action on it reaches it: a link as itself under its parent's realpath, anything else at its realpath, so a
// short (8.3) name or another case of an existing name compares as the entry's own.
async function entryAt(entry: string): Promise<EntryAt> {
  let stat: BigIntStats | undefined;
  try {
    stat = await fs.lstat(entry, { bigint: true });
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  if (stat && !stat.isSymbolicLink()) return { path: await fs.realpath(entry) };
  const parent = path.dirname(entry);
  const at = parent === entry ? entry : path.join(await canonicalOf(parent), path.basename(entry));
  return stat ? { path: at, link: stat } : { path: at };
}

/** Whether `absolute`, a canonical path of the host `host` describes, lies in a guarded folder of any machine's home or is one, by its names (namedSegments). */
export function liesInNamedStore(absolute: string, host: Pick<DataStores, 'platform' | 'drives'>): boolean {
  const { segments, names } = namedSegments(absolute, host);
  return segments.some((_segment, at) => GUARDED_FOLDERS.some((folder) => folder.every((name, depth) => names(segments[at + depth], name))));
}

// Where below the folder `segments` names a guarded folder would lie: each whole guarded folder, and the rest of each one
// whose leading names the folder's path ends in (`.damocles/pi` leaves `agent/sessions`).
function guardedBelow({ segments, names }: NamedSegments): string[][] {
  const below = new Map<string, string[]>(GUARDED_FOLDERS.map((folder) => [folder.join('/'), [...folder]]));
  for (const folder of GUARDED_FOLDERS) {
    for (let depth = 1; depth < folder.length && depth <= segments.length; depth++) {
      const start = segments.length - depth;
      if (folder.slice(0, depth).every((name, index) => names(segments[start + index], name))) below.set(folder.slice(depth).join('/'), folder.slice(depth));
    }
  }
  return [...below.values()];
}

/** Whether `<folder>/<below...>` exists; rejects when that cannot be told. */
export type HeldProbe = (folder: string, below: readonly string[]) => Promise<boolean>;

/**
 * Whether a Files action on `entry`, a canonical path of the host `host` describes, reaches a guarded folder of any machine's
 * Damocles home by its names: entry lies in one or is it (liesInNamedStore), or, when the action deletes or moves entry away
 * (removes), one exists below it where guardedBelow places one (holds).
 */
export async function reachesNamedStore(entry: string, removes: boolean, host: Pick<DataStores, 'platform' | 'drives'>, holds: HeldProbe): Promise<boolean> {
  if (liesInNamedStore(entry, host)) return true;
  if (!removes) return false;
  const answers = await Promise.all(guardedBelow(namedSegments(entry, host)).map((below) => holds(entry, below)));
  return answers.some(Boolean);
}

// one lstat, which follows no link at the last name; a missing name on the way reads as absent
const existsBelow: HeldProbe = (folder, below) => fs.lstat(path.join(folder, ...below)).then(() => true, (err: unknown) => (isMissing(err) ? false : Promise.reject(err)));

/**
 * Whether a Files action on entry, its last name never followed, reaches the session store or the session leases of the
 * Damocles home damoclesHome, or a guarded folder of any machine's home by its names (reachesNamedStore): entry lies in a
 * canonical guarded folder (or is it), or, when the action deletes or moves entry away (removes), holds one or an entry on the
 * engine's own spelled path to one, a link included, which a link entry matches by its identity under any of its names. A
 * link entry holds nothing by the names, since its removal removes only the link. Throws when a path cannot be resolved, so
 * no failure reads as outside the store.
 */
export async function reachesSessions(entry: string, damoclesHome: string, removes: boolean): Promise<boolean> {
  const guarded = [sessionsRootIn(piAgentDirIn(damoclesHome)), sessionLeaseDirIn(damoclesHome)];
  const [at, roots, host] = await Promise.all([entryAt(entry), guardedRootsOf(damoclesHome), hostStoreHostAsync()]);
  if (roots.some((root) => isInsideRealRoot(root, at.path))) return true;
  if (await reachesNamedStore(at.path, removes, host, async (folder, below) => !at.link && (await existsBelow(folder, below)))) return true;
  if (!removes) return false;
  const spelled = new Set<string>();
  for (const root of guarded) {
    for (let prefix = path.resolve(root); ; prefix = path.dirname(prefix)) {
      spelled.add(prefix);
      if (path.dirname(prefix) === prefix) break;
    }
  }
  const engineEntries = await Promise.all([...spelled].map(entryAt));
  const { link } = at;
  if (link && engineEntries.some((held) => held.link !== undefined && held.link.dev === link.dev && held.link.ino === link.ino)) return true;
  return [...roots, ...engineEntries.map((held) => held.path)].some((held) => isInsideRealRoot(at.path, held));
}
