import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepoManager } from '../repo-manager';
import { getGitDir, getIndexPath } from '../resolver';
import { parseDiffStats } from '../diff-parser';
import {
  CHECKPOINT_EXCLUDE_SET,
  CHECKPOINT_EXCLUDE_SET_VERSION,
  CHECKPOINT_EXCLUDE_VERSION_KEY,
  DEFAULT_CHECKPOINT_EXCLUDES,
  LEGACY_CHECKPOINT_EXCLUDES,
} from '../types';

/**
 * `.damocles` used to be excluded wholesale. Now that project skills and commands live there, an
 * agent-authored edit under `.damocles/skills` has to be snapshotted or a rewind silently leaves it
 * behind. The permission and MCP UIs write the three config files out of band, so those stay excluded:
 * a rewind must not revoke a grant made mid-turn.
 */
// Every case here drives real `git` subprocesses, several per test. The slowest is under 900 ms with
// the machine idle and over 2700 ms with six vitest workers competing for CPU, so the 5000 ms default
// is not a hang detector here, it is a load detector. This ceiling is generous against the measured
// cost and still far under a wedged git.
describe('checkpoint excludes for .damocles', { timeout: 20_000 }, () => {
  let root = '';
  let workTree = '';
  let repo: RepoManager;

  function write(rel: string, content: string): void {
    const full = path.join(workTree, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-damocles-'));
    const repoDir = path.join(root, 'repo');
    workTree = path.join(root, 'work');
    await fs.promises.mkdir(repoDir, { recursive: true });
    await fs.promises.mkdir(workTree, { recursive: true });
    repo = new RepoManager(getGitDir(repoDir), getIndexPath(repoDir), workTree);
    await repo.ensureReady(DEFAULT_CHECKPOINT_EXCLUDES);
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  /** Paths git reports as changed since `base`, using the exclude file written by ensureReady. */
  async function changedSince(base: string): Promise<string[]> {
    await repo.stageAll();
    return parseDiffStats(await repo.diffAgainst(base))
      .map((c) => c.path)
      .sort();
  }

  it('snapshots a file under .damocles/skills', async () => {
    write('seed.txt', 'seed\n');
    const base = await repo.checkpoint('u1');

    write('.damocles/skills/foo/SKILL.md', '---\nname: foo\ndescription: d\n---\n');
    expect(await changedSince(base)).toEqual(['.damocles/skills/foo/SKILL.md']);
  });

  it('snapshots a file under .damocles/commands', async () => {
    write('seed.txt', 'seed\n');
    const base = await repo.checkpoint('u1');

    write('.damocles/commands/bar.md', '---\ndescription: d\n---\n');
    expect(await changedSince(base)).toEqual(['.damocles/commands/bar.md']);
  });

  it.each([
    '.damocles/settings.json',
    '.damocles/settings.local.json',
    '.damocles/mcp.local.json',
  ])('does not snapshot %s', async (rel) => {
    write('seed.txt', 'seed\n');
    const base = await repo.checkpoint('u1');

    write(rel, '{}\n');
    expect(await changedSince(base)).toEqual([]);
  });

  it('keeps the config files out while snapshotting a skill edited in the same turn', async () => {
    write('seed.txt', 'seed\n');
    write('.damocles/skills/foo/SKILL.md', '---\nname: foo\ndescription: before\n---\n');
    const base = await repo.checkpoint('u1');

    write('.damocles/skills/foo/SKILL.md', '---\nname: foo\ndescription: after\n---\n');
    write('.damocles/settings.local.json', '{"granted":true}\n');
    expect(await changedSince(base)).toEqual(['.damocles/skills/foo/SKILL.md']);
  });

  it('no longer carries the blanket .damocles/** exclude', () => {
    expect(DEFAULT_CHECKPOINT_EXCLUDES).not.toContain('.damocles/**');
    expect(DEFAULT_CHECKPOINT_EXCLUDES).toContain('.damocles/settings.json');
    expect(DEFAULT_CHECKPOINT_EXCLUDES).toContain('.damocles/settings.local.json');
    expect(DEFAULT_CHECKPOINT_EXCLUDES).toContain('.damocles/mcp.local.json');
  });

  /**
   * A repo whose older checkpoints predate the narrowed set has no `.damocles/skills` in those trees.
   * `safeCheckout` stages everything and hard-resets to the target, so narrowing the set on such a repo
   * would make a rewind inside the retention window delete hand-written project skills.
   */
  describe('exclude-set version marker', () => {
    /** A shadow repo of its own, so a case controls whether the marker was ever stamped. */
    function freshRepo(name: string): { repo: RepoManager; gitDir: string } {
      const repoDir = path.join(root, name);
      const gitDir = getGitDir(repoDir);
      return { repo: new RepoManager(gitDir, getIndexPath(repoDir), workTree), gitDir };
    }

    function excludeLines(gitDir: string): string[] {
      return fs
        .readFileSync(path.join(gitDir, 'info', 'exclude'), 'utf8')
        .split('\n')
        .filter((line) => line !== '');
    }

    /** The stamped version, or null when the key is absent, which is what a pre-upgrade repo has. */
    function marker(gitDir: string): string | null {
      try {
        return execFileSync('git', [`--git-dir=${gitDir}`, 'config', '--local', '--get', CHECKPOINT_EXCLUDE_VERSION_KEY], {
          encoding: 'utf8',
        }).trim();
      } catch {
        return null;
      }
    }

    function setMarker(gitDir: string, value: string): void {
      execFileSync('git', [`--git-dir=${gitDir}`, 'config', '--local', CHECKPOINT_EXCLUDE_VERSION_KEY, value]);
    }

    it('stamps the marker and writes the narrow set on a repo it creates', async () => {
      const { repo: fresh, gitDir } = freshRepo('created');

      await fresh.ensureReady(CHECKPOINT_EXCLUDE_SET);

      expect(marker(gitDir)).toBe(String(CHECKPOINT_EXCLUDE_SET_VERSION));
      expect(excludeLines(gitDir)).toEqual([...DEFAULT_CHECKPOINT_EXCLUDES]);
    });

    it('writes the legacy blanket set on a repo created before the marker existed', async () => {
      const { repo: fresh, gitDir } = freshRepo('pre-upgrade');
      // The pre-2.22.0 call: a plain list, which stamps nothing.
      await fresh.ensureReady(LEGACY_CHECKPOINT_EXCLUDES);
      expect(marker(gitDir)).toBeNull();

      await fresh.ensureReady(CHECKPOINT_EXCLUDE_SET);

      expect(excludeLines(gitDir)).toEqual([...LEGACY_CHECKPOINT_EXCLUDES]);
      expect(excludeLines(gitDir)).toContain('.damocles/**');
      expect(marker(gitDir)).toBeNull();
    });

    it('leaves a pre-upgrade repo unmarked however many times ensureReady runs', async () => {
      const { repo: fresh, gitDir } = freshRepo('repeat');
      await fresh.ensureReady(LEGACY_CHECKPOINT_EXCLUDES);

      await fresh.ensureReady(CHECKPOINT_EXCLUDE_SET);
      await fresh.ensureReady(CHECKPOINT_EXCLUDE_SET);
      await fresh.ensureReady(CHECKPOINT_EXCLUDE_SET);

      expect(marker(gitDir)).toBeNull();
      expect(excludeLines(gitDir)).toEqual([...LEGACY_CHECKPOINT_EXCLUDES]);
    });

    it('writes the legacy set for a repo created with no exclude list at all', async () => {
      const { repo: fresh, gitDir } = freshRepo('no-exclude');
      await fresh.ensureReady();
      expect(marker(gitDir)).toBeNull();

      await fresh.ensureReady(CHECKPOINT_EXCLUDE_SET);

      expect(excludeLines(gitDir)).toEqual([...LEGACY_CHECKPOINT_EXCLUDES]);
    });

    it.each(['0', 'yes', '', '1.5'])('treats the unusable marker %j as absent', async (value) => {
      const { repo: fresh, gitDir } = freshRepo(`bad-marker-${value === '' ? 'empty' : value}`);
      await fresh.ensureReady(LEGACY_CHECKPOINT_EXCLUDES);
      setMarker(gitDir, value);

      await fresh.ensureReady(CHECKPOINT_EXCLUDE_SET);

      expect(excludeLines(gitDir)).toEqual([...LEGACY_CHECKPOINT_EXCLUDES]);
    });

    it('keeps the narrow set for a repo stamped ahead of the current version', async () => {
      const { repo: fresh, gitDir } = freshRepo('future');
      await fresh.ensureReady(LEGACY_CHECKPOINT_EXCLUDES);
      setMarker(gitDir, String(CHECKPOINT_EXCLUDE_SET_VERSION + 1));

      await fresh.ensureReady(CHECKPOINT_EXCLUDE_SET);

      expect(excludeLines(gitDir)).toEqual([...DEFAULT_CHECKPOINT_EXCLUDES]);
    });

    it('writes a plain list verbatim and stamps nothing', async () => {
      const { repo: fresh, gitDir } = freshRepo('plain-list');

      await fresh.ensureReady(['.git']);

      expect(excludeLines(gitDir)).toEqual(['.git']);
      expect(marker(gitDir)).toBeNull();
    });

    // The consequence the marker exists for: on a pre-upgrade repo a project skill stays out of the
    // snapshot, so no rewind to an older checkpoint can delete it.
    it('does not snapshot .damocles/skills on a pre-upgrade repo', async () => {
      const { repo: fresh } = freshRepo('rewind-safety');
      await fresh.ensureReady(LEGACY_CHECKPOINT_EXCLUDES);
      await fresh.ensureReady(CHECKPOINT_EXCLUDE_SET);

      write('seed.txt', 'seed\n');
      const base = await fresh.checkpoint('u1');

      write('.damocles/skills/foo/SKILL.md', '---\nname: foo\ndescription: d\n---\n');
      await fresh.stageAll();
      expect(parseDiffStats(await fresh.diffAgainst(base)).map((c) => c.path)).toEqual([]);
    });
  });
});
