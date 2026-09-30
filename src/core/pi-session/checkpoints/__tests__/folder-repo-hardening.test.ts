import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface ExecCall {
  readonly argv: readonly string[];
  readonly input: string | undefined;
}

const probe = vi.hoisted(() => ({
  calls: [] as ExecCall[],
  fail: null as ((argv: readonly string[], input: string | undefined) => boolean) | null,
  hold: null as { match: (argv: readonly string[]) => boolean; gate: Promise<void>; entered: () => void } | null,
}));

// Records every git call, and fails or pauses a chosen one.
vi.mock('../exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exec')>();
  return {
    ...actual,
    exec: async (...args: Parameters<typeof actual.exec>) => {
      const argv = args[1];
      probe.calls.push({ argv, input: args[5] });
      if (probe.fail?.(argv, args[5])) throw new Error(`injected failure of git ${argv.filter((a) => !a.startsWith('-c') && !a.includes('=')).join(' ')}`);
      const hold = probe.hold;
      if (hold?.match(argv)) {
        hold.entered();
        await hold.gate;
      }
      return actual.exec(...args);
    },
  };
});

import { AutoCheckpointProducer } from '../auto-checkpoint';
import { copyCheckpointRefs, deleteSessionCheckpointRefs, folderIdsInSessionFile, readSkippedManifest } from '../folder-repo';
import { runCheckpointMaintenance } from '../maintenance';
import { PACK_COUNT_LIMIT, RepoManager } from '../repo-manager';
import { folderIdFor, getFolderRepoDir, getGitDir, getIndexPath, getRepoDir } from '../resolver';
import { CHECKPOINT_EXCLUDE_SET } from '../types';
import type { CheckpointEntryV2, CheckpointEntryV3, CheckpointRecord, PreRewindRecord, RestoreResult } from '../types';

const MB = 1024 * 1024;
let root: string;
let cwd: string;
let cap = MB;
let turn = 0;

function sessionFile(name: string): string {
  const file = path.join(root, 'sessions', `${name}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  return file;
}

function producer(sessionId = 'session-a'): AutoCheckpointProducer {
  return new AutoCheckpointProducer({
    sessionId,
    sessionFile: sessionFile(sessionId),
    cwd,
    maxFileSizeBytes: () => cap,
    createTurnId: () => `turn-${++turn}`,
    now: () => new Date(),
  });
}

const repoDir = (): string => getFolderRepoDir(folderIdFor(cwd));
const gitDir = (): string => getGitDir(repoDir());

function git(args: string[]): string {
  return execFileSync('git', [`--git-dir=${gitDir()}`, ...args], { maxBuffer: 64 * MB }).toString();
}

/** Git in the project repository at cwd, as the user would run it. */
function project(args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=u@x', '-c', 'user.name=u', '-c', 'core.autocrlf=false', '-c', 'protocol.file.allow=always', ...args], { cwd }).toString();
}

function refs(prefix = 'refs/damocles/'): Record<string, string> {
  const out = git(['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string]));
}

function treePaths(commit: string): string[] {
  return git(['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', commit]).split('\n').filter(Boolean);
}

function write(rel: string, content: string | Buffer): void {
  const full = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const bytesOf = (rel: string): Buffer => fs.readFileSync(path.join(cwd, rel));
const read = (rel: string): string => fs.readFileSync(path.join(cwd, rel), 'utf8');
const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function asEntry(record: CheckpointRecord | undefined): CheckpointEntryV3 {
  if (!record || record.kind !== 'checkpoint' || record.v !== 3) throw new Error(`expected a v3 checkpoint, got ${JSON.stringify(record)}`);
  return record;
}

async function turnOf(p: AutoCheckpointProducer, userEntryId: string, during?: () => void): Promise<CheckpointEntryV3> {
  const started = await p.turnStart({ userEntryId, prompt: userEntryId });
  if (!started.ok) throw new Error(started.message);
  during?.();
  const finalized = await p.finalizeRun();
  return asEntry(finalized.ok ? finalized.record : undefined);
}

function restored(result: RestoreResult): PreRewindRecord {
  if (!result.ok) throw new Error(`restore failed: ${JSON.stringify(result)}`);
  return result.preRewind;
}

/** The pid of a process that has exited, so no live process can be holding a lock under it. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => child.once('exit', r));
  return child.pid!;
}

const gitCalls = (sub: string): ExecCall[] => probe.calls.filter((c) => c.argv.includes(sub));

beforeEach(async () => {
  probe.calls.length = 0;
  probe.fail = null;
  probe.hold = null;
  cap = MB;
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-hard-'));
  cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(async () => {
  delete process.env['GIT_TRACE'];
  await fs.promises.rm(repoDir(), { recursive: true, force: true });
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('stale git locks', { timeout: 60_000 }, () => {
  it('a baseline removes index, packed-refs, config, HEAD and gc locks no git process holds', async () => {
    write('a.txt', '1\n');
    const p = producer();
    await turnOf(p, 'u1');
    const planted = [path.join(repoDir(), 'index.lock'), ...['packed-refs.lock', 'config.lock', 'HEAD.lock', 'gc.pid'].map((n) => path.join(gitDir(), n))];
    for (const file of planted) fs.writeFileSync(file, '');
    // A ref lock needs evidence of a dead holder, which a normal release is not.
    const refLock = path.join(gitDir(), 'refs', 'damocles', 'sessions', 'session-a', 'u1', 'before.lock');
    fs.writeFileSync(refLock, '');

    write('a.txt', '2\n');
    expect(await p.turnStart({ userEntryId: 'u2', prompt: 'p' })).toMatchObject({ ok: true });
    expect(planted.filter((f) => fs.existsSync(f))).toEqual([]);
    expect(fs.existsSync(refLock)).toBe(true);
  });

  it('after a takeover from a dead holder, ref locks go too, so deleting the conversation works', async () => {
    write('a.txt', '1\n');
    await turnOf(producer(), 'u1', () => write('a.txt', '2\n'));
    const refLock = path.join(gitDir(), 'refs', 'damocles', 'sessions', 'session-a', 'u1', 'before.lock');
    fs.writeFileSync(refLock, '');
    const lockDir = path.join(repoDir(), '.checkpoint-lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.pid'), String(await deadPid()));
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, old, old);

    await deleteSessionCheckpointRefs(cwd, 'session-a', await folderIdsInSessionFile(sessionFile('session-a')));
    expect(refs('refs/damocles/sessions/session-a/')).toEqual({});
    expect(fs.existsSync(refLock)).toBe(false);
  });

  it('never removes a lock while a git process an earlier holder registered still runs', async () => {
    write('a.txt', '1\n');
    const p = producer();
    await turnOf(p, 'u1');
    // A live git process, as an orphan of a crashed holder would be.
    const orphan = spawn('git', ['hash-object', '--stdin'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const procs = path.join(repoDir(), 'git-procs');
    fs.mkdirSync(procs, { recursive: true });
    fs.writeFileSync(path.join(procs, String(orphan.pid)), '1\n');
    const indexLock = path.join(repoDir(), 'index.lock');
    fs.writeFileSync(indexLock, '');
    try {
      const blocked = await p.turnStart({ userEntryId: 'u2', prompt: 'p' });
      expect(blocked).toMatchObject({ ok: false, message: expect.stringContaining('index.lock') });
      expect(fs.existsSync(indexLock)).toBe(true);
    } finally {
      orphan.stdin.end();
      await new Promise((r) => orphan.once('exit', r));
    }
    expect(await p.turnStart({ userEntryId: 'u3', prompt: 'p' })).toMatchObject({ ok: true });
    expect(fs.existsSync(indexLock)).toBe(false);
    expect(fs.readdirSync(procs)).toEqual([]);
  });
});

describe('atomic state and init', { timeout: 60_000 }, () => {
  it('a truncated size state is read as a full rescan, and the over-cap file stays out', async () => {
    write('a.txt', '1\n');
    write('big.bin', Buffer.alloc(2 * MB, 1));
    const p = producer();
    await turnOf(p, 'u1');
    fs.writeFileSync(path.join(repoDir(), 'size-excludes.json'), '{"floorBy');
    const entry = await turnOf(p, 'u2', () => write('a.txt', '2\n'));
    expect(entry.skipped.byReason.size).toEqual({ count: 1, bytes: 2 * MB });
    expect(treePaths(entry.beforeCommit)).not.toContain('big.bin');
    expect(() => JSON.parse(fs.readFileSync(path.join(repoDir(), 'size-excludes.json'), 'utf8')) as unknown).not.toThrow();
  });

  it('an init interrupted before its version stamp leaves no repo, and the next baseline builds a complete one', async () => {
    write('clip.mp4', 'video');
    write('a.txt', '1\n');
    probe.fail = (argv) => argv.includes('config') && argv.includes('damocles.excludeSetVersion') && !argv.includes('--get');
    expect(await producer().turnStart({ userEntryId: 'u1', prompt: 'p' })).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(gitDir(), 'HEAD'))).toBe(false);

    probe.fail = null;
    const entry = await turnOf(producer('session-b'), 'b1');
    expect(git(['config', '--local', 'damocles.excludeSetVersion']).trim()).toBe('2');
    expect(git(['config', 'user.email']).trim()).toBe('checkpoints@damocles.local');
    expect(fs.readFileSync(path.join(gitDir(), 'info', 'attributes'), 'utf8')).toContain('-text');
    expect(treePaths(entry.beforeCommit)).toEqual(['a.txt']);
    expect(fs.readdirSync(repoDir()).filter((n) => n.startsWith('.git-init-'))).toEqual([]);
  });
});

describe('byte-exact snapshots and restores', { timeout: 60_000 }, () => {
  it('ignores the project .gitattributes: CRLF, LF and $Id$ come back byte for byte', async () => {
    write('.gitattributes', '* text=auto eol=lf\n*.sh text eol=crlf\n*.txt ident\n');
    const crlf = Buffer.from('one\r\ntwo\r\n$Id$\r\n');
    const lf = Buffer.from('echo one\necho two\n');
    write('crlf.txt', crlf);
    write('run.sh', lf);
    const p = producer();
    const entry = await turnOf(p, 'u1', () => {
      write('crlf.txt', 'changed\n');
      write('run.sh', 'changed\n');
    });
    restored(await p.restore(entry));
    expect(bytesOf('crlf.txt').equals(crlf)).toBe(true);
    expect(bytesOf('run.sh').equals(lf)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('keeps the executable bit through a snapshot and a restore', async () => {
    write('deploy.sh', '#!/bin/sh\necho v1\n');
    fs.chmodSync(path.join(cwd, 'deploy.sh'), 0o755);
    const p = producer();
    const entry = await turnOf(p, 'u1', () => fs.rmSync(path.join(cwd, 'deploy.sh')));
    expect(git(['ls-tree', entry.beforeCommit, 'deploy.sh'])).toMatch(/^100755 /);
    restored(await p.restore(entry));
    expect(fs.statSync(path.join(cwd, 'deploy.sh')).mode & 0o777).toBe(0o755);
  });
});

describe('files the project tracks', { timeout: 120_000 }, () => {
  function projectRepo(): void {
    project(['init', '-q']);
    write('.gitignore', '.env*\ndist/junk.js\n');
    write('src/app.ts', 'src v1\n');
    write('dist/app.js', 'dist v1\n');
    write('dist/clip.mp4', 'tracked video');
    write('.env.example', 'KEY=\n');
    write('node_modules/x/i.js', 'vendored\n');
    write('build/big.bin', Buffer.alloc(2 * MB, 3));
    write('.damocles/settings.json', '{"allow":[]}\n');
    project(['add', '.gitignore', 'src']);
    project(['add', '-f', 'dist', '.env.example', 'node_modules', 'build', '.damocles/settings.json']);
    project(['commit', '-qm', 'init']);
    write('dist/junk.js', 'untracked build output\n');
  }

  it('captures tracked files the exclude set drops, never a security exclude, and reports what it leaves out', async () => {
    projectRepo();
    const userIndex = sha(path.join(cwd, '.git', 'index'));
    const userRefs = project(['for-each-ref']);
    const p = producer();
    const entry = await turnOf(p, 'u1', () => {
      write('dist/app.js', 'dist v2\n');
      write('src/app.ts', 'src v2\n');
    });
    const tree = treePaths(entry.beforeCommit);
    expect(tree).toEqual(expect.arrayContaining(['dist/app.js', '.env.example', 'node_modules/x/i.js', 'src/app.ts']));
    for (const left of ['dist/junk.js', 'dist/clip.mp4', 'build/big.bin', '.damocles/settings.json']) expect(tree).not.toContain(left);
    expect(await readSkippedManifest(entry, cwd)).toEqual({
      ok: true,
      value: expect.arrayContaining([
        { path: 'build/big.bin', bytes: 2 * MB, reason: 'size' },
        { path: 'dist/clip.mp4', bytes: 13, reason: 'category' },
      ]),
    });
    expect(entry.skipped.totalCount).toBe(2);
    expect(entry.fileChanges.map((c) => c.path).sort()).toEqual(['dist/app.js', 'src/app.ts']);

    write('.damocles/settings.json', '{"allow":["Bash"]}\n');
    write('dist/clip.mp4', 'video edited later');
    restored(await p.restore(entry));
    expect(read('dist/app.js')).toBe('dist v1\n');
    expect(read('src/app.ts')).toBe('src v1\n');
    expect(read('dist/junk.js')).toBe('untracked build output\n');
    expect(read('.damocles/settings.json')).toBe('{"allow":["Bash"]}\n');
    expect(read('dist/clip.mp4')).toBe('video edited later');
    // Read-only on the user's repository: its index and refs are exactly as before.
    expect(sha(path.join(cwd, '.git', 'index'))).toBe(userIndex);
    expect(project(['for-each-ref'])).toBe(userRefs);
  });

  it('keeps a captured tracked file in the shared index, so the next baseline neither drops nor re-stages it', async () => {
    projectRepo();
    const p = producer();
    await turnOf(p, 'u1');
    probe.calls.length = 0;
    await turnOf(p, 'u2', () => write('src/app.ts', 'src v2\n'));
    const touched = [...gitCalls('update-index')].map((c) => c.input ?? '');
    expect(touched.some((input) => input.includes('dist/app.js'))).toBe(false);
  });

  it('never overwrites a tracked file that is over the cap now, in a rewind, its preview or an undo', async () => {
    project(['init', '-q']);
    write('data.bin', 'small v1\n');
    write('dist/app.js', 'dist v1\n');
    write('src/a.ts', 'a1\n');
    project(['add', 'data.bin', 'src']);
    project(['add', '-f', 'dist']);
    project(['commit', '-qm', 'init']);
    const p = producer();
    const entry = await turnOf(p, 'u1', () => write('src/a.ts', 'a2\n'));
    const grown = Buffer.alloc(2 * MB, 8);
    write('data.bin', grown);
    write('dist/app.js', grown);
    const repo = new RepoManager(gitDir(), getIndexPath(repoDir()), cwd, { capturesTracked: true });
    expect(await repo.protectedAmong(entry.beforeCommit, ['data.bin', 'dist/app.js', 'src/a.ts'], cap)).toEqual(new Set(['data.bin', 'dist/app.js']));
    restored(await p.restore(entry));
    expect(read('src/a.ts')).toBe('a1\n');
    expect(bytesOf('data.bin').equals(grown)).toBe(true);
    expect(bytesOf('dist/app.js').equals(grown)).toBe(true);

    // Undo direction: the snapshot being restored holds a small copy, and the file is over the cap now.
    write('data.bin', 'small v2\n');
    write('dist/app.js', 'dist v2\n');
    const pre = restored(await p.restore(entry));
    expect(read('dist/app.js')).toBe('dist v1\n');
    write('data.bin', grown);
    write('dist/app.js', grown);
    restored(await p.restorePreRewind(pre));
    expect(bytesOf('data.bin').equals(grown)).toBe(true);
    expect(bytesOf('dist/app.js').equals(grown)).toBe(true);
  });

  it('leaves a tracked file the target never captured, because the project began tracking it later', async () => {
    project(['init', '-q']);
    write('src/a.ts', 'a1\n');
    write('dist/app.js', 'built, not tracked yet\n');
    project(['add', 'src']);
    project(['commit', '-qm', 'init']);
    const p = producer();
    const entry = await turnOf(p, 'u1', () => write('src/a.ts', 'a2\n'));
    expect(treePaths(entry.beforeCommit)).not.toContain('dist/app.js');
    project(['add', '-f', 'dist/app.js']);
    project(['commit', '-qm', 'track dist']);
    const repo = new RepoManager(gitDir(), getIndexPath(repoDir()), cwd, { capturesTracked: true });
    expect(await repo.protectedAmong(entry.beforeCommit, ['dist/app.js'], cap)).toEqual(new Set(['dist/app.js']));
    restored(await p.restore(entry));
    expect(read('src/a.ts')).toBe('a1\n');
    expect(read('dist/app.js')).toBe('built, not tracked yet\n');
  });

  it('never deletes what a directory holds where the target has a tracked file', async () => {
    project(['init', '-q']);
    write('dist/out', 'a file in the target\n');
    write('src/a.ts', 'a1\n');
    project(['add', 'src']);
    project(['add', '-f', 'dist/out']);
    project(['commit', '-qm', 'init']);
    const p = producer();
    const entry = await turnOf(p, 'u1', () => write('src/a.ts', 'a2\n'));
    fs.rmSync(path.join(cwd, 'dist', 'out'));
    write('dist/out/clip.mp4', 'a video in its place');
    const result = await p.restore(entry);
    expect(read('dist/out/clip.mp4')).toBe('a video in its place');
    expect(result.ok || result.reason === 'checkout-failed').toBe(true);
  });

  it('a legacy v2 rewind never captures or deletes tracked files its repo excluded', async () => {
    project(['init', '-q']);
    write('src/a.ts', 'a1\n');
    project(['add', 'src']);
    project(['commit', '-qm', 'init']);
    const legacyDir = getRepoDir(sessionFile('legacy'));
    const legacy = new RepoManager(getGitDir(legacyDir), getIndexPath(legacyDir), cwd);
    try {
      await legacy.ensureReady(CHECKPOINT_EXCLUDE_SET);
      write('.gitignore', '.env*\n');
      write('dist/app.js', 'dist\n');
      write('.env.example', 'KEY=\n');
      project(['add', '.gitignore']);
      project(['add', '-f', 'dist/app.js', '.env.example']);
      project(['commit', '-qm', 'tracked excluded files']);
      const before = await legacy.checkpoint('e1');
      expect(execFileSync('git', [`--git-dir=${getGitDir(legacyDir)}`, 'ls-tree', '-r', '--name-only', before]).toString()).not.toContain('dist/app.js');
      const entry: CheckpointEntryV2 = {
        v: 2, kind: 'checkpoint', turnId: 't', userEntryId: 'e1', beforeCommit: before, afterCommit: before,
        prompt: 'p', fileCount: 0, fileChanges: [], createdAt: new Date().toISOString(),
      };
      write('src/a.ts', 'a2\n');
      restored(await producer('legacy').restore(entry));
      expect(read('src/a.ts')).toBe('a1\n');
      expect(read('dist/app.js')).toBe('dist\n');
      expect(read('.env.example')).toBe('KEY=\n');
    } finally {
      await fs.promises.rm(legacyDir, { recursive: true, force: true });
    }
  });

  it('leaves a submodule and a nested repository to their own repositories', async () => {
    const sub = path.join(root, 'subsrc');
    fs.mkdirSync(sub);
    execFileSync('git', ['init', '-q'], { cwd: sub });
    fs.writeFileSync(path.join(sub, 's.txt'), 'sub\n');
    execFileSync('git', ['-c', 'user.email=u@x', '-c', 'user.name=u', 'add', '.'], { cwd: sub });
    execFileSync('git', ['-c', 'user.email=u@x', '-c', 'user.name=u', 'commit', '-qm', 's'], { cwd: sub });
    project(['init', '-q']);
    write('src/a.ts', 'a\n');
    project(['add', 'src']);
    project(['submodule', 'add', '-q', sub.replace(/\\/g, '/'), 'dist/sub']);
    project(['commit', '-qm', 'init']);
    write('dist/nested/n.txt', 'nested\n');
    execFileSync('git', ['init', '-q'], { cwd: path.join(cwd, 'dist', 'nested') });

    const entry = await turnOf(producer(), 'u1');
    const tree = treePaths(entry.beforeCommit);
    expect(tree).toContain('src/a.ts');
    expect(tree.filter((p) => p.startsWith('dist/'))).toEqual([]);
  });
});

describe('unusual paths never fail the folder', { timeout: 60_000 }, () => {
  it('a .gitattributes directory and an embedded repository with no commit are skipped, not fatal', async () => {
    fs.mkdirSync(path.join(cwd, '.gitattributes'));
    write('a.txt', '1\n');
    write('embedded/e.txt', 'e\n');
    execFileSync('git', ['init', '-q'], { cwd: path.join(cwd, 'embedded') });
    const entry = await turnOf(producer(), 'u1');
    expect(treePaths(entry.beforeCommit)).toEqual(['a.txt']);
  });

  it.skipIf(process.platform === 'win32')('a file over the cap whose name holds a line break is excluded and protected', async () => {
    write('a.txt', '1\n');
    write('odd\nname.bin', Buffer.alloc(2 * MB, 4));
    const p = producer();
    const entry = await turnOf(p, 'u1', () => write('a.txt', '2\n'));
    expect(treePaths(entry.beforeCommit)).toEqual(['a.txt']);
    write('odd\nname.bin', Buffer.alloc(2 * MB, 5));
    restored(await p.restore(entry));
    expect(bytesOf('odd\nname.bin').equals(Buffer.alloc(2 * MB, 5))).toBe(true);
  });

  it('check-ignore exit 1 with stderr output (GIT_TRACE) is still "nothing ignored"', async () => {
    write('a.txt', '1\n');
    const entry = await turnOf(producer(), 'u1', () => write('a.txt', '2\n'));
    process.env['GIT_TRACE'] = '1';
    const repo = new RepoManager(gitDir(), getIndexPath(repoDir()), cwd, { capturesTracked: true });
    expect(await repo.protectedAmong(entry.beforeCommit, ['a.txt'], cap)).toEqual(new Set());
  });

  it('attributes a skip only to the folder repo rules: a project .gitignore line is the project own ignore', async () => {
    write('.gitignore', '*.mp4\n');
    write('clip.mp4', 'video');
    write('other.mkv', 'video');
    const entry = await turnOf(producer(), 'u1');
    expect(entry.skipped.patterns).toEqual([{ pattern: '*.mkv', reason: 'category', count: 1, bytes: 5 }]);
    expect(entry.skipped.totalCount).toBe(1);
  });
});

describe('restore semantics', { timeout: 60_000 }, () => {
  it('recreates a captured path that is ignored and absent now, and leaves an ignored present one alone', async () => {
    write('gone.cfg', 'captured\n');
    write('kept.cfg', 'captured\n');
    const p = producer();
    const entry = await turnOf(p, 'u1');
    write('.gitignore', '*.cfg\n');
    fs.rmSync(path.join(cwd, 'gone.cfg'));
    write('kept.cfg', 'edited while ignored\n');
    restored(await p.restore(entry));
    expect(read('gone.cfg')).toBe('captured\n');
    expect(read('kept.cfg')).toBe('edited while ignored\n');
  });

  it('refuses an entry whose folder repo belongs to another folder, touching nothing', async () => {
    write('a.txt', '1\n');
    const p = producer();
    const entry = await turnOf(p, 'u1', () => write('a.txt', '2\n'));
    expect(await p.restore({ ...entry, folderId: 'ffffffffffffffff' })).toMatchObject({ ok: false, reason: 'unavailable', preRewind: null });
    const folderJson = path.join(repoDir(), 'folder.json');
    fs.writeFileSync(folderJson, JSON.stringify({ path: path.join(root, 'elsewhere'), layout: 1 }));
    expect(await p.restore(entry)).toMatchObject({ ok: false, reason: 'unavailable', error: expect.stringContaining('elsewhere') });
    expect(await readSkippedManifest({ ...entry, skipped: { ...entry.skipped, manifest: 'a'.repeat(40), totalCount: 1 } }, cwd)).toMatchObject({ ok: false });
    expect(read('a.txt')).toBe('2\n');
    expect(Object.keys(refs()).filter((r) => r.includes('/_rewinds/'))).toEqual([]);
  });

  it('a file that grew past the cap during the turn is a skip, not a deletion', async () => {
    write('a.txt', '1\n');
    write('grow.dat', 'small\n');
    const entry = await turnOf(producer(), 'u1', () => {
      write('a.txt', '2\n');
      write('grow.dat', Buffer.alloc(2 * MB, 6));
    });
    expect(entry.fileChanges).toEqual([{ path: 'a.txt', added: 1, removed: 1 }]);
  });

  it('caps that alternate between hosts reuse the recorded sizes instead of rescanning every tracked file', async () => {
    for (let i = 0; i < 20; i++) write(`src/f${i}.txt`, `${i}\n`);
    write('mid.bin', Buffer.alloc(3 * MB, 7));
    const p = producer();
    cap = 10 * MB;
    await turnOf(p, 'u1');
    probe.calls.length = 0;
    cap = 2 * MB;
    const small = await turnOf(p, 'u2');
    cap = 10 * MB;
    const large = await turnOf(p, 'u3');
    cap = 2 * MB;
    const again = await turnOf(p, 'u4');
    const fullListings = probe.calls.filter((c) => c.argv.includes('ls-files') && c.argv.includes('--cached') && !c.argv.includes('--ignored'));
    // Only `stage` lists the index; `prepareSnapshot` never rescans every tracked file.
    expect(fullListings).toHaveLength(6);
    expect(small.skipped.byReason.size?.count).toBe(1);
    expect(large.skipped.totalCount).toBe(0);
    expect(again.skipped.byReason.size?.count).toBe(1);
  });
});

describe('pre-rewind snapshots', { timeout: 60_000 }, () => {
  it('snapshots the current state under the conversation refs before a restore applies, and an undo brings it back', async () => {
    write('a.txt', '1\n');
    write('clip.mp4', 'video');
    const p = producer();
    const entry = await turnOf(p, 'u1', () => write('a.txt', '2\n'));
    write('a.txt', '3, unsaved in any checkpoint\n');
    const pre = restored(await p.restore(entry));
    expect(read('a.txt')).toBe('1\n');
    expect(pre).toMatchObject({ v: 3, kind: 'pre-rewind', folderId: folderIdFor(cwd), target: { kind: 'turn', userEntryId: 'u1' } });
    expect(refs()[`refs/damocles/sessions/session-a/_rewinds/${pre.id}/snapshot`]).toBe(pre.commit);
    expect(refs()[`refs/damocles/sessions/session-a/_rewinds/${pre.id}/skipped`]).toBe(pre.skipped.manifest);
    expect(await readSkippedManifest(pre, cwd)).toEqual({ ok: true, value: [{ path: 'clip.mp4', bytes: 5, reason: 'category' }] });

    const undo = restored(await p.restorePreRewind(pre));
    expect(read('a.txt')).toBe('3, unsaved in any checkpoint\n');
    expect(undo.target).toEqual({ kind: 'undo', preRewindId: pre.id });
    expect(refs()[`refs/damocles/sessions/session-a/_rewinds/${undo.id}/snapshot`]).toBe(undo.commit);
  });

  it('does not restore anything when the pre-rewind snapshot fails', async () => {
    write('a.txt', '1\n');
    const p = producer();
    const entry = await turnOf(p, 'u1', () => write('a.txt', '2\n'));
    probe.fail = (argv, input) => argv.includes('commit-tree') && (input ?? '').startsWith('pre-rewind');
    expect(await p.restore(entry)).toMatchObject({ ok: false, reason: 'snapshot-failed', preRewind: null });
    expect(read('a.txt')).toBe('2\n');
    expect(gitCalls('read-tree')).toEqual([]);
  });

  it('an abort before the folder lock is held restores nothing, now or later', async () => {
    write('a.txt', '1\n');
    const p = producer();
    const entry = await turnOf(p, 'u1', () => write('a.txt', '2\n'));
    expect(await p.restore(entry, { signal: AbortSignal.abort() })).toEqual({ ok: false, reason: 'aborted', preRewind: null });

    const lockDir = path.join(repoDir(), '.checkpoint-lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.pid'), String(process.pid));
    const controller = new AbortController();
    const pending = p.restore(entry, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toEqual({ ok: false, reason: 'aborted', preRewind: null });
    fs.rmSync(lockDir, { recursive: true });
    await turnOf(p, 'u2');
    expect(read('a.txt')).toBe('2\n');
    expect(Object.keys(refs()).filter((r) => r.includes('/_rewinds/'))).toEqual([]);
  });

  it('lives as long as the conversation: forks do not inherit it, age eviction and delete remove it', async () => {
    write('a.txt', '1\n');
    const p = producer();
    const entry = await turnOf(p, 'u1', () => write('a.txt', '2\n'));
    const pre = restored(await p.restore(entry));
    expect(await copyCheckpointRefs(cwd, 'session-fork', sessionFile('session-fork'), [entry])).toBe(1);
    expect(Object.keys(refs('refs/damocles/sessions/session-fork/'))).toEqual([
      'refs/damocles/sessions/session-fork/u1/after',
      'refs/damocles/sessions/session-fork/u1/before',
    ]);

    await deleteSessionCheckpointRefs(cwd, 'session-a', await folderIdsInSessionFile(sessionFile('session-a')));
    expect(refs('refs/damocles/sessions/session-a/')).toEqual({});

    const q = producer('session-b');
    const other = await turnOf(q, 'b1', () => write('a.txt', '3\n'));
    const preB = restored(await q.restore(other));
    expect(refs()[`refs/damocles/sessions/session-b/_rewinds/${preB.id}/snapshot`]).toBe(preB.commit);
    const later = Date.now() + 3 * 86_400_000;
    await runCheckpointMaintenance({ baseDir: path.join(root, 'none'), throttleMs: 0, retentionDays: 1, now: () => later });
    expect(refs('refs/damocles/sessions/session-b/')).toEqual({});
    expect(pre.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('gc off the folder lock', { timeout: 120_000 }, () => {
  it('a baseline completes while the maintenance repack runs, and no referenced commit, manifest or pre-rewind snapshot is lost', async () => {
    write('a.txt', '1\n');
    write('clip.mp4', 'video');
    const p = producer();
    const entry = await turnOf(p, 'u1', () => write('a.txt', '2\n'));
    const pre = restored(await p.restore(entry));
    const q = producer('session-b');
    await turnOf(q, 'b0');

    let entered!: () => void;
    const inRepack = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    probe.hold = { match: (argv) => argv.includes('repack') && argv.includes('-A'), gate: new Promise<void>((r) => (release = r)), entered };
    const sweep = runCheckpointMaintenance({ baseDir: path.join(root, 'none'), throttleMs: 0 });
    await inRepack;
    write('b.txt', 'written while gc runs\n');
    const during = await turnOf(q, 'b1', () => write('b.txt', 'after\n'));
    release();
    expect(await sweep).toMatchObject({ folderReposCollected: 1, failures: 0 });

    git(['gc', '--quiet', '--prune=now']);
    for (const commit of [entry.beforeCommit, entry.afterCommit, pre.commit, during.beforeCommit, during.afterCommit]) {
      expect(git(['cat-file', '-t', commit]).trim()).toBe('commit');
    }
    for (const blob of [entry.skipped.manifest!, pre.skipped.manifest!]) expect(git(['cat-file', '-t', blob]).trim()).toBe('blob');
    git(['fsck', '--connectivity-only', '--no-dangling']);
  });

  it('rolls small packs up once there are enough of them, keeping every object', async () => {
    write('a.txt', '0\n');
    await turnOf(producer(), 'u1');
    const env = { ...process.env, GIT_DIR: gitDir(), GIT_WORK_TREE: cwd, GIT_INDEX_FILE: path.join(root, 'scratch-index') };
    for (let i = 0; i < PACK_COUNT_LIMIT; i++) {
      write(`p${i}.txt`, `pack ${i}\n`);
      execFileSync('git', ['-c', 'core.bigFileThreshold=1', '-c', 'core.autocrlf=false', 'add', `p${i}.txt`], { cwd, env });
    }
    const packDir = path.join(gitDir(), 'objects', 'pack');
    const packs = (): number => fs.readdirSync(packDir).filter((f) => f.endsWith('.pack')).length;
    const objects = (): string => git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']);
    expect(packs()).toBeGreaterThanOrEqual(PACK_COUNT_LIMIT);
    const before = objects();
    await new RepoManager(gitDir(), getIndexPath(repoDir()), cwd).consolidatePacksIfCrowded();
    expect(packs()).toBeLessThan(PACK_COUNT_LIMIT / 2);
    expect(objects()).toBe(before);
  });
});
