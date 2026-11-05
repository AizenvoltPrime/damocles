// The spellings of each local root's folder (docs/invariants.md "Desktop host", Documents): its open path, its realpath
// (a mapped drive's share, a subst drive's target) and on win32 the \\wsl$ / \\wsl.localhost alias of each.
import { folderKeyOn } from '../../../core/workspace-folders/folder-key';
import { authorityKeyOfProject, isAbsoluteOn, isInsideFolder, isUncOrDevicePath, rootHolding } from '../../../shared/project-location';
import type { Project } from '../../local-services/confine';
import { wslUncAlias } from '../remote/wsl/wsl-paths';

export interface RootSpellingsDeps {
  // this computer's OS, whose path rules a local root's spellings follow
  readonly os: NodeJS.Platform;
  // this computer's native realpath, the call confinement's realRootOf makes; undefined for a missing folder
  readonly realpath: (folder: string) => Promise<string | undefined>;
  readonly log: (line: string) => void;
}

// authority: the authority key of the roots asked about; os: the OS whose path rules its paths follow
export interface SpellingLocation {
  readonly authority: string;
  readonly os: NodeJS.Platform;
}

export interface SpellingMatch<R extends Project> {
  readonly root: R;
  // target's '/'-separated path in root
  readonly relativePath: string;
  // the spelling of root's folder that holds target
  readonly spelling: string;
  // the spelling comes from the root's realpath, which a remapped drive moves
  readonly computed: boolean;
}

interface Spelling {
  readonly path: string;
  readonly computed: boolean;
}

// A root's realpath is taken again at most this often after its last one settled, and a lookup waits this long for it
// before answering with what is known.
export const RETRY_AFTER_MS = 10_000;
export const RETRY_WAIT_MS = 5_000;

// One realpath attempt for a root; a later attempt or the root leaving replaces it, and its answer then lands nowhere.
interface Entry {
  readonly fsPath: string;
  state: 'resolving' | 'resolved' | 'failed';
  // the realpath when it differs from fsPath by folderKey; a new attempt keeps the last one until it answers
  real?: string;
  // no realpath of fsPath settled before this attempt, so the root's spellings are not known yet
  readonly first: boolean;
  // Date.now() when the attempt started, and when it settled
  readonly startedAt: number;
  settledAt?: number;
  settled?: Promise<void>;
}

// Whether entry's realpath settled at least RETRY_AFTER_MS before now, so it may be taken again.
function retryDue(entry: Entry, now: number): boolean {
  return entry.settledAt !== undefined && now - entry.settledAt >= RETRY_AFTER_MS;
}

// Whether entry's realpath is due again and may have changed since: it failed, or it named a computed spelling, which a
// drive remapped since names elsewhere.
function stale(entry: Entry, now: number): boolean {
  return (entry.state === 'failed' || (entry.state === 'resolved' && entry.real !== undefined)) && retryDue(entry, now);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasDotSegment(location: SpellingLocation, target: string): boolean {
  return target.split(location.os === 'win32' ? /[\\/]/ : '/').some((segment) => segment === '.' || segment === '..');
}

/**
 * Each local root's spellings, computed once per root by retain. holding and contains are synchronous and make no file system
 * call; match may also take a root's realpath again, never a call on the target.
 */
export class RootSpellings {
  private readonly deps: RootSpellingsDeps;
  // by root key
  private readonly entries = new Map<string, Entry>();
  // by folderKey, the realpath under way for each folder, which a root that left and came back joins instead of starting another
  private readonly inflight = new Map<string, { readonly real: Promise<string | undefined>; readonly startedAt: number }>();

  constructor(deps: RootSpellingsDeps) {
    this.deps = deps;
  }

  /**
   * Keeps the spellings of roots' local roots only: drops those of roots that left, and starts one realpath for each new root
   * and each whose last realpath failed at least RETRY_AFTER_MS ago. Settles once the realpaths it started have; it never rejects.
   */
  retain(roots: readonly Project[]): Promise<void> {
    const local = roots.filter((root) => authorityKeyOfProject(root.key) === 'local');
    const kept = new Set(local.map((root) => root.key));
    for (const key of [...this.entries.keys()]) if (!kept.has(key)) this.entries.delete(key);
    const now = Date.now();
    const started: Array<Promise<void>> = [];
    for (const root of local) {
      const entry = this.entries.get(root.key);
      if (entry?.fsPath !== root.fsPath || (entry.state === 'failed' && retryDue(entry, now))) started.push(this.resolve(root.key, root.fsPath));
    }
    return Promise.all(started).then(() => undefined);
  }

  /**
   * The deepest of roots whose folder holds target below it in any spelling, as written (rootHolding), with target's relative
   * path and the spelling that matched; a remote authority's roots have their open path alone.
   */
  holding<R extends Project>(location: SpellingLocation, roots: readonly R[], target: string): SpellingMatch<R> | undefined {
    // the open path wins a tie, so a computed spelling never shadows a root that holds target as written
    const candidates = roots
      .flatMap((root) => this.spellingsOf(location, root).map((spelling) => ({ fsPath: spelling.path, computed: spelling.computed, root })))
      .sort((a, b) => Number(a.computed) - Number(b.computed));
    const held = rootHolding(location, candidates, target);
    return held && { root: held.root.root, relativePath: held.relativePath, spelling: held.root.fsPath, computed: held.root.computed };
  }

  /** Whether one of roots, in any spelling, is target or holds it; holding excludes the root itself. */
  contains(location: SpellingLocation, roots: readonly Project[], target: string): boolean {
    if (this.holding(location, roots, target)) return true;
    if (!isAbsoluteOn(location, target) || hasDotSegment(location, target)) return false;
    const key = folderKeyOn(location.os, target);
    return roots.some((root) => this.spellingsOf(location, root).some((spelling) => folderKeyOn(location.os, spelling.path) === key));
  }

  /**
   * holding, once more after waiting at most RETRY_WAIT_MS: for a path it finds no root for, while a root's first realpath is
   * under way; and on win32 after taking again the realpath of roots that failed or named a computed spelling, whose last one
   * settled at least RETRY_AFTER_MS ago (a drive offline or remapped since), when it finds no root for a UNC or device path,
   * which only a computed spelling can match, or finds one only through such a spelling.
   */
  async match<R extends Project>(location: SpellingLocation, roots: readonly R[], target: string): Promise<SpellingMatch<R> | undefined> {
    const held = this.holding(location, roots, target);
    if (held && !(held.computed && this.isStale(held.root))) return held;
    await this.retried(location, roots, target, held !== undefined);
    return this.holding(location, roots, target);
  }

  private isStale(root: Project): boolean {
    const entry = this.entries.get(root.key);
    return entry?.fsPath === root.fsPath && stale(entry, Date.now());
  }

  /**
   * Whether a match still names the file its root's confinement resolved to confinedPath: always through the open path, and
   * through a computed spelling only while confinedPath lies under it. Otherwise the drive was remapped since, so the root's
   * realpath is taken again, and the match holds nothing.
   */
  confirms<R extends Project>(match: SpellingMatch<R>, confinedPath: string): boolean {
    if (!match.computed) return true;
    const location = { os: this.deps.os };
    const alias = location.os === 'win32' ? wslUncAlias(match.spelling) : undefined;
    if ([match.spelling, ...(alias !== undefined ? [alias] : [])].some((spelling) => isInsideFolder(location, spelling, confinedPath))) return true;
    this.deps.log(`[spellings] ${confinedPath} lies outside ${match.spelling}, the realpath ${match.root.fsPath} had; resolving it again`);
    const entry = this.entries.get(match.root.key);
    if (entry?.fsPath === match.root.fsPath && entry.state !== 'resolving') void this.resolve(match.root.key, match.root.fsPath, { disproved: true });
    return false;
  }

  // Open path first, then the realpath; on win32 each followed by its WSL alias. A spelling another already names is left out.
  private spellingsOf(location: SpellingLocation, root: Project): Spelling[] {
    if (location.authority !== 'local') return [{ path: root.fsPath, computed: false }];
    const entry = this.entries.get(root.key);
    const real = entry?.fsPath === root.fsPath ? entry.real : undefined;
    const named: Spelling[] = [{ path: root.fsPath, computed: false }, ...(real !== undefined ? [{ path: real, computed: true }] : [])];
    const all = location.os === 'win32' ? named.flatMap((spelling) => {
      const alias = wslUncAlias(spelling.path);
      return alias === undefined ? [spelling] : [spelling, { path: alias, computed: spelling.computed }];
    }) : named;
    const seen = new Set<string>();
    return all.filter((spelling) => {
      const key = folderKeyOn(location.os, spelling.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Settles once the realpaths of roots it waits for did, or after RETRY_WAIT_MS: one under way for less than RETRY_WAIT_MS,
  // so a hung one holds no later lookup again (a root's first, or with retake any), or with retake a new one for a root whose
  // last settled at least RETRY_AFTER_MS ago. A root has at most one realpath in flight, since a hung one holds a thread of the
  // pool every fs call shares until the redirector gives up. Only roots retain listed have an entry, as retain sets each new
  // root's synchronously.
  private async retried(location: SpellingLocation, roots: readonly Project[], target: string, heldByComputed: boolean): Promise<void> {
    if (location.authority !== 'local') return;
    const retake = location.os === 'win32' && (heldByComputed || isUncOrDevicePath(target));
    const now = Date.now();
    const pending = roots.flatMap((root) => {
      const entry = this.entries.get(root.key);
      if (entry?.fsPath !== root.fsPath) return [];
      if (entry.state === 'resolving') return entry.settled && (retake || entry.first) && now - entry.startedAt < RETRY_WAIT_MS ? [entry.settled] : [];
      return retake && stale(entry, now) ? [this.resolve(root.key, root.fsPath)] : [];
    });
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, RETRY_WAIT_MS);
    });
    try {
      await Promise.race([Promise.all(pending), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  // disproved: the last realpath is known wrong, so its spelling is not kept until the new one answers
  private resolve(key: string, fsPath: string, opts: { readonly disproved?: boolean } = {}): Promise<void> {
    const folder = folderKeyOn(this.deps.os, fsPath);
    let attempt = this.inflight.get(folder);
    if (attempt === undefined) {
      const real = this.deps.realpath(fsPath).finally(() => this.inflight.delete(folder));
      attempt = { real, startedAt: Date.now() };
      this.inflight.set(folder, attempt);
    }
    const last = this.entries.get(key);
    const entry: Entry = { fsPath, state: 'resolving', startedAt: attempt.startedAt, first: last?.fsPath !== fsPath, ...(!opts.disproved && last?.fsPath === fsPath && last.real !== undefined ? { real: last.real } : {}) };
    this.entries.set(key, entry);
    entry.settled = this.settle(key, entry, attempt.real);
    return entry.settled;
  }

  private async settle(key: string, entry: Entry, attempt: Promise<string | undefined>): Promise<void> {
    const { fsPath } = entry;
    let real: string | undefined;
    try {
      real = await attempt;
    } catch (err) {
      this.deps.log(`[spellings] could not resolve ${fsPath}: ${errorText(err)}; its open path and alias stand until the next try`);
      if (this.entries.get(key) === entry) this.failed(entry);
      return;
    }
    if (this.entries.get(key) !== entry) return;
    if (real === undefined) {
      this.deps.log(`[spellings] ${fsPath} is missing; its open path and alias stand until the next try`);
      this.failed(entry);
      return;
    }
    entry.state = 'resolved';
    entry.settledAt = Date.now();
    if (folderKeyOn(this.deps.os, real) !== folderKeyOn(this.deps.os, fsPath)) entry.real = real;
    else delete entry.real;
  }

  // a realpath that cannot be taken confirms no spelling it named before
  private failed(entry: Entry): void {
    entry.state = 'failed';
    entry.settledAt = Date.now();
    delete entry.real;
  }
}
