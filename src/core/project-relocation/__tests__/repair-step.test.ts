import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveGitExecutable } from '../../git-executable';
import { folderKey } from '../../workspace-folders/folder-key';
import { runRepairStep, type RepairGitResult, type RepairStepDeps, type RepairStepInput } from '../steps/repair';

// Real git in temp repositories: the step runs `git worktree repair` against links a move broke, as a relocation leaves them.
const GIT = resolveGitExecutable();
const A = 'aaaa1111';
const B = 'bbbb2222';
const GONE = 'cccc3333';

let sandbox: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'repair-step-')));
  const config = path.join(sandbox, 'neutral.gitconfig');
  fs.writeFileSync(config, '[user]\n\tname = Repair Tests\n\temail = repair@damocles.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
  env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('GIT_')) delete env[key];
  // never the developer's or the system's config, never an editor or a credential prompt
  Object.assign(env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: sandbox, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' });
});

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(GIT!, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const gitWorks = (cwd: string): boolean => spawnSync(GIT!, ['status', '--porcelain'], { cwd, env, encoding: 'utf8' }).status === 0;

/** The folder keys `git worktree list` in `repo` names, sorted. */
const listed = (repo: string): string[] => git(repo, 'worktree', 'list', '--porcelain').split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => folderKey(path.resolve(line.slice('worktree '.length)))).sort();
const keys = (...folders: string[]): string[] => folders.map((folder) => folderKey(folder)).sort();

interface Recorder {
  readonly calls: Array<{ readonly args: readonly string[]; readonly cwd: string }>;
  trusted: boolean;
  readonly deps: RepairStepDeps;
}

// The host's git: the absolute executable, argv only, no shell, GIT_EDITOR=true and GIT_TERMINAL_PROMPT=0.
function recorder(trusted: boolean): Recorder {
  const calls: Recorder['calls'] = [];
  const self: Recorder = {
    calls,
    trusted,
    deps: {
      isTrusted: () => self.trusted,
      git: (args, cwd) => {
        calls.push({ args: [...args], cwd });
        return new Promise<RepairGitResult>((resolve, reject) => {
          const child = spawn(GIT!, [...args], { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
          child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
          child.once('error', reject);
          child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
        });
      },
    },
  };
  return self;
}

function commit(repo: string): void {
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'first');
}

function newRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '--template=', '-b', 'main');
  commit(dir);
  return dir;
}

function move(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

/** A case's folders: the repository moves from old/ to new/, and its chat worktrees stay in wt/, as a relocation leaves them. */
function layout(name: string) {
  const base = path.join(sandbox, name);
  return {
    base,
    oldRepo: path.join(base, 'old', 'acme'),
    newRepo: path.join(base, 'new', 'acme'),
    worktrees: path.join(base, 'wt'),
  };
}

const input = (project: string, repository: string | undefined, worktreesDir: string, ids: readonly string[]): RepairStepInput => ({
  project, repository, worktrees: ids.map((worktreeId) => ({ worktreeId, root: path.join(worktreesDir, worktreeId) })), log: () => undefined,
});

describe.skipIf(GIT === undefined)('repair step against real git (needs git in an absolute PATH folder)', () => {
  it('re-links a moved repository to its two chat worktrees in place in one git call, skips a deleted one, and a rerun runs nothing', async () => {
    const at = layout('both');
    newRepo(at.oldRepo);
    for (const id of [A, B]) git(at.oldRepo, 'worktree', 'add', '-q', '-b', `chat-${id}`, path.join(at.worktrees, id));
    move(at.oldRepo, at.newRepo);
    for (const id of [A, B]) expect(gitWorks(path.join(at.worktrees, id)), `${id} is broken by the move`).toBe(false);

    const host = recorder(true);
    expect(await runRepairStep(input(at.newRepo, at.newRepo, at.worktrees, [A, B, GONE]), host.deps)).toEqual({ kind: 'done' });
    expect(host.calls).toEqual([{ args: ['worktree', 'repair', '--', path.join(at.worktrees, A), path.join(at.worktrees, B)], cwd: at.newRepo }]);
    for (const id of [A, B]) {
      expect(gitWorks(path.join(at.worktrees, id)), id).toBe(true);
      expect(git(path.join(at.worktrees, id), 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(`chat-${id}`);
    }
    expect(listed(at.newRepo)).toEqual(keys(at.newRepo, path.join(at.worktrees, A), path.join(at.worktrees, B)));

    // nothing is broken any more, so neither trust nor git is needed
    const again = recorder(false);
    expect(await runRepairStep(input(at.newRepo, at.newRepo, at.worktrees, [A, B, GONE]), again.deps)).toEqual({ kind: 'done' });
    expect(again.calls).toEqual([]);
  });

  it('waits untrusted without running git, and repairs once trust is granted', async () => {
    const at = layout('untrusted');
    newRepo(at.oldRepo);
    for (const id of [A, B]) git(at.oldRepo, 'worktree', 'add', '-q', '-b', `chat-${id}`, path.join(at.worktrees, id));
    move(at.oldRepo, at.newRepo);

    const host = recorder(false);
    const step = input(at.newRepo, at.newRepo, at.worktrees, [A, B]);
    expect(await runRepairStep(step, host.deps)).toEqual({ kind: 'waiting', failure: { code: 'untrusted', params: { count: 2 } } });
    expect(host.calls).toEqual([]);
    expect(gitWorks(path.join(at.worktrees, A))).toBe(false);

    host.trusted = true;
    expect(await runRepairStep(step, host.deps)).toEqual({ kind: 'done' });
    expect(host.calls).toHaveLength(1);
    for (const id of [A, B]) expect(gitWorks(path.join(at.worktrees, id)), id).toBe(true);
  });

  it('a project with no relocated repository has nothing to repair, and a repository that does not hold the project runs no git', async () => {
    const host = recorder(true);
    expect(await runRepairStep(input(path.join(sandbox, 'none'), undefined, path.join(sandbox, 'none-wt'), [A]), host.deps)).toEqual({ kind: 'done' });
    const elsewhere = path.join(sandbox, 'elsewhere');
    expect(await runRepairStep(input(path.join(sandbox, 'none'), elsewhere, path.join(sandbox, 'none-wt'), [A]), host.deps)).toEqual({ kind: 'waiting', failure: { code: 'repositoryLayout', params: { path: elsewhere } } });
    expect(host.calls).toEqual([]);
  });

  it('a fresh clone at the new path has no admin dirs: each worktree is recorded as not re-linked, its folder kept, and a retry answers the same', async () => {
    const at = layout('clone');
    const remote = path.join(at.base, 'remote.git');
    fs.mkdirSync(at.base, { recursive: true });
    git(at.base, 'init', '-q', '--bare', '--template=', '-b', 'main', remote);
    newRepo(at.oldRepo);
    git(at.oldRepo, 'push', '-q', remote, 'main');
    for (const id of [A, B]) git(at.oldRepo, 'worktree', 'add', '-q', '-b', `chat-${id}`, path.join(at.worktrees, id));
    fs.rmSync(at.oldRepo, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(at.newRepo), { recursive: true });
    git(path.dirname(at.newRepo), 'clone', '-q', '--template=', remote, at.newRepo);
    const files = (id: string): string[] => fs.readdirSync(path.join(at.worktrees, id)).sort();
    const before = [A, B].map(files);

    const notRelinked = {
      kind: 'waiting',
      failure: { code: 'repairFailed', params: { count: 2 } },
      repairFailures: [{ worktreeId: A, failure: { code: 'notRelinked' } }, { worktreeId: B, failure: { code: 'notRelinked' } }],
    };
    const host = recorder(true);
    const step = input(at.newRepo, at.newRepo, at.worktrees, [A, B]);
    expect(await runRepairStep(step, host.deps)).toEqual(notRelinked);
    expect(host.calls).toEqual([{ args: ['worktree', 'repair', '--', path.join(at.worktrees, A), path.join(at.worktrees, B)], cwd: at.newRepo }]);
    expect([A, B].map(files)).toEqual(before);
    expect(listed(at.newRepo)).toEqual(keys(at.newRepo));

    expect(await runRepairStep(step, host.deps)).toEqual(notRelinked);
    expect(host.calls).toHaveLength(2);
  });

  // the chat worktrees' admin dirs are in the main repository, which did not move, so only the project's own link breaks
  it('a project that is itself a linked worktree runs the repair inside itself and re-links itself, its chat worktrees still linked', async () => {
    const at = layout('linked');
    const main = newRepo(path.join(at.base, 'main'));
    git(main, 'worktree', 'add', '-q', '-b', 'project', at.oldRepo);
    for (const id of [A, B]) git(at.oldRepo, 'worktree', 'add', '-q', '-b', `chat-${id}`, path.join(at.worktrees, id));
    move(at.oldRepo, at.newRepo);
    // the main repository still holds the admin dirs, and the project's names its old place
    expect(listed(main)).toEqual(keys(main, at.oldRepo, path.join(at.worktrees, A), path.join(at.worktrees, B)));

    const host = recorder(true);
    expect(await runRepairStep(input(at.newRepo, at.newRepo, at.worktrees, [A, B]), host.deps)).toEqual({ kind: 'done' });
    expect(host.calls).toEqual([{ args: ['worktree', 'repair', '--', at.newRepo], cwd: at.newRepo }]);
    expect(listed(main)).toEqual(keys(main, at.newRepo, path.join(at.worktrees, A), path.join(at.worktrees, B)));
    for (const folder of [at.newRepo, ...[A, B].map((id) => path.join(at.worktrees, id))]) expect(gitWorks(folder), folder).toBe(true);
    expect(git(at.newRepo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('project');
  });
});
