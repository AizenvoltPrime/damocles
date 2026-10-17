import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LineChange } from '../../../shared/scm/apply-line-changes';
import { encodeBlob, type TextCodec } from '../staging';
import { folder, freshStatus, git, GIT_PATH, harness, HAS_GIT, makeRepo, ready, statusOf, useGitSandbox, waitFor, type Harness } from './git-harness';

/**
 * Stage and Unstage Selected Ranges against real git: the index blob keeps the file's own line endings, encoding and mode,
 * a changed index is refused, and a path in an untrusted project inside the repository is never written.
 */
useGitSandbox();

const UTF8: TextCodec = { encoding: 'utf8', bom: false };
const change = (os: number, oe: number, ms: number, me: number): LineChange => ({ originalStartLineNumber: os, originalEndLineNumber: oe, modifiedStartLineNumber: ms, modifiedEndLineNumber: me });

// The index entry's bytes, exactly as stored.
function indexBytes(dir: string, file: string): Buffer {
  return execFileSync(GIT_PATH!, ['show', `:${file}`], { cwd: dir });
}

const indexOid = (dir: string, file: string): string => git(['rev-parse', `:${file}`], dir).trim();
const modeOf = (dir: string, file: string): string => git(['ls-files', '-s', '--', file], dir).split(' ')[0]!;

async function open(dir: string, trusted: readonly string[] = [dir], projects: ReadonlyArray<{ key: string; path: string }> = [{ key: 'p', path: dir }]): Promise<{ h: Harness; repoId: string }> {
  const h = harness({ trusted });
  h.service.setProjects([...projects]);
  const repoId = (await ready(h)).repos.find((repo) => repo.root === dir)!.repoId;
  await waitFor(() => statusOf(h, repoId), 'a first status');
  return { h, repoId };
}

function seeded(name: string, file: string, bytes: Buffer, config: ReadonlyArray<readonly [string, string]> = []): string {
  const dir = makeRepo(folder(name));
  for (const [key, value] of config) git(['config', key, value], dir);
  fs.writeFileSync(path.join(dir, file), bytes);
  git(['add', file], dir);
  git(['commit', '--quiet', '-m', 'seed'], dir);
  return dir;
}

describe.skipIf(!HAS_GIT)('staging selected ranges', { timeout: 120_000 }, () => {
  it('stages one of two hunks of a CRLF file with autocrlf false, and unstages it again', async () => {
    const dir = seeded('crlf-false', 'f.txt', Buffer.from('a\r\nb\r\nc\r\nd\r\n'), [['core.autocrlf', 'false']]);
    const { h, repoId } = await open(dir);
    const buffer = 'A\r\nb\r\nc\r\nD\r\n';
    fs.writeFileSync(path.join(dir, 'f.txt'), buffer);
    const oid = indexOid(dir, 'f.txt');
    expect(await h.service.stageRanges(repoId, { path: 'f.txt', ranges: [change(1, 1, 1, 1)], indexOid: oid, codec: UTF8, buffer })).toEqual({ ok: true });
    expect(indexBytes(dir, 'f.txt').toString('latin1')).toBe('A\r\nb\r\nc\r\nd\r\n');
    const cached = git(['diff', '--cached', '--', 'f.txt'], dir);
    expect(cached).toContain('-a\r\n+A\r\n');
    expect(cached).not.toContain('+D');
    expect(modeOf(dir, 'f.txt')).toBe('100644');
    const staged = indexOid(dir, 'f.txt');
    expect(await h.service.stageRanges(repoId, { path: 'f.txt', ranges: [change(1, 1, 1, 1)], indexOid: staged, codec: UTF8, headOid: git(['rev-parse', 'HEAD:f.txt'], dir).trim() })).toEqual({ ok: true });
    expect(indexBytes(dir, 'f.txt').toString('latin1')).toBe('a\r\nb\r\nc\r\nd\r\n');
    expect(git(['diff', '--cached', '--', 'f.txt'], dir)).toBe('');
    h.service.dispose();
  });

  it('stages a CRLF buffer into an LF index with autocrlf true, keeping the index LF', async () => {
    const dir = seeded('crlf-true', 'f.txt', Buffer.from('a\nb\nc\nd\n'), [['core.autocrlf', 'true']]);
    const { h, repoId } = await open(dir);
    const buffer = 'a\r\nB\r\nc\r\nD\r\n';
    fs.writeFileSync(path.join(dir, 'f.txt'), buffer);
    expect(await h.service.stageRanges(repoId, { path: 'f.txt', ranges: [change(2, 2, 2, 2)], indexOid: indexOid(dir, 'f.txt'), codec: UTF8, buffer })).toEqual({ ok: true });
    expect(indexBytes(dir, 'f.txt').toString('latin1')).toBe('a\nB\nc\nd\n');
    h.service.dispose();
  });

  it('stages part of a hunk of a UTF-16 file with a byte order mark, in that encoding', async () => {
    const codec: TextCodec = { encoding: 'utf16le', bom: true };
    const dir = seeded('utf16', 'w.txt', encodeBlob('one\r\ntwo\r\nthree\r\n', codec));
    const { h, repoId } = await open(dir);
    const buffer = 'ONE\r\nTWO\r\nthree\r\n';
    fs.writeFileSync(path.join(dir, 'w.txt'), encodeBlob(buffer, codec));
    expect(await h.service.stageRanges(repoId, { path: 'w.txt', ranges: [change(2, 2, 2, 2)], indexOid: indexOid(dir, 'w.txt'), codec, buffer })).toEqual({ ok: true });
    expect(indexBytes(dir, 'w.txt').equals(encodeBlob('one\r\nTWO\r\nthree\r\n', codec))).toBe(true);
    h.service.dispose();
  });

  it('keeps an executable mode', async () => {
    const dir = seeded('mode', 'run.sh', Buffer.from('echo a\necho b\n'));
    git(['update-index', '--chmod=+x', 'run.sh'], dir);
    git(['commit', '--quiet', '-m', 'exec'], dir);
    const { h, repoId } = await open(dir);
    const buffer = 'echo a\necho c\n';
    fs.writeFileSync(path.join(dir, 'run.sh'), buffer);
    expect(await h.service.stageRanges(repoId, { path: 'run.sh', ranges: [change(2, 2, 2, 2)], indexOid: indexOid(dir, 'run.sh'), codec: UTF8, buffer })).toEqual({ ok: true });
    expect(modeOf(dir, 'run.sh')).toBe('100755');
    expect(indexBytes(dir, 'run.sh').toString('utf8')).toBe('echo a\necho c\n');
    h.service.dispose();
  });

  it('adds a file the index lacks as 100644 when its ranges name the empty blob', async () => {
    const dir = makeRepo(folder('new-file'));
    const { h, repoId } = await open(dir);
    const buffer = 'first\nsecond\n';
    fs.writeFileSync(path.join(dir, 'n.txt'), buffer);
    const empty = execFileSync(GIT_PATH!, ['hash-object', '-t', 'blob', '--stdin'], { cwd: dir, input: '' }).toString('utf8').trim();
    expect(await h.service.stageRanges(repoId, { path: 'n.txt', ranges: [change(0, 0, 1, 1)], indexOid: empty, codec: UTF8, buffer })).toEqual({ ok: true });
    expect(modeOf(dir, 'n.txt')).toBe('100644');
    expect(indexBytes(dir, 'n.txt').toString('utf8')).toBe('first\n');
    h.service.dispose();
  });

  it('refuses a stale indexOid and writes nothing', async () => {
    const dir = seeded('stale', 'f.txt', Buffer.from('a\nb\n'));
    const { h, repoId } = await open(dir);
    const before = indexOid(dir, 'f.txt');
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nB\n');
    git(['add', 'f.txt'], dir);
    const buffer = 'A\nB\n';
    expect(await h.service.stageRanges(repoId, { path: 'f.txt', ranges: [change(1, 1, 1, 1)], indexOid: before, codec: UTF8, buffer })).toEqual({ ok: false, reason: 'changed' });
    expect(indexBytes(dir, 'f.txt').toString('utf8')).toBe('a\nB\n');
    h.service.dispose();
  });

  it('refuses ranges that do not fit the buffer, so a buffer that moved on is never staged', async () => {
    const dir = seeded('range', 'f.txt', Buffer.from('a\nb\n'));
    const { h, repoId } = await open(dir);
    expect(await h.service.stageRanges(repoId, { path: 'f.txt', ranges: [change(2, 2, 2, 9)], indexOid: indexOid(dir, 'f.txt'), codec: UTF8, buffer: 'a\nB\n' })).toEqual({ ok: false, reason: 'outOfRange' });
    h.service.dispose();
  });

  it('refuses a path inside an untrusted project in the repository', async () => {
    const dir = makeRepo(folder('fenced'));
    const declined = path.join(dir, 'declined');
    fs.mkdirSync(declined);
    fs.writeFileSync(path.join(declined, 'd.txt'), 'x\n');
    git(['add', '.'], dir);
    git(['commit', '--quiet', '-m', 'declined'], dir);
    const { h, repoId } = await open(dir, [dir], [{ key: 'p', path: dir }, { key: 'd', path: declined }]);
    const oid = indexOid(dir, 'declined/d.txt');
    expect(await h.service.stageRanges(repoId, { path: 'declined/d.txt', ranges: [change(1, 1, 1, 1)], indexOid: oid, codec: UTF8, buffer: 'y\n' })).toEqual({ ok: false, reason: 'declined' });
    expect(indexOid(dir, 'declined/d.txt')).toBe(oid);
    h.service.dispose();
  });

  it('unstages part of a staged rename against HEAD\'s source path, and the quick diff reads HEAD there', async () => {
    const dir = seeded('rename', 'old.txt', Buffer.from('a\nb\nc\nd\ne\nf\ng\nh\n'));
    git(['mv', 'old.txt', 'new.txt'], dir);
    fs.writeFileSync(path.join(dir, 'new.txt'), 'A\nb\nc\nd\ne\nf\ng\nH\n');
    git(['add', 'new.txt'], dir);
    const { h, repoId } = await open(dir);
    await freshStatus(h, repoId);
    const headOid = git(['rev-parse', 'HEAD:old.txt'], dir).trim();
    expect(await h.service.quickDiffBase(repoId, 'new.txt', UTF8)).toEqual({ ok: true, indexText: 'A\nb\nc\nd\ne\nf\ng\nH\n', indexOid: indexOid(dir, 'new.txt'), headText: 'a\nb\nc\nd\ne\nf\ng\nh\n', headOid, hasStaged: true });
    expect(await h.service.stageRanges(repoId, { path: 'new.txt', ranges: [change(1, 1, 1, 1)], indexOid: indexOid(dir, 'new.txt'), codec: UTF8, headOid })).toEqual({ ok: true });
    expect(indexBytes(dir, 'new.txt').toString('utf8')).toBe('a\nb\nc\nd\ne\nf\ng\nH\n');
    h.service.dispose();
  });

  it('refuses an unstage computed against a HEAD that moved since', async () => {
    const dir = seeded('head-moved', 'f.txt', Buffer.from('a\nb\n'));
    fs.writeFileSync(path.join(dir, 'f.txt'), 'A\nb\n');
    git(['add', 'f.txt'], dir);
    const { h, repoId } = await open(dir);
    const before = git(['rev-parse', 'HEAD:f.txt'], dir).trim();
    git(['commit', '--quiet', '-m', 'from a terminal'], dir);
    await freshStatus(h, repoId);
    expect(await h.service.stageRanges(repoId, { path: 'f.txt', ranges: [change(1, 1, 1, 1)], indexOid: indexOid(dir, 'f.txt'), codec: UTF8, headOid: before })).toEqual({ ok: false, reason: 'changed' });
    expect(indexBytes(dir, 'f.txt').toString('utf8')).toBe('A\nb\n');
    h.service.dispose();
  });

  it('stages a CRLF buffer into an LF index with autocrlf true and safecrlf true', async () => {
    const dir = seeded('safecrlf', 'f.txt', Buffer.from('a\r\nb\r\nc\r\nd\r\n'), [['core.autocrlf', 'true']]);
    git(['config', 'core.safecrlf', 'true'], dir);
    const { h, repoId } = await open(dir);
    const buffer = 'a\r\nB\r\nc\r\nD\r\n';
    fs.writeFileSync(path.join(dir, 'f.txt'), buffer);
    expect(await h.service.stageRanges(repoId, { path: 'f.txt', ranges: [change(2, 2, 2, 2)], indexOid: indexOid(dir, 'f.txt'), codec: UTF8, buffer })).toEqual({ ok: true });
    expect(indexBytes(dir, 'f.txt').toString('latin1')).toBe('a\nB\nc\nd\n');
    h.service.dispose();
  });

  it('keeps the index\'s own line breaks around a staged CRLF line when git converts nothing', async () => {
    const dir = seeded('no-eol-conversion', 'f.txt', Buffer.from('a\nb\nc\n'), [['core.autocrlf', 'false']]);
    const { h, repoId } = await open(dir);
    const buffer = 'a\r\nB\r\nc\r\n';
    expect(await h.service.stageRanges(repoId, { path: 'f.txt', ranges: [change(2, 2, 2, 2)], indexOid: indexOid(dir, 'f.txt'), codec: UTF8, buffer })).toEqual({ ok: true });
    expect(indexBytes(dir, 'f.txt').toString('latin1')).toBe('a\nB\r\nc\n');
    h.service.dispose();
  });

  it('stages one line of a working-tree-encoding UTF-16 file, whose index blob is UTF-8', async () => {
    const codec: TextCodec = { encoding: 'utf16le', bom: true };
    const dir = makeRepo(folder('wte'));
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'w.txt working-tree-encoding=UTF-16\n');
    const lines = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'];
    fs.writeFileSync(path.join(dir, 'w.txt'), encodeBlob(`${lines.join('\n')}\n`, codec));
    git(['add', '.'], dir);
    git(['commit', '--quiet', '-m', 'utf-16 in the work tree'], dir);
    expect(indexBytes(dir, 'w.txt').toString('utf8')).toBe(`${lines.join('\n')}\n`);
    const { h, repoId } = await open(dir);
    const buffer = 'l1\nL2\nl3\nl4\nL5\nl6\n';
    fs.writeFileSync(path.join(dir, 'w.txt'), encodeBlob(buffer, codec));
    await freshStatus(h, repoId);
    expect(await h.service.quickDiffBase(repoId, 'w.txt', codec)).toMatchObject({ ok: true, indexText: `${lines.join('\n')}\n` });
    expect(await h.service.stageRanges(repoId, { path: 'w.txt', ranges: [change(5, 5, 5, 5)], indexOid: indexOid(dir, 'w.txt'), codec, buffer })).toEqual({ ok: true });
    expect(indexBytes(dir, 'w.txt').toString('utf8')).toBe('l1\nl2\nl3\nl4\nL5\nl6\n');
    h.service.dispose();
  });

  it('gives a Git LFS file no quick diff base', async () => {
    const dir = makeRepo(folder('lfs'));
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'big.dat filter=lfs diff=lfs merge=lfs -text\n');
    fs.writeFileSync(path.join(dir, 'big.dat'), 'version https://git-lfs.github.com/spec/v1\noid sha256:0000000000000000000000000000000000000000000000000000000000000000\nsize 3\n');
    git(['add', '.'], dir);
    git(['commit', '--quiet', '-m', 'lfs'], dir);
    const { h, repoId } = await open(dir);
    expect(await h.service.quickDiffBase(repoId, 'big.dat', undefined)).toEqual({ ok: false, reason: 'lfs' });
    h.service.dispose();
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')('refuses a path inside an untrusted project named in another case', async () => {
    const dir = makeRepo(folder('fenced-case'));
    const declined = path.join(dir, 'declined');
    fs.mkdirSync(declined);
    fs.writeFileSync(path.join(declined, 'd.txt'), 'x\n');
    git(['add', '.'], dir);
    git(['commit', '--quiet', '-m', 'declined'], dir);
    const { h, repoId } = await open(dir, [dir], [{ key: 'p', path: dir }, { key: 'd', path: declined }]);
    const oid = indexOid(dir, 'declined/d.txt');
    expect(await h.service.stageRanges(repoId, { path: 'DECLINED/d.txt', ranges: [change(1, 1, 1, 1)], indexOid: oid, codec: UTF8, buffer: 'y\n' })).toEqual({ ok: false, reason: 'declined' });
    h.service.dispose();
  });

  it('reads the quick diff base: the index, and HEAD while the file has staged changes', async () => {
    const dir = seeded('base', 'f.txt', Buffer.from('a\nb\n'));
    const { h, repoId } = await open(dir);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\nB\n');
    git(['add', 'f.txt'], dir);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'A\nB\n');
    fs.writeFileSync(path.join(dir, 'u.txt'), 'u\n');
    await freshStatus(h, repoId);
    expect(await h.service.quickDiffBase(repoId, 'f.txt', UTF8)).toEqual({ ok: true, indexText: 'a\nB\n', indexOid: indexOid(dir, 'f.txt'), headText: 'a\nb\n', headOid: git(['rev-parse', 'HEAD:f.txt'], dir).trim(), hasStaged: true });
    expect(await h.service.quickDiffBase(repoId, 'u.txt', UTF8)).toEqual({ ok: false, reason: 'untracked' });
    h.service.dispose();
  });
});
