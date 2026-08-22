import * as fs from 'fs';
import * as path from 'path';
import { exec, execSafe } from './exec';
import { withRepoLock } from './lock';
import { CHECKPOINT_EXCLUDE_VERSION_KEY, isHexCommit } from './types';
import type { CheckpointExcludeSet, ExecEnv, SafeCheckoutResult } from './types';

/** Identity stamped on every checkpoint commit — purely cosmetic; these repos are never pushed. */
const COMMITTER_EMAIL = 'checkpoints@damocles.local';
const COMMITTER_NAME = 'Damocles Checkpoints';

/**
 * Config flags forced on for every invocation. They neutralise line-ending rewriting, executable-bit
 * tracking, and path quoting so snapshots are byte-faithful and behave identically across platforms
 * (notably Windows checkouts of repos created elsewhere).
 */
const PORTABLE_CONFIG: readonly string[] = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'core.filemode=false',
  '-c',
  'core.quotepath=false',
  '-c',
  'core.longpaths=true',
  // Ignore the user's machine-global excludes file so snapshots (and `clean -fd`) are deterministic
  // across machines; the project's own .gitignore and our info/exclude still apply.
  '-c',
  'core.excludesFile=',
];

/** Set the committer identity on a freshly created bare repo. */
async function configureIdentity(gitDir: string): Promise<void> {
  await exec('git', [`--git-dir=${gitDir}`, 'config', 'user.email', COMMITTER_EMAIL]);
  await exec('git', [`--git-dir=${gitDir}`, 'config', 'user.name', COMMITTER_NAME]);
}

/**
 * Owns one session's private bare repo, whose work tree is the user's project directory. Every git
 * call is pinned to that repo via `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` and a fixed portable
 * config, and runs with cwd set to the work tree. Mutating operations should be wrapped in
 * `withLock` so concurrent sessions/processes don't corrupt the shared index.
 */
export class RepoManager {
  private readonly gitDir: string;
  private readonly workTree: string;
  private readonly repoDir: string;
  private readonly env: ExecEnv;

  constructor(gitDir: string, indexFile: string, workTree: string) {
    this.gitDir = gitDir;
    this.workTree = workTree;
    this.repoDir = path.dirname(gitDir);
    this.env = { GIT_DIR: gitDir, GIT_WORK_TREE: workTree, GIT_INDEX_FILE: indexFile };
  }

  /** Run a git subcommand against this repo with the portable config and pinned environment. */
  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return exec('git', [...PORTABLE_CONFIG, ...args], this.env, this.workTree);
  }

  /** Serialize `fn` against this repo's on-disk lock so index/commit operations never interleave. */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withRepoLock(this.repoDir, fn);
  }

  /** True once `git init --bare` has produced a usable repo (HEAD present). */
  private isInitialized(): boolean {
    return fs.existsSync(path.join(this.gitDir, 'HEAD'));
  }

  /**
   * Lazily create the bare repo on first use: `git init --bare`, stamp the committer identity, and
   * write the exclude patterns into `info/exclude`. Idempotent — once the repo exists this only
   * refreshes the exclude file when patterns are supplied.
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
      await this.tuneForLargeRepos();
      await this.seedFromSourceRepo();
      created = true;
    }
    if (exclude === undefined) return;
    const patterns = 'patterns' in exclude ? await this.resolveExcludeSet(exclude, created) : exclude;
    const infoDir = path.join(this.gitDir, 'info');
    await fs.promises.mkdir(infoDir, { recursive: true });
    await fs.promises.writeFile(path.join(infoDir, 'exclude'), `${patterns.join('\n')}\n`, 'utf8');
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
  private async tuneForLargeRepos(): Promise<void> {
    const config: ReadonlyArray<readonly [string, string]> = [
      ['feature.manyFiles', 'true'],
      ['core.untrackedCache', 'true'],
      ['index.threads', 'true'],
    ];
    for (const [key, value] of config) {
      await execSafe('git', [`--git-dir=${this.gitDir}`, 'config', key, value]);
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

  /** Stage every change in the work tree (additions, modifications, deletions). */
  async stageAll(): Promise<void> {
    await this.git(['add', '-A']);
  }

  /**
   * Commit the current work-tree state and return the new HEAD hash. `--allow-empty` guarantees a
   * checkpoint commit even when nothing changed, so the bracketing-commit invariant always holds.
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
   * Restore the work tree to `targetCommit`. An explicit rewind restores unconditionally (no dirty
   * guard — that was intentionally dropped); recoverability comes from a best-effort safety commit of
   * the current state taken first. Under the repo lock:
   *  1. Take a best-effort safety commit of the current state so a botched restore can be undone.
   *  2. `reset --hard <target>` then `clean -fd` to drop files created after the target.
   *  3. On restore failure, roll back to the safety commit and report both errors.
   */
  safeCheckout(targetCommit: string): Promise<SafeCheckoutResult> {
    return this.withLock(async () => {
      if (!isHexCommit(targetCommit)) {
        return { ok: false, reason: 'checkout-failed', error: `refusing to reset to a non-commit ref: ${targetCommit}` };
      }
      let safetyHash: string | undefined;
      try {
        await this.git(['add', '-A']);
        await this.git(['commit', '--allow-empty', '-m', `safety ${Date.now()}`]);
        const head = await this.git(['rev-parse', 'HEAD']);
        safetyHash = head.stdout.trim();
      } catch {
        // No safety net available; the restore still proceeds, just without rollback capability.
      }

      try {
        await this.git(['reset', '--hard', targetCommit]);
        await this.git(['clean', '-fd']);
        return safetyHash ? { ok: true, safetyHash } : { ok: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (safetyHash) {
          try {
            await this.git(['reset', '--hard', safetyHash]);
            await this.git(['clean', '-fd']);
            return { ok: false, reason: 'checkout-failed', error };
          } catch (rollbackErr) {
            const rollbackError = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
            return { ok: false, reason: 'checkout-failed', error, rollbackError };
          }
        }
        return { ok: false, reason: 'checkout-failed', error };
      }
    });
  }
}
