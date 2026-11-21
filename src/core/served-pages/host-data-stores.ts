// This process's own data stores, the host that reads a linked preview file or judges a folder grant (docs/invariants.md
// "Desktop host", HTML previews).
import { promises as fs, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log as logLine } from '../logger';
import { mappedDrivePath } from '../mapped-drives';
import { windowsDriveMounts, type WindowsDriveMount } from '../mountinfo';
import { dataStoreOf, dataStoresOf, type DataStores, type StoreHost } from './data-stores';
import { isDeniedResolvedPath } from './serve-policy';

const MOUNTINFO = '/proc/self/mountinfo';
// how long an answer some folder failed to resolve in is kept before its folders are resolved again
const STORE_RETRY_MS = 60_000;

const storeHost = (drives: readonly WindowsDriveMount[]): StoreHost => ({ platform: process.platform, env: process.env, home: os.homedir(), drives });

// A failed read names no drive.
function unreadMountinfo(err: unknown, log: (line: string) => void): WindowsDriveMount[] {
  log(`[data-stores] ${MOUNTINFO} could not be read (${(err as NodeJS.ErrnoException).code ?? String(err)}); no Windows drive counts as a data store`);
  return [];
}

/** This process's StoreHost: its platform, env and home, and on Linux the Windows drives WSL mounts now. */
export function hostStoreHost(log: (line: string) => void = logLine): StoreHost {
  if (process.platform !== 'linux') return storeHost([]);
  try {
    // eslint-disable-next-line damocles/no-sync -- the permission gate's folder check decides synchronously and judges the mounts as they are now; /proc files are kernel memory
    return storeHost(windowsDriveMounts(readFileSync(MOUNTINFO, 'utf8')));
  } catch (err) {
    return storeHost(unreadMountinfo(err, log));
  }
}

/** hostStoreHost, reading the drive mounts without blocking. */
export async function hostStoreHostAsync(log: (line: string) => void = logLine): Promise<StoreHost> {
  if (process.platform !== 'linux') return storeHost([]);
  return storeHost(await fs.readFile(MOUNTINFO, 'utf8').then(windowsDriveMounts, (err: unknown) => unreadMountinfo(err, log)));
}

// The listed folders, each as spelled and as its realpath; complete is false when a failure other than a missing folder may
// pass.
interface Resolved {
  readonly folders: Pick<DataStores, 'stores' | 'ordinary'>;
  readonly complete: boolean;
}

const isShare = (folder: string): boolean => /^[\\/]{2}/.test(folder);

// The share path of a folder on a drive Windows maps to a network host ('' when it names no host), which realpath would reach.
function networkDriveSpelling(folder: string, platform: string): string | undefined {
  if (platform !== 'win32' || !/^[A-Za-z]:/.test(folder)) return undefined;
  const target = mappedDrivePath(`${folder.slice(0, 2)}\\`);
  if (target === null || !isShare(target)) return undefined;
  return target.startsWith('\\\\?\\') ? '' : `${target.replace(/\\+$/, '')}${folder.slice(2)}`;
}

// A folder's spellings: as listed and as its realpath, which a file's real path is compared with (a junctioned AppData, an 8.3
// TEMP); a share, or a drive mapped to one, as spelled and as its share path, since nothing here reaches a network host. A
// folder that cannot be resolved keeps its spelling, which denies only a path spelled as it is and only narrows a carve-out.
async function spellingsOf(folder: string, platform: string): Promise<{ readonly folder: string; readonly spellings: string[]; readonly failed?: string }> {
  if (isShare(folder)) return { folder, spellings: [folder] };
  try {
    const share = networkDriveSpelling(folder, platform);
    if (share !== undefined) return { folder, spellings: share === '' ? [folder] : [folder, share] };
    return { folder, spellings: [folder, await fs.realpath(folder)] };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { folder, spellings: [folder] };
    return { folder, spellings: [folder], failed: code ?? String(err) };
  }
}

// each folder and failure already logged, so a retry that fails the same way logs nothing
const loggedFailures = new Set<string>();

async function resolveAll(listed: DataStores, log: (line: string) => void): Promise<Resolved> {
  const each = (folders: readonly string[]) => Promise.all(folders.map((folder) => spellingsOf(folder, listed.platform)));
  const [stores, ordinary] = await Promise.all([each(listed.stores), each(listed.ordinary)]);
  const failures = [...stores, ...ordinary].filter((answer) => answer.failed !== undefined);
  for (const { folder, failed } of failures) {
    const id = `${folder}\n${failed}`;
    if (loggedFailures.has(id)) continue;
    loggedFailures.add(id);
    log(`[data-stores] ${folder} could not be resolved (${failed}); it is compared as spelled`);
  }
  return { folders: { stores: stores.flatMap((answer) => answer.spellings), ordinary: ordinary.flatMap((answer) => answer.spellings) }, complete: failures.length === 0 };
}

// the last answer, for the listing env, home and the drive mounts gave, and the resolution running, one at a time
let latest: { readonly key: string; readonly answer: Resolved; readonly at: number } | undefined;
let running: { readonly key: string; readonly answer: Promise<Resolved> } | undefined;

const keyOf = (listed: DataStores): string => JSON.stringify([listed.stores, listed.ordinary, listed.drives]);

// A resolution nothing awaits; its failure is logged.
function warm(listed: DataStores, key: string, log: (line: string) => void): void {
  resolve(listed, key, log).catch((err: unknown) => log(`[data-stores] resolving the data stores failed: ${String(err)}`));
}

function resolve(listed: DataStores, key: string, log: (line: string) => void): Promise<Resolved> {
  if (running?.key === key) return running.answer;
  const answer = resolveAll(listed, log).then((resolved) => {
    latest = { key, answer: resolved, at: Date.now() };
    return resolved;
  }).finally(() => {
    if (running?.answer === answer) running = undefined;
  });
  running = { key, answer };
  return answer;
}

// The listing's last answer, resolving it again once an incomplete one is STORE_RETRY_MS old; undefined when there is none.
function answerOf(listed: DataStores, key: string, log: (line: string) => void): Resolved | undefined {
  if (latest?.key !== key) return undefined;
  if (!latest.answer.complete && Date.now() - latest.at >= STORE_RETRY_MS) warm(listed, key, log);
  return latest.answer;
}

/** This process's data stores, each as spelled and as its realpath; drive mount points are real paths as mountinfo lists them. */
export async function hostDataStores(log: (line: string) => void): Promise<DataStores> {
  const listed = dataStoresOf(await hostStoreHostAsync(log));
  const key = keyOf(listed);
  return { ...listed, ...(answerOf(listed, key, log) ?? (await resolve(listed, key, log))).folders };
}

/** Starts resolving this process's data stores for the current listing, so a check that cannot await finds them resolved. */
export function warmHostDataStores(log: (line: string) => void = logLine): void {
  hostDataStores(log).catch((err: unknown) => log(`[data-stores] resolving the data stores failed: ${String(err)}`));
}

/**
 * hostDataStores for a check that cannot await: the last answer for the current listing, or, until it is resolved, each folder
 * as spelled only, which denies a path spelled as the store is but not one through the store's realpath, and only narrows a
 * carve-out. Never resolves a folder on this call.
 */
export function hostDataStoresSync(log: (line: string) => void = logLine): DataStores {
  const listed = dataStoresOf(hostStoreHost(log));
  const key = keyOf(listed);
  const answer = answerOf(listed, key, log);
  if (answer !== undefined) return { ...listed, ...answer.folders };
  warm(listed, key, log);
  return listed;
}

// An absolute path's segments below its root, '/' separated, as the preview deny list reads a project path.
const segmentsBelowRoot = (absolute: string): string => absolute.slice(path.parse(absolute).root.length).split(/[\\/]/).filter(Boolean).join('/');

// Why a linked preview file is refused, naming the first segment the deny list refuses on a real path or the data store.
async function linkRefusal(real: string, log: (line: string) => void): Promise<string | undefined> {
  const below = segmentsBelowRoot(real);
  if (isDeniedResolvedPath(below)) {
    const segments = below.split('/');
    const at = segments.findIndex((_segment, index) => isDeniedResolvedPath(segments.slice(0, index + 1).join('/')));
    return `through ${segments[at]}, which a preview never serves`;
  }
  const store = dataStoreOf(real, await hostDataStores(log));
  return store === undefined ? undefined : `into ${store}, where applications or the system keep their data`;
}

// the link roots whose refusal was logged
const loggedLinks = new Set<string>();

/**
 * Whether a preview file reached through a link that leaves its project is refused: its absolute real path `real` holds a
 * segment the deny list refuses on a real path or lies in a data store of this host. The first refusal under each link root
 * `linkRoot` is logged, naming the segment or store.
 */
export async function linkedPreviewRefused(real: string, linkRoot: string, log: (line: string) => void): Promise<boolean> {
  const refusal = await linkRefusal(real, log);
  if (refusal === undefined) return false;
  if (!loggedLinks.has(linkRoot)) {
    loggedLinks.add(linkRoot);
    log(`[html-preview] a link at ${linkRoot} leads ${refusal}; its files are not served`);
  }
  return true;
}
