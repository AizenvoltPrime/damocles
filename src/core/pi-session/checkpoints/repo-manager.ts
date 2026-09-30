import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log } from '../../logger';
import { folderKey } from '../../workspace-folders/folder-key';
import { writeFileAtomic, writeFileAtomicIfChanged } from './atomic-write';
import { exec, execSafe, ExecExitError, type TrackChild } from './exec';
import { pidAlive, withRepoLock, type LockOptions } from './lock';
import {
  buildExcludeFile,
  buildSnapshotMessage,
  categoryPatternFor,
  excludeLineForPath,
  isCategoryPattern,
  isSecurityExcluded,
  lstatFiles,
  readLfsPatterns,
  skipsFromCommitMessage,
  splitNul,
  summarizeSkipped,
  type SizedPath,
  type SkipItem,
} from './exclusions';
import { CHECKPOINT_EXCLUDE_VERSION_KEY, FOLDER_CHECKPOINT_EXCLUDE_SET, isHexCommit } from './types';
import type { CheckpointExcludeSet, ExecEnv, SafeCheckoutResult, SkippedFile, SkippedSummary } from './types';

/** Identity stamped on every checkpoint commit — purely cosmetic; these repos are never pushed. */
const COMMITTER_EMAIL = 'checkpoints@damocles.local';
const COMMITTER_NAME = 'Damocles Checkpoints';

/**
 * Config forced on every invocation against a checkpoint repo, and on the rewind preview. No line-ending
 * rewriting and no path quoting; executable bits are tracked except on win32, where the file system has
 * none. The user's global excludes, fsmonitor daemon and hooks never apply: snapshots and `clean -fd`
 * must not depend on the machine, and an `update-ref` must not run a `reference-transaction` hook.
 */
export const PORTABLE_CONFIG: readonly string[] = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  ...(process.platform === 'win32' ? ['-c', 'core.filemode=false'] : []),
  '-c',
  'core.quotepath=false',
  '-c',
  'core.longpaths=true',
  '-c',
  'core.excludesFile=',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
];

/**
 * Stage every blob over one byte straight into one pack per `add` instead of one loose object file
 * each, which costs about 5 ms per file on Windows. Only ever passed to `add` and `update-index`: set in
 * the repo config it would also switch off delta compression when gc repacks.
 */
export const BULK_ADD_CONFIG: readonly string[] = ['-c', 'core.bigFileThreshold=1'];

/**
 * `$GIT_DIR/info/attributes` of a folder repo, the highest-precedence attributes: the project's
 * `.gitattributes` never converts line endings, expands `$Id$` or runs a filter on a snapshot or a
 * restore, so both are byte-exact. `diff` is left alone so numstat still counts lines.
 */
export const FOLDER_REPO_ATTRIBUTES = '* -text -eol -ident -filter -working-tree-encoding\n';

/** Pathspecs handed to git by this module are file paths, never globs or magic. */
const LITERAL_PATHSPECS = '--literal-pathspecs';

/** The size state records every file over this many bytes, the smallest cap `maxFileSizeMB` allows. */
const SIZE_FLOOR_BYTES = 1024 * 1024;

/** A folder repo with this many packs gets a geometric repack after its next snapshot. */
export const PACK_COUNT_LIMIT = 50;

/** Registry of git processes spawned under the folder lock, one file per pid (`clearStaleGitLocks`). */
const GIT_PROCS_DIR = 'git-procs';

/** No checkpoint git command runs this long, so an older registry entry names a reused pid. */
const GIT_PROC_MAX_AGE_MS = 24 * 3_600_000;

/** Git lock files that only a command under the folder lock creates, relative to the git dir. */
const FOLDER_LOCKED_GIT_FILES = ['packed-refs.lock', 'HEAD.lock', 'config.lock', 'shallow.lock', 'gc.pid'];

const INIT_TMP_PREFIX = '.git-init-';

/** Repos whose geometric repack is running in this process. */
const consolidating = new Set<string>();

/**
 * The folder repo's record of file sizes: every file seen over `floorBytes`, so the size section for any
 * cap at or above the floor is derived without a rescan, and the embedded repositories that have no commit.
 */
interface SizeState {
  readonly floorBytes: number;
  readonly files: ReadonlyMap<string, number>;
  readonly embedded: readonly string[];
}

/** What `prepareSnapshot` decided for the snapshot about to be staged. */
export interface PreparedSnapshot {
  readonly sizeSkips: readonly SizedPath[];
  readonly lfsPatterns: readonly string[];
  readonly capBytes: number;
  readonly tracked: TrackedView;
}

/** What `stage` added beyond `add -A`: tracked files it captured, and the tracked files it left out. */
export interface StagedSnapshot {
  readonly files: number;
  readonly trackedSkips: readonly SkipItem[];
}

export interface SnapshotResult {
  readonly commit: string;
  readonly files: number;
  readonly skipped: SkippedSummary;
}

/** The project's own tracked files, and whether LFS classification applies to them. */
interface TrackedView {
  readonly paths: ReadonlySet<string>;
  readonly lfsActive: boolean;
}

/** Set the committer identity on a freshly created bare repo. */
async function configureIdentity(gitDir: string): Promise<void> {
  await exec('git', [`--git-dir=${gitDir}`, 'config', 'user.email', COMMITTER_EMAIL]);
  await exec('git', [`--git-dir=${gitDir}`, 'config', 'user.name', COMMITTER_NAME]);
}

function nulList(paths: Iterable<string>): string {
  return [...paths].map((p) => `${p}\0`).join('');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Matches the `core.ignorecase` a folder repo is created with. */
const IGNORE_CASE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * The index file of the git repository containing `workTree`, found the way git discovers it: the
 * nearest `.git` directory, or a `.git` file's `gitdir:`. Null when no ancestor has one.
 */
async function projectIndexFile(workTree: string): Promise<string | null> {
  let dir = path.resolve(workTree);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat: fs.Stats | null = null;
    try {
      stat = await fs.promises.stat(dotGit);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    }
    if (stat?.isDirectory()) return path.join(dotGit, 'index');
    if (stat?.isFile()) {
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.promises.readFile(dotGit, 'utf8'));
      if (match) return path.join(path.resolve(dir, match[1]!), 'index');
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The project's tracked list per work tree, reused while its index file is unchanged. */
const trackedCache = new Map<string, { stamp: string; paths: ReadonlySet<string> }>();

/**
 * Every path the project's own git tracks under `workTree`, relative to it. Read-only: `ls-files` never
 * writes the index or a ref, and fsmonitor stays off. No enclosing repository means an empty set; a
 * failed read is logged and read as empty. Submodule entries are directories, which no caller stages.
 */
async function projectTrackedFiles(workTree: string): Promise<ReadonlySet<string>> {
  const indexFile = await projectIndexFile(workTree);
  if (indexFile === null) return new Set();
  let stamp = `${indexFile}|none`;
  try {
    const stat = await fs.promises.stat(indexFile);
    stamp = `${indexFile}|${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = folderKey(workTree);
  const cached = trackedCache.get(key);
  if (cached?.stamp === stamp) return cached.paths;
  let paths: ReadonlySet<string>;
  try {
    paths = new Set(splitNul((await exec('git', ['-C', workTree, '-c', 'core.fsmonitor=false', 'ls-files', '-z'], undefined, workTree)).stdout));
  } catch (err) {
    log('[Checkpoints] reading the tracked files of %s failed, so none are captured beyond the exclude rules: %s', workTree, errorText(err));
    return new Set();
  }
  trackedCache.set(key, { stamp, paths });
  return paths;
}

/** The executable name of process `pid`, or null when no such process runs. */
async function processImage(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      return (await fs.promises.readFile(`/proc/${pid}/comm`, 'utf8')).trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
  if (process.platform === 'win32') {
    const out = (await exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])).stdout;
    const match = /^"([^"]+)","(\d+)"/m.exec(out);
    return match && Number(match[2]) === pid ? match[1]! : null;
  }
  const result = await execSafe('ps', ['-p', String(pid), '-o', 'comm=']);
  return result.ok && result.value.stdout.trim() ? path.basename(result.value.stdout.trim()) : null;
}

/** Whether a registered git child may still be running: its pid is alive and runs a git executable. */
async function gitProcessMayRun(pid: number): Promise<boolean> {
  if (!pidAlive(pid)) return false;
  let image: string | null;
  try {
    image = await processImage(pid);
  } catch (err) {
    log('[Checkpoints] cannot tell what process %d runs, so it counts as a live git: %s', pid, errorText(err));
    return true;
  }
  return image !== null && /^git(\.exe)?$/i.test(image);
}

/**
 * Owns one bare checkpoint repo whose work tree is the user's project directory: a legacy per-session
 * repo or a shared folder repo. Every git call is pinned to that repo via `GIT_DIR`/`GIT_WORK_TREE`/
 * `GIT_INDEX_FILE` and a fixed portable config, and runs with cwd set to the work tree. Mutating
 * operations run inside `withLock` so concurrent sessions and processes never interleave on the index.
 */
export class RepoManager {
  private readonly gitDir: string;
  private readonly workTree: string;
  private readonly repoDir: string;
  private readonly env: ExecEnv;
  /** Set while this instance holds the repo lock: its git children are then registered. */
  private holdsLock = false;
  /** Folder repos capture the project's tracked files; a legacy repo is never widened, so it captures none. */
  private readonly capturesTracked: boolean;

  constructor(gitDir: string, indexFile: string, workTree: string, options?: { capturesTracked?: boolean }) {
    this.gitDir = gitDir;
    this.workTree = workTree;
    this.repoDir = path.dirname(gitDir);
    this.env = { GIT_DIR: gitDir, GIT_WORK_TREE: workTree, GIT_INDEX_FILE: indexFile };
    this.capturesTracked = options?.capturesTracked ?? false;
  }

  /** Run a git subcommand against this repo with the portable config and pinned environment. */
  private git(
    args: string[],
    options?: { input?: string; env?: ExecEnv; config?: readonly string[] },
  ): Promise<{ stdout: string; stderr: string }> {
    return exec(
      'git',
      [...PORTABLE_CONFIG, ...(options?.config ?? []), ...args],
      options?.env ?? this.env,
      this.workTree,
      undefined,
      options?.input,
      this.holdsLock ? this.trackChild : undefined,
    );
  }

  /** Register a git child spawned under the lock for as long as it runs; the next holder reads the leftovers. */
  private readonly trackChild: TrackChild = (pid) => {
    const dir = path.join(this.repoDir, GIT_PROCS_DIR);
    const file = path.join(dir, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `${process.pid}\n`);
    return () => {
      try {
        fs.rmSync(file, { force: true });
      } catch (err) {
        log('[Checkpoints] could not deregister git process %d: %s', pid, errorText(err));
      }
    };
  };

  /**
   * Serialize `fn` against this repo's on-disk lock so index/commit operations never interleave. Leftover
   * git locks are cleared first (`clearStaleGitLocks`). `signal` bounds only the wait for the lock.
   */
  withLock<T>(fn: () => Promise<T>, options?: Pick<LockOptions, 'signal'>): Promise<T> {
    return withRepoLock(
      this.repoDir,
      async (hold) => {
        this.holdsLock = true;
        try {
          await this.clearStaleGitLocks(hold.tookOver);
          return await fn();
        } finally {
          this.holdsLock = false;
        }
      },
      options,
    );
  }

  /**
   * Remove git lock files no live git process can hold. Every git command that creates the index,
   * ref, `packed-refs`, `HEAD`, `config` or `shallow` lock of this repo runs under the repo lock, which
   * we now hold, and is registered in `git-procs` while it runs. A holder that released normally awaited
   * all of its children, so a lock file is stale unless a registered child of a dead holder still runs;
   * then nothing is removed. `refs/**.lock` is walked only on evidence of a dead holder: a takeover or a
   * leftover registration.
   */
  private async clearStaleGitLocks(tookOver: boolean): Promise<void> {
    const procsDir = path.join(this.repoDir, GIT_PROCS_DIR);
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(procsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    let deadHolder = tookOver;
    const running: number[] = [];
    for (const name of names) {
      const file = path.join(procsDir, name);
      const pid = Number(name);
      let age: number;
      try {
        age = Date.now() - (await fs.promises.stat(file)).mtimeMs;
      } catch (err) {
        // A git spawned by this instance off the lock (a pack roll-up) deregisters when it exits.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      if (Number.isInteger(pid) && pid > 0 && age < GIT_PROC_MAX_AGE_MS && (await gitProcessMayRun(pid))) {
        running.push(pid);
        continue;
      }
      await fs.promises.rm(file, { force: true });
      deadHolder = true;
    }
    if (running.length > 0) {
      log('[Checkpoints] git processes %s of an earlier lock holder of %s still run; leftover git locks are kept', running.join(', '), this.repoDir);
      return;
    }
    const candidates = [`${this.env.GIT_INDEX_FILE}.lock`, ...FOLDER_LOCKED_GIT_FILES.map((name) => path.join(this.gitDir, name))];
    if (deadHolder) {
      try {
        const refs = await fs.promises.readdir(path.join(this.gitDir, 'refs'), { recursive: true });
        candidates.push(...refs.filter((rel) => rel.endsWith('.lock')).map((rel) => path.join(this.gitDir, 'refs', rel)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    for (const file of candidates) {
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.promises.lstat(file)).mtimeMs;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      await fs.promises.rm(file, { force: true });
      log('[Checkpoints] removed the stale git lock %s (%d s old): no git process that could hold it is running', file, Math.round((Date.now() - mtimeMs) / 1000));
    }
  }

  /** True once `git init --bare` has produced a usable repo (HEAD present). */
  private isInitialized(): boolean {
    return fs.existsSync(path.join(this.gitDir, 'HEAD'));
  }

  /**
   * `ensureReady`, `seedFromSourceRepo` and `checkpoint` build the per-session layout that v2 entries
   * point into. No production path creates one any more; they are kept as the legacy fixture builder.
   *
   * Lazily create a per-session bare repo on first use: `git init --bare`, stamp the committer
   * identity, and write the exclude patterns into `info/exclude`. Idempotent — once the repo exists
   * this only refreshes the exclude file when patterns are supplied.
   *
   * A plain array is written verbatim. A `CheckpointExcludeSet` is version-gated: a repo this call
   * creates is stamped with the set's version and gets `patterns`, and every older repo gets
   * `legacyPatterns`. Widening an existing repo's exclude set is not safe, because a rewind to a
   * checkpoint taken under the older set deletes whatever the newer set started tracking.
   */
  async ensureReady(exclude?: readonly string[] | CheckpointExcludeSet): Promise<void> {
    let created = false;
    if (!this.isInitialized()) {
      await fs.promises.mkdir(this.gitDir, { recursive: true });
      await exec('git', ['init', '--bare', this.gitDir]);
      await configureIdentity(this.gitDir);
      await this.tuneForLargeRepos(this.gitDir);
      await this.seedFromSourceRepo();
      created = true;
    }
    if (exclude === undefined) return;
    const patterns = 'patterns' in exclude ? await this.resolveExcludeSet(exclude, created) : exclude;
    await this.writeExcludeFile(`${patterns.join('\n')}\n`);
  }

  /**
   * Create the shared folder repo on first use and return its static exclude patterns. Unlike a
   * per-session repo it borrows nothing from the work tree's own git repo: no alternates, because the
   * user's gc could drop an object a checkpoint still needs, and no seeded index, because the user's
   * index records clean-filtered blobs (LFS pointers, autocrlf) against the smudged file's stat.
   *
   * The repo is built in a temp dir and renamed into place, so `isInitialized` never accepts one whose
   * identity, version stamp or attributes are missing. The caller holds the lock.
   */
  async ensureFolderRepo(folderPath: string): Promise<readonly string[]> {
    if (!this.isInitialized()) await this.initFolderRepo();
    const patterns = await this.resolveExcludeSet(FOLDER_CHECKPOINT_EXCLUDE_SET, false);
    await writeFileAtomicIfChanged(path.join(this.gitDir, 'info', 'attributes'), FOLDER_REPO_ATTRIBUTES);
    const folderJson = path.join(this.repoDir, 'folder.json');
    if (!fs.existsSync(folderJson)) {
      await writeFileAtomic(folderJson, `${JSON.stringify({ path: path.resolve(folderPath), layout: 1 }, null, 2)}\n`);
    }
    return patterns;
  }

  private async initFolderRepo(): Promise<void> {
    await fs.promises.mkdir(this.repoDir, { recursive: true });
    for (const name of await fs.promises.readdir(this.repoDir)) {
      if (!name.startsWith(INIT_TMP_PREFIX)) continue;
      log('[Checkpoints] removing %s, left by an interrupted folder repo init', path.join(this.repoDir, name));
      await fs.promises.rm(path.join(this.repoDir, name), { recursive: true, force: true });
    }
    const tmp = await fs.promises.mkdtemp(path.join(this.repoDir, INIT_TMP_PREFIX));
    await exec('git', ['init', '--bare', '--quiet', tmp]);
    await configureIdentity(tmp);
    await this.tuneForLargeRepos(tmp);
    // Excludes and paths match case-insensitively where the file system does.
    if (IGNORE_CASE) await exec('git', [`--git-dir=${tmp}`, 'config', 'core.ignorecase', 'true']);
    await exec('git', [`--git-dir=${tmp}`, 'config', '--local', CHECKPOINT_EXCLUDE_VERSION_KEY, String(FOLDER_CHECKPOINT_EXCLUDE_SET.version)]);
    await writeFileAtomic(path.join(tmp, 'info', 'attributes'), FOLDER_REPO_ATTRIBUTES);
    await fs.promises.rename(tmp, this.gitDir);
  }

  private async writeExcludeFile(content: string): Promise<void> {
    const infoDir = path.join(this.gitDir, 'info');
    await fs.promises.mkdir(infoDir, { recursive: true });
    await writeFileAtomicIfChanged(path.join(infoDir, 'exclude'), content);
  }

  /**
   * Pick the exclude patterns a version-gated set allows for this repo. On a repo this call just
   * created, stamp the version and use the current patterns. Otherwise read the stamp back: a missing
   * key makes `git config --get` exit non-zero, and an unparseable or older value is treated the same
   * way, so absence can never read as present. `--local` confines both to this repo's own config,
   * so a stray system or user setting cannot decide it.
   */
  private async resolveExcludeSet(set: CheckpointExcludeSet, created: boolean): Promise<readonly string[]> {
    if (created) {
      await exec('git', [`--git-dir=${this.gitDir}`, 'config', '--local', CHECKPOINT_EXCLUDE_VERSION_KEY, String(set.version)]);
      return set.patterns;
    }
    const probe = await execSafe('git', [`--git-dir=${this.gitDir}`, 'config', '--local', '--get', CHECKPOINT_EXCLUDE_VERSION_KEY]);
    if (!probe.ok) return set.legacyPatterns;
    const raw = probe.value.stdout.trim();
    // Digits only, so nothing this code could not have written reads as a stamp. A lenient parse would
    // accept `1.5` and `0x10` as version 1 and 16, handing the narrow set to a repo that never earned it.
    const stamped = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    return stamped >= set.version ? set.patterns : set.legacyPatterns;
  }

  /**
   * Index/scan tuning that keeps `git add -A` bounded on very large work trees, applied once to a
   * freshly created repo. `feature.manyFiles` switches on the compact v4 index plus the untracked
   * cache; `index.threads` parallelises index work. Best-effort — an old git that rejects a key just
   * leaves that knob at its default.
   */
  private async tuneForLargeRepos(gitDir: string): Promise<void> {
    const config: ReadonlyArray<readonly [string, string]> = [
      ['feature.manyFiles', 'true'],
      ['core.untrackedCache', 'true'],
      ['index.threads', 'true'],
    ];
    for (const [key, value] of config) {
      await execSafe('git', [`--git-dir=${gitDir}`, 'config', key, value]);
    }
  }

  /**
   * Share the work tree's real git object database so the first snapshot reuses already-hashed blobs
   * instead of re-hashing the entire tree — the cost that makes a cold checkpoint on a large repo take
   * many seconds. When the work tree is itself a git repo, point this bare repo's
   * `objects/info/alternates` at its object store (chasing the source's own alternates) and seed our
   * index from the source's so unchanged files are skipped via git's stat cache. Pure optimization:
   * any failure (no git repo, old git without `--path-format`, unreadable index) silently falls back
   * to a full hash on the next `git add`.
   */
  private async seedFromSourceRepo(): Promise<void> {
    const probe = await execSafe(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      undefined,
      this.workTree,
    );
    if (!probe.ok) return;
    const sourceGitDir = probe.value.stdout.trim();
    if (!sourceGitDir) return;
    const sourceObjects = path.join(sourceGitDir, 'objects');
    if (!fs.existsSync(sourceObjects)) return;

    let chained: string[] = [];
    try {
      const altText = await fs.promises.readFile(path.join(sourceObjects, 'info', 'alternates'), 'utf8');
      chained = altText.split('\n').map((line) => line.trim()).filter(Boolean);
    } catch {
      // No chained alternates declared by the source; the source object store alone is enough.
    }
    const alternates = [sourceObjects, ...chained].filter((dir) => fs.existsSync(dir));
    if (alternates.length === 0) return;

    const objectsInfo = path.join(this.gitDir, 'objects', 'info');
    await fs.promises.mkdir(objectsInfo, { recursive: true });
    await fs.promises.writeFile(path.join(objectsInfo, 'alternates'), `${alternates.join('\n')}\n`, 'utf8');

    // Seed the stat cache from the source index, but ONLY when the source uses a plain monolithic
    // index. A split-index source (`index.splitIndex=true`) keeps most entries in a `sharedindex.*`
    // companion that our bare repo doesn't have — copying just the `index` link file would leave a
    // dangling reference that fails the next `git add`. In that case we skip the seed (alternates
    // still give us object reuse; only the stat-cache fast path is forgone).
    const sourceIndex = path.join(sourceGitDir, 'index');
    const indexFile = this.env.GIT_INDEX_FILE;
    if (fs.existsSync(sourceIndex) && !fs.existsSync(indexFile) && !this.sourceUsesSplitIndex(sourceGitDir)) {
      await fs.promises.copyFile(sourceIndex, indexFile).catch(() => undefined);
    }
  }

  /** A split-index repo has one or more `sharedindex.<hash>` files alongside its `index`. */
  private sourceUsesSplitIndex(sourceGitDir: string): boolean {
    try {
      return fs.readdirSync(sourceGitDir).some((name) => name.startsWith('sharedindex.'));
    } catch {
      return false;
    }
  }

  /** Per-session repos only: stage every change in the work tree (additions, modifications, deletions). */
  async stageAll(): Promise<void> {
    await this.git(['add', '-A'], { config: BULK_ADD_CONFIG });
  }

  /**
   * Per-session repos only: commit the work tree on HEAD and return the new hash. The folder repo never
   * commits on HEAD, since a shared chain would keep every conversation's commits alive; it uses
   * `snapshot`.
   */
  async checkpoint(entryId: string): Promise<string> {
    await this.git(['add', '-A']);
    await this.git(['commit', '--allow-empty', '-m', `checkpoint ${entryId}`]);
    const head = await this.git(['rev-parse', 'HEAD']);
    return head.stdout.trim();
  }

  /**
   * Numstat diff of the staged index against `commitHash` (the staged-vs-commit delta). `--no-renames`
   * keeps each side of a rename as a separate add/delete with real line counts, rather than a single
   * `{old => new}` path that would leak into the rewind UI as a literal string.
   */
  async diffAgainst(commitHash: string): Promise<string> {
    const result = await this.git(['diff', '--no-renames', '--numstat', '--cached', commitHash]);
    return result.stdout;
  }

  private sizeStatePath(): string {
    return path.join(this.repoDir, 'size-excludes.json');
  }

  /** The size state, or null (a full rescan) when it is missing or unreadable; an unreadable one is logged. */
  private async readSizeState(): Promise<SizeState | null> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.sizeStatePath(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let parsed: { floorBytes?: unknown; files?: unknown; embedded?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch (err) {
      log('[Checkpoints] %s is not JSON, so every tracked file is rescanned: %s', this.sizeStatePath(), errorText(err));
      return null;
    }
    const files = parsed.files;
    const embedded = parsed.embedded;
    if (
      typeof parsed.floorBytes !== 'number' ||
      !Array.isArray(files) ||
      !files.every((f) => Array.isArray(f) && f.length === 2 && typeof f[0] === 'string' && typeof f[1] === 'number') ||
      !Array.isArray(embedded) ||
      !embedded.every((p) => typeof p === 'string')
    ) {
      log('[Checkpoints] %s is malformed, so every tracked file is rescanned', this.sizeStatePath());
      return null;
    }
    return { floorBytes: parsed.floorBytes, files: new Map(files as Array<[string, number]>), embedded: embedded as string[] };
  }

  /** The project's tracked files (none for a legacy repo), and whether LFS classification applies to them. */
  private async trackedView(lfsPatterns: readonly string[]): Promise<TrackedView> {
    return { paths: this.capturesTracked ? await projectTrackedFiles(this.workTree) : new Set(), lfsActive: lfsPatterns.length > 0 };
  }

  /** Of `paths`, those an LFS filter covers by the project's own attributes (`check-attr`, read-only). */
  private async projectLfsPaths(view: TrackedView, paths: readonly string[]): Promise<Set<string>> {
    if (!view.lfsActive || paths.length === 0) return new Set();
    const out = await exec(
      'git',
      ['-C', this.workTree, '-c', 'core.fsmonitor=false', 'check-attr', '-z', '--stdin', 'filter'],
      undefined,
      this.workTree,
      undefined,
      nulList(paths),
    );
    const fields = out.stdout.split('\0');
    const lfs = new Set<string>();
    for (let i = 0; i + 2 < fields.length; i += 3) {
      if (fields[i + 2] === 'lfs') lfs.add(fields[i]!);
    }
    return lfs;
  }

  /**
   * Of `paths` (index entries the repo's exclude rules ignore), those a snapshot captures anyway: the
   * project tracks them, no security, category, LFS or `protectedPaths` rule covers them, and the file
   * is a file or symlink not over `capBytes` now, or absent. `capBytes` null skips the lstat, for a caller
   * whose `protectedPaths` already name every file over the cap and whose index holds only files.
   */
  private async capturableAmong(view: TrackedView, paths: readonly string[], protectedPaths: ReadonlySet<string>, capBytes: number | null): Promise<Set<string>> {
    const tracked = paths.filter(
      (p) => view.paths.has(p) && !protectedPaths.has(p) && !isSecurityExcluded(p, IGNORE_CASE) && categoryPatternFor(p, IGNORE_CASE) === null,
    );
    const excluded = new Set<string>();
    if (capBytes !== null) {
      const files = await lstatFiles(this.workTree, tracked);
      for (const f of files) if (f.bytes > capBytes) excluded.add(f.path);
      // A directory now stands where the entry is; what it holds is not the tracked file.
      const fileSet = new Set(files.map((f) => f.path));
      for (const p of await this.existing(tracked)) if (!fileSet.has(p)) excluded.add(p);
    }
    const lfs = await this.projectLfsPaths(view, tracked);
    return new Set(tracked.filter((p) => !lfs.has(p) && !excluded.has(p)));
  }

  /**
   * After `add -A`: stage every tracked file the index lacks that no security, category, LFS, size or
   * `protectedPaths` rule covers, and return what those rules left out. `update-index` keeps the stat
   * cache, and with `-text` attributes and `BULK_ADD_CONFIG` it writes one pack.
   */
  private async stageTracked(
    view: TrackedView,
    capBytes: number,
    protectedPaths: ReadonlySet<string>,
    env?: ExecEnv,
  ): Promise<{ files: number; skips: SkipItem[] }> {
    const indexed = new Set(splitNul((await this.git(['ls-files', '-z', '--cached'], { ...(env ? { env } : {}) })).stdout));
    const missing = [...view.paths].filter((p) => !indexed.has(p) && !protectedPaths.has(p) && !isSecurityExcluded(p, IGNORE_CASE));
    if (missing.length === 0) return { files: indexed.size, skips: [] };
    const sizes = new Map((await lstatFiles(this.workTree, missing)).map((f) => [f.path, f.bytes]));
    const present = missing.filter((p) => sizes.has(p));
    const skips: SkipItem[] = [];
    const rest: string[] = [];
    for (const p of present) {
      const pattern = categoryPatternFor(p, IGNORE_CASE);
      if (pattern !== null) skips.push({ path: p, bytes: sizes.get(p)!, reason: 'category', pattern });
      else rest.push(p);
    }
    const lfs = await this.projectLfsPaths(view, rest);
    const capture: string[] = [];
    for (const p of rest) {
      const bytes = sizes.get(p)!;
      if (lfs.has(p)) skips.push({ path: p, bytes, reason: 'lfs', pattern: null });
      else if (bytes > capBytes) skips.push({ path: p, bytes, reason: 'size', pattern: null });
      else capture.push(p);
    }
    if (capture.length > 0) {
      await this.git([LITERAL_PATHSPECS, 'update-index', '--add', '-z', '--stdin'], {
        input: nulList(capture),
        config: BULK_ADD_CONFIG,
        ...(env ? { env } : {}),
      });
    }
    return { files: indexed.size + capture.length, skips };
  }

  /** Whether the git repository at `rel` (an embedded one) has a commit checked out. */
  private async embeddedHasCommit(rel: string): Promise<boolean> {
    try {
      await exec('git', ['-C', path.join(this.workTree, rel), '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', '-q', 'HEAD^{commit}']);
      return true;
    } catch (err) {
      if (err instanceof ExecExitError) return false;
      throw err;
    }
  }

  /**
   * Folder repo, under the lock, before staging: regenerate `info/exclude` (static set, the project's
   * `filter=lfs` patterns, every file over `capBytes`, and embedded repositories with no commit, which
   * `add -A` cannot stage) and drop from the index every tracked file that is now ignored and not
   * captured anyway (`capturableAmong`), since excludes never stop `add -A` from restaging a tracked file.
   *
   * Size candidates are the untracked and modified files (an unmodified tracked file still has the size
   * it was staged at) and every file the size state recorded; a missing state rescans every tracked
   * file. The state records sizes above a floor, so a different cap needs no rescan. Only lstat is
   * used; no file is read.
   */
  async prepareSnapshot(staticPatterns: readonly string[], capBytes: number): Promise<PreparedSnapshot> {
    const lfsPatterns = await readLfsPatterns(this.workTree);
    const previous = await this.readSizeState();
    const floorBytes = Math.min(SIZE_FLOOR_BYTES, capBytes);
    const known = previous ?? { floorBytes, files: new Map<string, number>(), embedded: [] };
    const overCap = (files: ReadonlyMap<string, number>): string[] => [...files].filter(([, bytes]) => bytes > capBytes).map(([p]) => p).sort();
    await this.writeExcludeFile(buildExcludeFile(staticPatterns, lfsPatterns, overCap(known.files), known.embedded));

    const listed = splitNul((await this.git(['ls-files', '-z', '--others', '--modified', '--exclude-standard'])).stdout);
    const candidates = new Set(listed.filter((p) => !p.endsWith('/')));
    for (const p of known.files.keys()) candidates.add(p);
    if (previous === null || capBytes < previous.floorBytes) {
      for (const p of splitNul((await this.git(['ls-files', '-z', '--cached'])).stdout)) candidates.add(p);
    }
    const embedded: string[] = [];
    for (const dir of new Set([...listed.filter((p) => p.endsWith('/')).map((p) => p.slice(0, -1)), ...known.embedded])) {
      if (!fs.existsSync(path.join(this.workTree, dir, '.git')) || (await this.embeddedHasCommit(dir))) continue;
      if (!known.embedded.includes(dir)) log('[Checkpoints] %s is a git repository with no commit, so snapshots leave it out', dir);
      embedded.push(dir);
    }
    const sizes = await lstatFiles(this.workTree, candidates);
    const files = new Map(sizes.filter((f) => f.bytes > floorBytes).map((f) => [f.path, f.bytes]));
    const sizeSkips = sizes.filter((f) => f.bytes > capBytes);
    const sizePaths = overCap(files);
    embedded.sort();
    await this.writeExcludeFile(buildExcludeFile(staticPatterns, lfsPatterns, sizePaths, embedded));
    await writeFileAtomic(this.sizeStatePath(), `${JSON.stringify({ floorBytes, files: [...files], embedded })}\n`);

    const tracked = await this.trackedView(lfsPatterns);
    const trackedIgnored = splitNul((await this.git(['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'])).stdout);
    // The size section names every file over the cap, including a tracked one modified since it was staged.
    const kept = await this.capturableAmong(tracked, trackedIgnored, new Set(sizePaths), null);
    await this.removeFromIndex(trackedIgnored.filter((p) => !kept.has(p)));
    return { sizeSkips, lfsPatterns, capBytes, tracked };
  }

  /**
   * Drop the given paths from an index; the work tree is never touched. `update-index --force-remove`
   * rather than `rm --cached`, which refuses a path whose staged content differs from the file.
   */
  private async removeFromIndex(paths: readonly string[], env?: ExecEnv): Promise<void> {
    if (paths.length === 0) return;
    await this.git(['update-index', '-z', '--force-remove', '--stdin'], { input: nulList(paths), ...(env ? { env } : {}) });
  }

  /** Stage the work tree after `prepareSnapshot`: `add -A`, then the project's tracked files the excludes drop. */
  async stage(prepared: PreparedSnapshot): Promise<StagedSnapshot> {
    await this.git(['add', '-A'], { config: BULK_ADD_CONFIG });
    const staged = await this.stageTracked(prepared.tracked, prepared.capBytes, new Set());
    return { files: staged.files, trackedSkips: staged.skips };
  }

  /** Every path a snapshot recorded as over the cap, from `prepareSnapshot` and from the tracked capture. */
  private static sizeSkipPaths(prepared: PreparedSnapshot, staged: StagedSnapshot): string[] {
    return [...prepared.sizeSkips.map((f) => f.path), ...staged.trackedSkips.filter((s) => s.reason === 'size').map((s) => s.path)];
  }

  /**
   * Stage the work tree and write a parentless commit without touching HEAD, plus the manifest blob of
   * everything the snapshot left out. Only refs the caller writes keep either alive.
   */
  async snapshot(subject: string, prepared: PreparedSnapshot): Promise<SnapshotResult> {
    const staged = await this.stage(prepared);
    const tree = (await this.git(['write-tree'])).stdout.trim();
    const message = buildSnapshotMessage(subject, RepoManager.sizeSkipPaths(prepared, staged), prepared.lfsPatterns);
    const commit = (await this.git(['commit-tree', tree, '-F', '-'], { input: message })).stdout.trim();
    const items: SkipItem[] = [
      ...[...prepared.sizeSkips].sort((a, b) => b.bytes - a.bytes).map((f): SkipItem => ({ path: f.path, bytes: f.bytes, reason: 'size', pattern: null })),
      ...(await this.listIgnored(prepared.lfsPatterns)),
      ...staged.trackedSkips,
    ];
    const { summary, files } = summarizeSkipped(items);
    const manifest = files.length > 0 ? await this.writeManifest(files) : null;
    return { commit, files: staged.files, skipped: { ...summary, manifest } };
  }

  /** Store the full skipped list as a blob; a ref the caller writes keeps it alive. */
  private async writeManifest(files: readonly SkippedFile[]): Promise<string> {
    return (await this.git(['hash-object', '-w', '--stdin'], { input: JSON.stringify({ v: 1, files }) })).stdout.trim();
  }

  /**
   * The skipped list a manifest blob holds. Runs without the lock: the blob is only read, and the ref
   * the caller's entry names keeps it alive. A blob of any other shape is an error.
   */
  async readManifest(manifest: string): Promise<SkippedFile[]> {
    if (!isHexCommit(manifest)) throw new Error(`not an object id: ${JSON.stringify(manifest)}`);
    const text = (await this.git(['cat-file', 'blob', manifest])).stdout;
    const parsed = JSON.parse(text) as { v?: unknown; files?: unknown };
    const files = parsed.files;
    const isRow = (f: unknown): f is SkippedFile => {
      if (typeof f !== 'object' || f === null) return false;
      const row = f as Record<string, unknown>;
      return (
        typeof row['path'] === 'string' &&
        (row['bytes'] === null || (typeof row['bytes'] === 'number' && Number.isFinite(row['bytes']))) &&
        (row['reason'] === 'size' || row['reason'] === 'category' || row['reason'] === 'lfs')
      );
    };
    if (parsed.v !== 1 || !Array.isArray(files) || !files.every(isRow)) throw new Error(`manifest ${manifest} has an unexpected shape`);
    return files;
  }

  /**
   * Commit the current index (after `prepareSnapshot` + `stage`) with `parent`; used for a turn's
   * after-state.
   */
  async commitIndex(subject: string, prepared: PreparedSnapshot, staged: StagedSnapshot, parent: string): Promise<string> {
    const tree = (await this.git(['write-tree'])).stdout.trim();
    const message = buildSnapshotMessage(subject, RepoManager.sizeSkipPaths(prepared, staged), prepared.lfsPatterns);
    return (await this.git(['commit-tree', tree, '-p', parent, '-F', '-'], { input: message })).stdout.trim();
  }

  /** The paths a snapshot's staging left out for size; a change list must not report them as deleted. */
  static sizeSkipped(prepared: PreparedSnapshot, staged: StagedSnapshot): Set<string> {
    return new Set(RepoManager.sizeSkipPaths(prepared, staged));
  }

  /**
   * Every category or LFS skip among the ignored paths, with the pattern that matched it. Only a match
   * whose source is this repo's `info/exclude` counts, so a project `.gitignore` line such as `*.mp4` is
   * the project's own ignore, not a skip. A directory a pattern matches is listed once (trailing `/`,
   * `bytes` null) instead of descended; a directory git collapsed only because all its contents are
   * ignored is descended, so `out/clip.mp4` is attributed to `*.mp4`. A directory that vanished or
   * cannot be read is logged and left out.
   */
  private async listIgnored(lfsPatterns: readonly string[]): Promise<SkipItem[]> {
    const lfs = new Set(lfsPatterns);
    let pending = splitNul(
      (await this.git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'])).stdout,
    );
    const matched: Array<{ path: string; pattern: string; reason: 'category' | 'lfs' }> = [];
    // `ls-files --directory` can list a collapsed directory and its contents both.
    const seen = new Set<string>();
    while (pending.length > 0) {
      const fields = (await this.checkIgnore(['-v', '--non-matching'], pending)).split('\0');
      const next: string[] = [];
      for (let i = 0; i + 3 < fields.length; i += 4) {
        const source = fields[i]!.replace(/\\/g, '/');
        const pattern = fields[i + 2]!;
        const rel = fields[i + 3]!;
        if (seen.has(rel)) continue;
        seen.add(rel);
        if (pattern && !pattern.startsWith('!')) {
          const reason = !source.endsWith('/info/exclude') ? null : isCategoryPattern(pattern) ? 'category' : lfs.has(pattern) ? 'lfs' : null;
          if (reason) matched.push({ pattern, path: rel, reason });
        } else if (!pattern && rel.endsWith('/')) {
          let children: fs.Dirent[];
          try {
            children = await fs.promises.readdir(path.join(this.workTree, rel), { withFileTypes: true });
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES' && code !== 'EPERM') throw err;
            log('[Checkpoints] cannot list %s (%s); its skipped files are not reported', rel, code);
            continue;
          }
          for (const child of children) next.push(`${rel}${child.name}${child.isDirectory() ? '/' : ''}`);
        }
      }
      pending = next;
    }
    const sizes = new Map((await lstatFiles(this.workTree, matched.filter((m) => !m.path.endsWith('/')).map((m) => m.path))).map((f) => [f.path, f.bytes]));
    return matched.map((m) => ({ path: m.path, reason: m.reason, pattern: m.pattern, bytes: m.path.endsWith('/') ? null : (sizes.get(m.path) ?? 0) }));
  }

  /** `check-ignore -z --no-index --stdin` output for `paths`; exit 1 means none matched, which is an answer. */
  private async checkIgnore(flags: readonly string[], paths: readonly string[], config?: readonly string[]): Promise<string> {
    try {
      return (await this.git(['check-ignore', '-z', ...flags, '--no-index', '--stdin'], { input: nulList(paths), ...(config ? { config } : {}) })).stdout;
    } catch (err) {
      if (err instanceof ExecExitError && err.exitCode === 1) return '';
      throw err;
    }
  }

  /** Point each ref at its object in one transaction. */
  async updateRefs(updates: ReadonlyArray<{ ref: string; commit: string }>): Promise<void> {
    if (updates.length === 0) return;
    for (const u of updates) {
      if (!isHexCommit(u.commit)) throw new Error(`refusing to point ${u.ref} at a non-object: ${u.commit}`);
    }
    await this.git(['update-ref', '--stdin'], { input: updates.map((u) => `update ${u.ref} ${u.commit}\n`).join('') });
  }

  async deleteRefs(refs: readonly string[]): Promise<void> {
    if (refs.length === 0) return;
    await this.git(['update-ref', '--stdin'], { input: refs.map((r) => `delete ${r}\n`).join('') });
  }

  /** Refs under `prefix` with their object and committer time (unix seconds; 0 for a ref to a blob). */
  async listRefs(prefix: string): Promise<Array<{ ref: string; commit: string; committedAt: number }>> {
    const out = await this.git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:unix)', prefix]);
    return out.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const [ref, commit, time] = line.split('\0');
        return { ref: ref!, commit: commit!, committedAt: Number(time) || 0 };
      });
  }

  /** Whether `id` names an object of `type` in this repo. */
  async objectExists(id: string, type: 'commit' | 'blob'): Promise<boolean> {
    if (!isHexCommit(id)) return false;
    try {
      await this.git(['cat-file', '-e', `${id}^{${type}}`]);
      return true;
    } catch (err) {
      if (err instanceof ExecExitError) return false;
      throw err;
    }
  }

  async commitExists(commit: string): Promise<boolean> {
    return this.objectExists(commit, 'commit');
  }

  /**
   * Maintenance under the lock, before the repack: keep the shared index's objects alive through one ref
   * (the index is also a reachability root, since every git call names it) and pack the loose refs.
   */
  async prepareCollection(): Promise<void> {
    const tree = (await this.git(['write-tree'])).stdout.trim();
    const indexCommit = (await this.git(['commit-tree', tree, '-m', 'damocles shared index'])).stdout.trim();
    await this.updateRefs([{ ref: 'refs/damocles/index', commit: indexCommit }]);
    await this.git(['pack-refs', '--all', '--prune']);
  }

  /**
   * Without the repo lock: pack every reachable object into one pack and turn unreachable packed objects
   * loose. Deletes no object that is not in the new pack or loose (docs/invariants.md, "Checkpoints").
   */
  async repackAll(): Promise<void> {
    await withRepoLock(path.join(this.repoDir, 'repack'), async () => {
      await this.git(['repack', '-A', '-d', '-l', '-q']);
    });
  }

  /** Under the repo lock, where no writer runs: delete unreachable loose objects older than an hour. */
  async pruneUnreachable(): Promise<void> {
    await this.git(['prune', '--expire=1.hour.ago']);
  }

  /**
   * Without the repo lock: roll small packs up geometrically once there are `PACK_COUNT_LIMIT` of them.
   * Copies every object of the packs it replaces, so it deletes none. Failures are logged.
   */
  async consolidatePacksIfCrowded(): Promise<void> {
    const key = folderKey(this.repoDir);
    if (consolidating.has(key)) return;
    let packs: number;
    try {
      packs = (await fs.promises.readdir(path.join(this.gitDir, 'objects', 'pack'))).filter((f) => f.endsWith('.pack')).length;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (packs < PACK_COUNT_LIMIT) return;
    consolidating.add(key);
    try {
      await withRepoLock(path.join(this.repoDir, 'repack'), async () => {
        await this.git(['repack', '-d', '-l', '-q', '--geometric=2']);
      });
      log('[Checkpoints] rolled up %d packs of %s', packs, this.repoDir);
    } catch (err) {
      log('[Checkpoints] rolling up the packs of %s failed: %s', this.repoDir, errorText(err));
    } finally {
      consolidating.delete(key);
    }
  }

  /**
   * Clone an existing bare checkpoint repo to a new location (used when forking a session), then
   * restamp the committer identity so future checkpoints on the fork are attributed consistently.
   */
  static async cloneFrom(srcGitDir: string, dstGitDir: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(dstGitDir), { recursive: true });
    await exec('git', ['clone', '--local', '--bare', srcGitDir, dstGitDir]);
    await configureIdentity(dstGitDir);
  }

  /**
   * Null when this folder repo's `folder.json` names `cwd`, else why it does not. A restore or a manifest
   * read runs only for the folder the repo was made for.
   */
  async folderMismatch(cwd: string): Promise<string | null> {
    const file = path.join(this.repoDir, 'folder.json');
    let recorded: unknown;
    try {
      recorded = (JSON.parse(await fs.promises.readFile(file, 'utf8')) as { path?: unknown }).path;
    } catch (err) {
      return `the folder checkpoint repo has no readable folder.json (${errorText(err)})`;
    }
    if (typeof recorded !== 'string') return `${file} names no folder`;
    return folderKey(recorded) === folderKey(cwd) ? null : `the folder checkpoint repo belongs to ${recorded}, not ${cwd}`;
  }

  /** The skip paths and patterns `targetCommit` recorded, and the exclude lines protecting them. */
  private async targetSkips(targetCommit: string): Promise<{ paths: string[]; lines: string[] }> {
    const raw = (await this.git(['cat-file', 'commit', targetCommit])).stdout;
    const { paths, patterns } = skipsFromCommitMessage(raw.slice(raw.indexOf('\n\n') + 2));
    return { paths, lines: [...paths.map(excludeLineForPath), ...patterns] };
  }

  /** Paths of `paths` that exist in the work tree now, as any file type. */
  private async existing(paths: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const rel of paths) {
      try {
        await fs.promises.lstat(path.join(this.workTree, rel));
        out.push(rel);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      }
    }
    return out;
  }

  /**
   * The first path of `targetTree` that the index lacks and that an untracked file or directory stands
   * in the way of: a directory at the path, or a file where the path needs a directory. Every untracked
   * path is protected by now (all others were just staged), and `read-tree -u` deletes ignored files in
   * its way, so such a restore must not run.
   */
  private async blockedByUntracked(targetTree: string): Promise<string | null> {
    const missing = splitNul((await this.git(['diff-index', '-z', '--cached', '--name-only', '--no-renames', '--diff-filter=D', targetTree])).stdout);
    const kinds = new Map<string, 'dir' | 'file' | 'none'>();
    const kindOf = async (rel: string): Promise<'dir' | 'file' | 'none'> => {
      let kind = kinds.get(rel);
      if (kind === undefined) {
        try {
          kind = (await fs.promises.lstat(path.join(this.workTree, rel))).isDirectory() ? 'dir' : 'file';
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
          kind = 'none';
        }
        kinds.set(rel, kind);
      }
      return kind;
    };
    for (const rel of missing) {
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        if ((await kindOf(prefix)) !== 'file') continue;
        const tracked = (await this.git([LITERAL_PATHSPECS, 'ls-files', '-z', '--cached', '--', prefix])).stdout;
        if (tracked.length === 0) return rel;
      }
      if ((await kindOf(rel)) === 'dir') {
        const inside = (await this.git([LITERAL_PATHSPECS, 'ls-files', '-z', '--others', '--directory', '--', `${rel}/`])).stdout;
        if (inside.length > 0) return rel;
      }
    }
    return null;
  }

  /** `safeCheckoutLocked` under this repo's lock. */
  safeCheckout(targetCommit: string, options: { maxFileSizeBytes: number }): Promise<SafeCheckoutResult> {
    return this.withLock(() => this.safeCheckoutLocked(targetCommit, options));
  }

  /**
   * Restore the work tree to `targetCommit`, unconditionally (no dirty guard), without ever modifying,
   * deleting or restoring a protected file: one that is ignored now and not a tracked file a snapshot
   * captures anyway, over `capBytes` now, or recorded as skipped by the target snapshot. A path absent
   * now changes no existing bytes when it is recreated, so only protected paths that exist now are kept
   * out of the target. The caller holds the lock:
   *  1. Stage the current state with the protected paths ignored, drop tracked protected paths from the
   *     index, and write that tree as the rollback point.
   *  2. Build the target tree minus every protected path that exists now, in a throwaway index, and
   *     drop from the index every captured tracked file the target lacks, so it stays as it is.
   *  3. Refuse, touching nothing, when an untracked path stands where target' needs a file or directory
   *     (`blockedByUntracked`).
   *  4. `read-tree -u -m` onto target', then `clean -fd`: protected paths are in neither tree, and clean
   *     (never `-x`) leaves them alone because they are ignored for this operation.
   *  5. On failure, `read-tree -u --reset` onto the rollback tree (its paths all existed alongside the
   *     protected ones, so none is in its way) and `clean -fd`, with the same protection.
   * HEAD is never moved.
   */
  async safeCheckoutLocked(targetCommit: string, options: { maxFileSizeBytes: number }): Promise<SafeCheckoutResult> {
    if (!isHexCommit(targetCommit)) {
      return { ok: false, reason: 'checkout-failed', error: `refusing to reset to a non-commit ref: ${targetCommit}` };
    }
    const capBytes = options.maxFileSizeBytes;
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'damocles-restore-'));
    try {
      const protectFile = path.join(tmpDir, 'protect').replace(/\\/g, '/');
      let config: string[];
      let view: TrackedView;
      let protectedPaths: Set<string>;
      try {
        const present = splitNul((await this.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout);
        const overCap = (await lstatFiles(this.workTree, present)).filter((f) => f.bytes > capBytes).map((f) => f.path);
        const target = await this.targetSkips(targetCommit);
        await fs.promises.writeFile(protectFile, [...overCap.map(excludeLineForPath), ...target.lines].join('\n') + '\n', 'utf8');
        config = ['-c', `core.excludesFile=${protectFile}`];
        view = await this.trackedView(await readLfsPatterns(this.workTree));
        protectedPaths = new Set([...overCap, ...target.paths]);
      } catch (err) {
        return { ok: false, reason: 'checkout-failed', error: errorText(err) };
      }
      const ignoredInIndex = async (env?: ExecEnv): Promise<string[]> => {
        const ignored = splitNul((await this.git(['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], { config, ...(env ? { env } : {}) })).stdout);
        const captured = await this.capturableAmong(view, ignored, protectedPaths, capBytes);
        return ignored.filter((p) => !captured.has(p));
      };

      let rollbackTree: string;
      let targetTree: string;
      let cleanConfig: string[];
      try {
        // Before staging, so a tracked file over the cap is never hashed.
        await this.removeFromIndex(await ignoredInIndex());
        await this.git(['add', '-A'], { config: [...config, ...BULK_ADD_CONFIG] });
        await this.stageTracked(view, capBytes, protectedPaths);
        rollbackTree = (await this.git(['write-tree'])).stdout.trim();

        const tmpEnv: ExecEnv = { ...this.env, GIT_INDEX_FILE: path.join(tmpDir, 'index') };
        await this.git(['read-tree', targetCommit], { env: tmpEnv });
        await this.removeFromIndex(await this.existing(await ignoredInIndex(tmpEnv)), tmpEnv);
        targetTree = (await this.git(['write-tree'], { env: tmpEnv })).stdout.trim();
        // A tracked file the exclude rules drop and the target lacks may simply not have been tracked, or
        // not been readable, when the target was taken, so the restore leaves it where it is.
        const targetPaths = new Set(splitNul((await this.git(['ls-files', '-z', '--cached'], { env: tmpEnv })).stdout));
        const capturedNow = splitNul((await this.git(['ls-files', '-z', '--cached', '--ignored', '--exclude-standard'], { config })).stdout);
        await this.removeFromIndex(capturedNow.filter((p) => !targetPaths.has(p)));
        // `clean -fd` runs after `read-tree` may have removed or replaced a .gitignore, so it names every
        // path ignored now exactly. Only clean reads these lines: a directory line would also match a
        // target file entry at that path and hide it from `blockedByUntracked`.
        const ignoredNow = splitNul((await this.git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], { config })).stdout);
        const cleanFile = path.join(tmpDir, 'clean-protect').replace(/\\/g, '/');
        await fs.promises.writeFile(cleanFile, (await fs.promises.readFile(protectFile, 'utf8')) + ignoredNow.map(excludeLineForPath).join('\n') + '\n', 'utf8');
        cleanConfig = ['-c', `core.excludesFile=${cleanFile}`];
        const blocked = await this.blockedByUntracked(targetTree);
        if (blocked !== null) {
          return { ok: false, reason: 'checkout-failed', error: `cannot restore ${blocked}: files this checkpoint does not restore are in its way` };
        }
      } catch (err) {
        return { ok: false, reason: 'checkout-failed', error: errorText(err) };
      }

      try {
        // read-tree overwrites or deletes ignored files in its way; only the filtered targetTree and
        // blockedByUntracked keep it off protected paths.
        await this.git(['read-tree', '-u', '-m', targetTree]);
        await this.git(['clean', '-fd'], { config: cleanConfig });
        return { ok: true };
      } catch (err) {
        const error = errorText(err);
        try {
          await this.git(['read-tree', '-u', '--reset', rollbackTree]);
          await this.git(['clean', '-fd'], { config: cleanConfig });
          return { ok: false, reason: 'checkout-failed', error };
        } catch (rollbackErr) {
          return { ok: false, reason: 'checkout-failed', error, rollbackError: errorText(rollbackErr) };
        }
      }
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  }

  /**
   * For the rewind preview: stage the tracked files the excludes drop into the preview's throwaway index,
   * as a snapshot would. Runs without the lock.
   */
  async stageTrackedForPreview(env: ExecEnv, capBytes: number): Promise<void> {
    await this.stageTracked(await this.trackedView(await readLfsPatterns(this.workTree)), capBytes, new Set(), env);
  }

  /**
   * For the rewind preview: of `paths` (each changed between the work tree and `targetCommit`), the ones
   * a rewind to it leaves alone. Read-only; runs without the lock.
   */
  async protectedAmong(targetCommit: string, paths: readonly string[], capBytes: number): Promise<Set<string>> {
    const present = await this.existing(paths);
    if (present.length === 0) return new Set();
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'damocles-preview-'));
    try {
      const overCap = (await lstatFiles(this.workTree, present)).filter((f) => f.bytes > capBytes).map((f) => f.path);
      const target = await this.targetSkips(targetCommit);
      const protectFile = path.join(tmpDir, 'protect').replace(/\\/g, '/');
      await fs.promises.writeFile(protectFile, target.lines.join('\n') + '\n', 'utf8');
      const ignored = splitNul(await this.checkIgnore([], present, ['-c', `core.excludesFile=${protectFile}`]));
      const view = await this.trackedView(await readLfsPatterns(this.workTree));
      const captured = await this.capturableAmong(view, ignored, new Set([...overCap, ...target.paths]), capBytes);
      // As in `safeCheckoutLocked`: a captured tracked file the target lacks is left where it is.
      const inTarget = captured.size === 0 ? new Set<string>() : new Set(splitNul((await this.git(['ls-tree', '-r', '-z', '--name-only', targetCommit])).stdout));
      return new Set([...overCap, ...ignored.filter((p) => !captured.has(p) || !inTarget.has(p))]);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  }
}
