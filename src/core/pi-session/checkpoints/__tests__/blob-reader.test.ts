import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SPAWN_TEST_TIMEOUT_MS } from '../../../../__mocks__/spawn-budget';
import { EDITOR_MAX_DOCUMENT_BYTES } from '../../../../shared/types/messages';
import { gitExecutable } from '../../../git-executable';
import { processLauncher, type LaunchedProcess, type Launcher, type SpawnSpec } from '../../../process-launcher';
import { createBlobReaders, openBlobReader } from '../blob-reader';

/** One `git cat-file --batch` per checkpoint repo, against a real repository whose objects are packed, as maintenance leaves them. */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function repoWith(files: Record<string, Buffer | string>): { repoDir: string; commit: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-blob-reader-'));
  dirs.push(repoDir);
  const git = (...args: string[]): string => execFileSync(gitExecutable(), ['-c', 'core.autocrlf=false', ...args], { cwd: repoDir, encoding: 'utf8' });
  git('init', '--quiet');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repoDir, name)), { recursive: true });
    fs.writeFileSync(path.join(repoDir, name), content);
  }
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'snapshot');
  git('repack', '-a', '-d', '-q');
  return { repoDir, commit: git('rev-parse', 'HEAD').trim() };
}

// The process-wide launcher, with every start it makes kept for the test.
function recording(): { launcher: Launcher; started: Array<{ spec: SpawnSpec; process: LaunchedProcess }> } {
  const started: Array<{ spec: SpawnSpec; process: LaunchedProcess }> = [];
  const inner = processLauncher();
  return {
    started,
    launcher: {
      launch: (spec, options) => {
        const launched = inner.launch(spec, options);
        started.push({ spec, process: launched });
        return launched;
      },
      createSessionJob: () => inner.createSessionJob(),
      dispose: () => inner.dispose(),
    },
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);

describe('the checkpoint blob reader', { timeout: SPAWN_TEST_TIMEOUT_MS * 2 }, () => {
  it('reads text, CRLF, binary and paths with spaces and non-ASCII characters through one git', async () => {
    const { repoDir, commit } = repoWith({ 'a.txt': 'one\ntwo\n', 'crlf.txt': 'a\r\nb\r\n', 'with space/ü ñ 文.txt': 'unicode\n', 'image.png': PNG });
    const { launcher, started } = recording();
    const reader = openBlobReader(repoDir, launcher);
    const reads = await Promise.all(['a.txt', 'crlf.txt', 'with space/ü ñ 文.txt', 'image.png'].map((file) => reader.read(commit, file)));
    expect(reads).toEqual([
      { kind: 'text', text: 'one\ntwo\n' },
      { kind: 'text', text: 'a\r\nb\r\n' },
      { kind: 'text', text: 'unicode\n' },
      { kind: 'binary', digest: createHash('sha1').update(PNG).digest('hex') },
    ]);
    await reader.close();
    expect(started.map(({ spec }) => spec.args.slice(-2))).toEqual([['cat-file', '--batch']]);
  });

  it('says absent for a path the commit lacks, and unavailable for a commit the repo lacks', async () => {
    const { repoDir, commit } = repoWith({ 'a.txt': 'a\n' });
    const reader = openBlobReader(repoDir);
    expect(await reader.read(commit, 'missing.txt')).toEqual({ kind: 'absent' });
    expect(await reader.read('f'.repeat(40), 'a.txt')).toEqual({ kind: 'unavailable' });
    expect(await reader.read('not-a-commit', 'a.txt')).toEqual({ kind: 'unavailable' });
    expect(await reader.read(commit, 'a.txt')).toEqual({ kind: 'text', text: 'a\n' });
    await reader.close();
  });

  it('reads through content past the review\'s bound as too large and answers the next read', async () => {
    const { repoDir, commit } = repoWith({ 'big.txt': 'x'.repeat(EDITOR_MAX_DOCUMENT_BYTES + 1), 'after.txt': 'after\n' });
    const reader = openBlobReader(repoDir);
    expect(await Promise.all([reader.read(commit, 'big.txt'), reader.read(commit, 'after.txt')])).toEqual([{ kind: 'tooLarge' }, { kind: 'text', text: 'after\n' }]);
    await reader.close();
  });

  it('fails the reads waiting on a killed git as unavailable, and starts another git for the next read', async () => {
    const { repoDir, commit } = repoWith({ 'a.txt': 'a\n' });
    const { launcher, started } = recording();
    const reader = openBlobReader(repoDir, launcher);
    const waiting = reader.read(commit, 'a.txt');
    started[0]!.process.kill({ signal: 'SIGKILL' });
    expect(await waiting).toEqual({ kind: 'unavailable' });
    expect(await reader.read(commit, 'a.txt')).toEqual({ kind: 'text', text: 'a\n' });
    expect(started).toHaveLength(2);
    await reader.close();
  });

  it('answers an ambiguous commit prefix as unavailable and keeps its git for the next read', async () => {
    // cat-file --batch's answer for a short id naming two objects, which git keeps answering after
    const fakeCatFile = "require('readline').createInterface({ input: process.stdin }).on('line', (l) => process.stdout.write(l + (l.startsWith('abcdef0') ? ' ambiguous' : ' missing') + '\\n'));";
    const inner = processLauncher();
    const started: SpawnSpec[] = [];
    const launcher: Launcher = {
      launch: (spec, options) => {
        started.push(spec);
        return inner.launch({ ...spec, file: process.execPath, args: ['-e', fakeCatFile] }, options);
      },
      createSessionJob: () => inner.createSessionJob(),
      dispose: () => inner.dispose(),
    };
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-blob-reader-'));
    dirs.push(repoDir);
    const reader = openBlobReader(repoDir, launcher);
    expect(await reader.read('abcdef0', 'a.txt')).toEqual({ kind: 'unavailable' });
    expect(await reader.read('f'.repeat(40), 'a.txt')).toEqual({ kind: 'unavailable' });
    expect(started).toHaveLength(1);
    await reader.close();
  });

  it('leaves the repository deletable once closed', async () => {
    const { repoDir, commit } = repoWith({ 'a.txt': 'a\n' });
    const { launcher, started } = recording();
    const reader = openBlobReader(repoDir, launcher);
    expect(await reader.read(commit, 'a.txt')).toEqual({ kind: 'text', text: 'a\n' });
    await reader.close();
    await expect(started[0]!.process.exited).resolves.toEqual({ code: 0, signal: null });
    fs.rmSync(repoDir, { recursive: true });
    expect(fs.existsSync(repoDir)).toBe(false);
    expect(await reader.read(commit, 'a.txt')).toEqual({ kind: 'unavailable' });
  });

  it.skipIf(process.platform === 'win32')('reads a path holding a line feed with a one-off git show', async () => {
    const { repoDir, commit } = repoWith({ 'new\nline.txt': 'nl\n' });
    const { launcher, started } = recording();
    const reader = openBlobReader(repoDir, launcher);
    expect(await reader.read(commit, 'new\nline.txt')).toEqual({ kind: 'text', text: 'nl\n' });
    expect(started).toHaveLength(0);
    await reader.close();
  });

  it('starts one git per repository for one set of readers, and closes them all', async () => {
    const first = repoWith({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const second = repoWith({ 'c.txt': 'c\n' });
    const { launcher, started } = recording();
    const readers = createBlobReaders(launcher);
    await Promise.all([readers.read(first.repoDir, first.commit, 'a.txt'), readers.read(first.repoDir, first.commit, 'b.txt'), readers.read(second.repoDir, second.commit, 'c.txt')]);
    expect(started).toHaveLength(2);
    await readers.close();
    for (const { process } of started) await expect(process.closed).resolves.toBeUndefined();
    expect(await readers.read(first.repoDir, first.commit, 'a.txt')).toEqual({ kind: 'unavailable' });
  });
});
