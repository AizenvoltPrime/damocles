import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import type { Project } from '../../local-services/confine';
import { createTreeListing } from '../tree-listing';
import { createTransferOps, isPartName, MOVE_LEFT_LISTED, resolvesWithin, walkPath, WALK_PAGE_ENTRIES, type TransferEntry, type TransferOps } from '../transfer-ops';

const posix = process.platform !== 'win32';
let root: string;
let project: Project;
let ops: TransferOps;
const logged: string[] = [];
const at = (relative: string): string => path.join(project.fsPath, ...relative.split('/'));
const partsIn = (relative: string): string[] => fs.readdirSync(at(relative)).filter(isPartName);

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-transfer-ops-')));
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'a.ts'), 'old text');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside');
  project = { key: folderKey(projectDir), fsPath: projectDir, name: 'proj' };
  logged.length = 0;
  ops = createTransferOps({ platform: process.platform, log: (line) => logged.push(line) });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

// a source that stops after its first chunk until released
function gated(first: string, rest: string): { source: AsyncIterable<Uint8Array>; reached: Promise<void>; release: (error?: Error) => void } {
  let reach!: () => void;
  let release!: (error?: Error) => void;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const released = new Promise<Error | undefined>((resolve) => { release = resolve; });
  async function* source(): AsyncGenerator<Uint8Array> {
    yield Buffer.from(first);
    reach();
    const error = await released;
    if (error) throw error;
    yield Buffer.from(rest);
  }
  return { source: source(), reached, release };
}

async function walked(absolute: string): Promise<TransferEntry[]> {
  const entries: TransferEntry[] = [];
  for await (const page of walkPath(absolute)) entries.push(...page);
  return entries;
}

const MTIME = Date.UTC(2020, 0, 2, 3, 4, 5);

describe('receiveFile', () => {
  it('writes a .part beside the final name and renames it over the name once complete, with the mtime', async () => {
    const { source, reached, release } = gated('hello ', 'world');
    const done = ops.receiveFile(project, 'src', 'b.ts', source, { mode: 0o644, mtimeMs: MTIME, replace: false, size: 11 });
    await reached;
    await vi.waitFor(() => expect(partsIn('src')).toHaveLength(1));
    const [part] = partsIn('src');
    expect(part).toMatch(/^\.b\.ts\.damocles-[0-9a-f]{8}\.part$/);
    // the claim holds the name, empty, until the rename
    expect(fs.readFileSync(at('src/b.ts'), 'utf8')).toBe('');
    release();
    expect(await done).toEqual({ ok: true });
    expect(fs.readFileSync(at('src/b.ts'), 'utf8')).toBe('hello world');
    expect(fs.statSync(at('src/b.ts')).mtimeMs).toBe(MTIME);
    expect(partsIn('src')).toEqual([]);
  });

  it('leaves neither the part nor the claim when the source throws, and passes its error on', async () => {
    const { source, reached, release } = gated('half', 'rest');
    const done = ops.receiveFile(project, 'src', 'b.ts', source, { mode: 0o644, mtimeMs: MTIME, replace: false, size: 8 });
    await reached;
    const cancelled = new Error('cancelled');
    release(cancelled);
    await expect(done).rejects.toBe(cancelled);
    expect(fs.existsSync(at('src/b.ts'))).toBe(false);
    expect(partsIn('src')).toEqual([]);
  });

  it('refuses a source that sends fewer or more bytes than its size, leaving no file', async () => {
    expect(await ops.receiveFile(project, 'src', 'short.ts', chunks('abc'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 4 })).toMatchObject({ ok: false, reason: 'incomplete' });
    expect(await ops.receiveFile(project, 'src', 'long.ts', chunks('abc', 'de'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 4 })).toMatchObject({ ok: false, reason: 'incomplete' });
    expect(await ops.receiveFile(project, 'src', 'a.ts', chunks('new'), { mode: 0o644, mtimeMs: MTIME, replace: true, size: 2 })).toMatchObject({ ok: false, reason: 'incomplete' });
    expect(fs.readdirSync(at('src'))).toEqual(['a.ts']);
    expect(fs.readFileSync(at('src/a.ts'), 'utf8')).toBe('old text');
  });

  it('stops reading a source at the first byte past its size', async () => {
    let returned = false;
    const endless: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => {
        let sent = false;
        return {
          next: async () => {
            if (sent) return new Promise<IteratorResult<Uint8Array>>(() => undefined);
            sent = true;
            return { done: false, value: Buffer.from('four') };
          },
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    expect(await ops.receiveFile(project, 'src', 'b.ts', endless, { mode: 0o644, mtimeMs: MTIME, replace: false, size: 2 })).toMatchObject({ ok: false, reason: 'incomplete' });
    expect(returned).toBe(true);
    expect(fs.readdirSync(at('src'))).toEqual(['a.ts']);
  });

  it('without replace, fails with exists on a name taken before, and never replaces a file that took its claim meanwhile', async () => {
    expect(await ops.receiveFile(project, 'src', 'a.ts', chunks('new'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 3 })).toEqual({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(at('src/a.ts'), 'utf8')).toBe('old text');
    const { source, reached, release } = gated('mine', '');
    const done = ops.receiveFile(project, 'src', 'b.ts', source, { mode: 0o644, mtimeMs: MTIME, replace: false, size: 4 });
    await reached;
    // another process replaces the empty claim with its own file
    fs.rmSync(at('src/b.ts'));
    fs.writeFileSync(at('src/b.ts'), 'theirs');
    release();
    expect(await done).toEqual({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(at('src/b.ts'), 'utf8')).toBe('theirs');
    expect(partsIn('src')).toEqual([]);
  });

  it('with replace, swaps in the new file', async () => {
    expect(await ops.receiveFile(project, 'src', 'a.ts', chunks('new'), { mode: 0o644, mtimeMs: MTIME, replace: true, size: 3 })).toEqual({ ok: true });
    expect(fs.readFileSync(at('src/a.ts'), 'utf8')).toBe('new');
    expect(await ops.receiveFile(project, '', 'src', chunks('x'), { mode: 0o644, mtimeMs: MTIME, replace: true, size: 1 })).toEqual({ ok: false, reason: 'exists' });
    expect(fs.statSync(at('src')).isDirectory()).toBe(true);
  });

  it.runIf(posix)('keeps only mode & 0o777: setuid, setgid and sticky never cross', async () => {
    expect(await ops.receiveFile(project, 'src', 'run.sh', chunks('#!/bin/sh\n'), { mode: 0o7755, mtimeMs: MTIME, replace: false, size: 10 })).toEqual({ ok: true });
    expect(fs.statSync(at('src/run.sh')).mode & 0o7777).toBe(0o755);
  });

  it('refuses a name the host does not allow, and a folder outside the project', async () => {
    const windows = createTransferOps({ platform: 'win32', log: () => undefined });
    for (const name of ['CON', 'nul.txt', 'a:b', 'trailing.', '..', 'a/b']) {
      expect(await windows.receiveFile(project, 'src', name, chunks('x'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 1 }), name).toEqual({ ok: false, reason: 'invalidName' });
    }
    expect(await ops.receiveFile(project, 'src', '..', chunks('x'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 1 })).toEqual({ ok: false, reason: 'invalidName' });
    expect(await ops.receiveFile(project, '../', 'x', chunks('x'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 1 })).toMatchObject({ ok: false, reason: 'outside' });
    fs.symlinkSync(root, at('escape'), 'junction');
    expect(await ops.receiveFile(project, 'escape', 'x', chunks('x'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 1 })).toMatchObject({ ok: false, reason: 'outside' });
    expect(fs.existsSync(path.join(root, 'x'))).toBe(false);
    expect(await ops.receiveFile(project, 'src', 'ok.txt', chunks('x'), { mode: 0o644, mtimeMs: Number.NaN, replace: false, size: 1 })).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('keeps a modification time before 1970 on a POSIX host, and the copy\'s own time on a Windows host', async () => {
    const old = Date.UTC(1965, 4, 6);
    const before = Date.now() - 60_000;
    expect(await ops.receiveFile(project, 'src', 'old.txt', chunks('x'), { mode: 0o644, mtimeMs: old, replace: false, size: 1 })).toEqual({ ok: true });
    const mtime = fs.statSync(at('src/old.txt')).mtimeMs;
    if (posix) expect(mtime).toBe(old);
    else expect(mtime >= before && mtime <= Date.now() + 60_000).toBe(true);
  });

  it.runIf(posix)('accepts a name only Windows refuses on a POSIX host', async () => {
    expect(await ops.receiveFile(project, 'src', 'CON', chunks('x'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 1 })).toEqual({ ok: true });
  });

  it('first deletes the folder\'s parts a day old or more by their ctime, and only those', async () => {
    const part = at('src/.a.ts.damocles-0123abcd.part');
    const other = at('src/.a.ts.damocles-zz.part');
    const folderPart = at('src/.d.damocles-01234567.part');
    for (const file of [part, other]) fs.writeFileSync(file, 'left by a crash');
    fs.mkdirSync(folderPart);
    // land gives a part in flight the source's old mtime just before its rename, while its ctime stays now
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const entry of [part, other, folderPart]) fs.utimesSync(entry, twoDaysAgo, twoDaysAgo);
    expect(await ops.receiveFile(project, 'src', 'b.ts', chunks('x'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 1 })).toEqual({ ok: true });
    expect(fs.existsSync(part)).toBe(true);
    const twoDaysLater = createTransferOps({ platform: process.platform, log: () => undefined, now: () => Date.now() + 2 * 24 * 60 * 60 * 1000 });
    expect(await twoDaysLater.receiveFile(project, 'src', 'c.ts', chunks('x'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 1 })).toEqual({ ok: true });
    expect(fs.existsSync(part)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(folderPart)).toBe(true);
    expect(fs.readFileSync(at('src/a.ts'), 'utf8')).toBe('old text');
  });
});

describe('the tree listing', () => {
  it('hides part names', async () => {
    fs.writeFileSync(at('src/.a.ts.damocles-0123abcd.part'), '');
    fs.writeFileSync(at('src/.a.ts.damocles-zz.part'), '');
    const listing = await createTreeListing(() => undefined).list(project, 'src', []);
    expect(listing.ok && listing.entries.map((entry) => entry.name).sort()).toEqual(['.a.ts.damocles-zz.part', 'a.ts']);
  });
});

describe('walk', () => {
  it('lists the item first and each folder before its entries, with sizes, modes and times, in pages of 500', async () => {
    fs.mkdirSync(at('src/deep/er'), { recursive: true });
    fs.writeFileSync(at('src/deep/er/c.txt'), 'abc');
    const entries: TransferEntry[] = [];
    for await (const page of ops.walk(project, 'src')) entries.push(...page);
    expect(entries.map((entry) => [entry.relativePath, entry.kind])).toEqual([['', 'dir'], ['a.ts', 'file'], ['deep', 'dir'], ['deep/er', 'dir'], ['deep/er/c.txt', 'file']]);
    expect(entries[4]).toMatchObject({ size: 3, mtimeMs: Number(fs.lstatSync(at('src/deep/er/c.txt'), { bigint: true }).mtimeNs) / 1e6 });
    expect(typeof entries[4]!.identity.ino).toBe('bigint');
    for (let index = 0; index < WALK_PAGE_ENTRIES + 3; index++) fs.writeFileSync(at(`src/f${index}`), '');
    const pages: number[] = [];
    for await (const page of walkPath(at('src'))) pages.push(page.length);
    expect(pages).toEqual([WALK_PAGE_ENTRIES, 8]);
  });

  it('never follows a link, and reports it with its target', async () => {
    fs.symlinkSync(root, at('src/out'), 'junction');
    const entries = await walked(at('src'));
    const link = entries.find((entry) => entry.relativePath === 'out');
    expect(link).toMatchObject({ kind: 'link', size: 0 });
    expect(path.resolve(at('src'), link!.linkTarget!).replace(/\\$/, '')).toBe(root);
    expect(entries.some((entry) => entry.relativePath.startsWith('out/'))).toBe(false);
  });

  it.runIf(posix)('reports a socket as other', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(at('src/sock'), resolve));
    try {
      const entries = await walked(at('src'));
      expect(entries.find((entry) => entry.relativePath === 'sock')).toMatchObject({ kind: 'other', size: 0 });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('refuses to walk a path outside the project', async () => {
    const walk = ops.walk(project, '../outside.txt')[Symbol.asyncIterator]();
    await expect(walk.next()).rejects.toThrow(/outside/);
  });
});

describe('clashes', () => {
  it('ignores case on win32 and darwin hosts only', async () => {
    fs.writeFileSync(at('src/App.ts'), '');
    for (const platform of ['win32', 'darwin'] as const) {
      expect(await createTransferOps({ platform, log: () => undefined }).clashes(project, 'src', ['app.ts', 'b.ts'])).toEqual({ ok: true, clashes: [{ name: 'App.ts', kind: 'file' }, null] });
    }
    expect(await createTransferOps({ platform: 'linux', log: () => undefined }).clashes(project, 'src', ['app.ts', 'App.ts'])).toEqual({ ok: true, clashes: [null, { name: 'App.ts', kind: 'file' }] });
  });
});

describe('clashes failure', () => {
  it('names the error a folder listing failed with', async () => {
    vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' }));
    expect(await ops.clashes(project, 'src', ['a.ts'])).toEqual({ ok: false, reason: 'failed', code: 'EACCES', message: 'EACCES: permission denied, scandir' });
  });
});

describe('copy', () => {
  it('copies a file on the host under a new name through a part, keeping its time', async () => {
    fs.utimesSync(at('src/a.ts'), new Date(MTIME), new Date(MTIME));
    fs.mkdirSync(at('lib'));
    expect(await ops.copy(project, 'src/a.ts', project, 'lib', 'a copy.ts', false)).toEqual({ ok: true });
    expect(fs.readFileSync(at('lib/a copy.ts'), 'utf8')).toBe('old text');
    expect(fs.statSync(at('lib/a copy.ts')).mtimeMs).toBe(MTIME);
    expect(await ops.copy(project, 'src/a.ts', project, 'lib', 'a copy.ts', false)).toEqual({ ok: false, reason: 'exists' });
    expect(partsIn('lib')).toEqual([]);
  });

  it('never copies through a link or a folder', async () => {
    fs.symlinkSync(path.join(root, 'outside.txt'), at('src/out.txt'), 'file');
    expect(await ops.copy(project, 'src/out.txt', project, 'src', 'copied.txt', false)).toEqual({ ok: false, reason: 'notAFile' });
    expect(await ops.copy(project, 'src', project, '', 'src2', false)).toEqual({ ok: false, reason: 'notAFile' });
    expect(fs.existsSync(at('src/copied.txt'))).toBe(false);
  });
});

describe('move', () => {
  it('renames on the host, refuses a clash without replace, and a folder into itself', async () => {
    fs.mkdirSync(at('lib'));
    expect(await ops.move(project, 'src/a.ts', project, 'lib', 'a.ts', false)).toEqual({ ok: true, left: [] });
    expect(fs.readFileSync(at('lib/a.ts'), 'utf8')).toBe('old text');
    fs.writeFileSync(at('src/a.ts'), 'other');
    expect(await ops.move(project, 'src/a.ts', project, 'lib', 'a.ts', false)).toEqual({ ok: false, reason: 'exists' });
    expect(await ops.move(project, 'src/a.ts', project, 'lib', 'a.ts', true)).toEqual({ ok: true, left: [] });
    expect(fs.readFileSync(at('lib/a.ts'), 'utf8')).toBe('other');
    fs.mkdirSync(at('lib/inner'));
    expect(await ops.move(project, 'lib', project, 'lib/inner', 'lib', false)).toEqual({ ok: false, reason: 'intoItself' });
    expect(await ops.move(project, 'lib', project, 'lib', 'lib', false)).toEqual({ ok: false, reason: 'intoItself' });
  });

  it('on EXDEV copies each item and deletes each source item only after its copy finished', async () => {
    fs.mkdirSync(at('src/deep'));
    fs.writeFileSync(at('src/deep/b.txt'), 'bee');
    fs.mkdirSync(at('dest'));
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === at('src')) throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
      return rename(from, to);
    });
    const rm = fs.promises.rm;
    const order: string[] = [];
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      // a source file goes only once its copy is in place
      if (String(target).startsWith(at('src'))) order.push(`rm ${path.relative(project.fsPath, String(target))} copied=${fs.existsSync(at(`dest/moved/${path.relative(at('src'), String(target))}`))}`);
      return rm(target, options);
    });
    expect(await ops.move(project, 'src', project, 'dest', 'moved', false)).toEqual({ ok: true, left: [] });
    expect(fs.readFileSync(at('dest/moved/a.ts'), 'utf8')).toBe('old text');
    expect(fs.readFileSync(at('dest/moved/deep/b.txt'), 'utf8')).toBe('bee');
    expect(fs.existsSync(at('src'))).toBe(false);
    expect(order.sort()).toEqual([`rm ${path.join('src', 'a.ts')} copied=true`, `rm ${path.join('src', 'deep', 'b.txt')} copied=true`]);
  });

  it('on EXDEV leaves a source item whose copy failed, and its folder', async () => {
    fs.mkdirSync(at('dest'));
    fs.mkdirSync(at('src/deep'));
    fs.writeFileSync(at('src/deep/b.txt'), 'bee');
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === at('src')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      return rename(from, to);
    });
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      if (String(file) === at('src/a.ts')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return open(file, flags, mode);
    });
    expect(await ops.move(project, 'src', project, 'dest', 'moved', false)).toEqual({ ok: true, left: ['a.ts'] });
    expect(fs.readFileSync(at('src/a.ts'), 'utf8')).toBe('old text');
    expect(fs.existsSync(at('src/deep'))).toBe(false);
    expect(fs.readFileSync(at('dest/moved/deep/b.txt'), 'utf8')).toBe('bee');
    expect(fs.existsSync(at('dest/moved/a.ts'))).toBe(false);
  });
});

describe('makeFolder', () => {
  it('returns the existing folder, and refuses a file or a link to a folder in its place', async () => {
    expect(await ops.makeFolder(project, '', 'lib')).toEqual({ ok: true });
    fs.writeFileSync(at('lib/kept.txt'), 'kept');
    expect(await ops.makeFolder(project, '', 'lib')).toEqual({ ok: true });
    expect(fs.readFileSync(at('lib/kept.txt'), 'utf8')).toBe('kept');
    expect(await ops.makeFolder(project, 'src', 'a.ts')).toEqual({ ok: false, reason: 'exists' });
    fs.symlinkSync(at('lib'), at('linked'), 'junction');
    expect(await ops.makeFolder(project, '', 'linked')).toEqual({ ok: false, reason: 'exists' });
  });
});

describe('makeLink', () => {
  it.runIf(posix)('makes a link on a POSIX host, and refuses a taken name without replace', async () => {
    expect(await ops.makeLink(project, 'src', 'to-a', 'a.ts', false)).toEqual({ ok: true });
    expect(fs.readlinkSync(at('src/to-a'))).toBe('a.ts');
    expect(await ops.makeLink(project, 'src', 'to-a', 'b.ts', false)).toEqual({ ok: false, reason: 'exists' });
    expect(await ops.makeLink(project, 'src', 'to-a', 'b.ts', true)).toEqual({ ok: true });
    expect(fs.readlinkSync(at('src/to-a'))).toBe('b.ts');
    expect(await ops.makeLink(project, 'src', 'bad', 'a\0b', false)).toMatchObject({ ok: false, reason: 'failed' });
  });

  it.runIf(posix)('keeps a link made within a folder only while it resolves inside it on disk, through every link on the way', async () => {
    fs.mkdirSync(at('dl/d1'), { recursive: true });
    fs.symlinkSync('/var/log', at('dl/cur'));
    expect(await ops.makeLink(project, 'dl/d1', 'b', '..', false, 'dl')).toEqual({ ok: true });
    expect(await ops.makeLink(project, 'dl', 'up', 'd1/b', false, 'dl')).toEqual({ ok: true });
    // lexically inside, but d1/b is a link to dl, so this leads to dl's parent
    expect(await ops.makeLink(project, 'dl', 'a', 'd1/b/..', false, 'dl')).toEqual({ ok: false, reason: 'outside' });
    expect(await ops.makeLink(project, 'dl', 'x', 'cur/..', false, 'dl')).toEqual({ ok: false, reason: 'outside' });
    expect(await ops.makeLink(project, 'dl', 'later', 'missing/../..', false, 'dl')).toEqual({ ok: false, reason: 'outside' });
    expect(await ops.makeLink(project, 'dl', 'soon', 'missing/x', false, 'dl')).toEqual({ ok: true });
    expect(fs.readdirSync(at('dl')).sort()).toEqual(['cur', 'd1', 'soon', 'up']);
  });

  it('skips a link on a Windows host', async () => {
    const windows = createTransferOps({ platform: 'win32', log: () => undefined });
    expect(await windows.makeLink(project, 'src', 'to-a', 'a.ts', false)).toEqual({ ok: false, reason: 'unsupported' });
    expect(fs.existsSync(at('src/to-a'))).toBe(false);
  });
});

describe('removeFolder', () => {
  it('removes an empty folder it was told of, never a full one or a replaced one', async () => {
    fs.mkdirSync(at('empty'));
    const [first] = await walked(at('empty'));
    fs.rmdirSync(at('empty'));
    fs.mkdirSync(at('empty'));
    expect(await ops.removeFolder(project, 'empty', first!.identity)).toMatchObject({ ok: false });
    const [second] = await walked(at('empty'));
    expect(await ops.removeFolder(project, 'empty', second!.identity)).toEqual({ ok: true });
    const [src] = await walked(at('src'));
    expect(await ops.removeFolder(project, 'src', src!.identity)).toEqual({ ok: false, reason: 'notEmpty' });
  });
});

describe('readFile', () => {
  it('streams a file\'s bytes and refuses a link or a folder', async () => {
    const read = await ops.readFile(project, 'src/a.ts');
    if (!read.ok) throw new Error(read.reason);
    expect(read.size).toBe(8);
    const parts: Buffer[] = [];
    for await (const chunk of read.chunks) parts.push(Buffer.from(chunk));
    expect(Buffer.concat(parts).toString('utf8')).toBe('old text');
    fs.symlinkSync(path.join(root, 'outside.txt'), at('src/out.txt'), 'file');
    expect(await ops.readFile(project, 'src/out.txt')).toEqual({ ok: false, reason: 'notAFile' });
    expect(await ops.readFile(project, 'src')).toEqual({ ok: false, reason: 'notAFile' });
  });

  it('yields only the size it answered, so a file still growing reads as a consistent prefix', async () => {
    const read = await ops.readFile(project, 'src/a.ts');
    if (!read.ok) throw new Error(read.reason);
    fs.appendFileSync(at('src/a.ts'), ' and more written while it was read');
    const parts: Buffer[] = [];
    for await (const chunk of read.chunks) parts.push(Buffer.from(chunk));
    expect(Buffer.concat(parts).toString('utf8')).toBe('old text');
    expect(read.size).toBe(8);
  });
});

// a source that records whether it was returned, and stalls after its chunks
function tracked(...parts: string[]): { readonly source: AsyncIterable<Uint8Array>; readonly returned: () => boolean } {
  let returned = false;
  const queue = parts.map((part) => Buffer.from(part));
  const iterator: AsyncIterator<Uint8Array> = {
    next: async () => {
      const next = queue.shift();
      return next ? { done: false, value: next } : new Promise<IteratorResult<Uint8Array>>(() => undefined);
    },
    return: async () => {
      returned = true;
      return { done: true, value: undefined };
    },
  };
  return { source: { [Symbol.asyncIterator]: () => iterator }, returned: () => returned };
}

describe('receiveFile returns its source however it ends', () => {
  const options = { mode: 0o644, mtimeMs: MTIME, replace: false, size: 8 };

  it('on a refused name or request, a folder that cannot be used and a name already taken', async () => {
    const cases: Array<[string, string, typeof options]> = [
      ['src', '..', options],
      ['src', 'b.ts', { ...options, mtimeMs: Number.NaN }],
      ['../', 'b.ts', options],
      ['missing', 'b.ts', options],
      ['src/a.ts', 'b.ts', options],
      ['src', 'a.ts', options],
    ];
    for (const [dir, name, given] of cases) {
      const { source, returned } = tracked('12345678');
      expect(await ops.receiveFile(project, dir, name, source, given), `${dir}/${name}`).toMatchObject({ ok: false });
      expect(returned(), `${dir}/${name}`).toBe(true);
    }
  });

  it('when the stale part sweep, the part\'s create or a write fails', async () => {
    const readdir = fs.promises.readdir;
    const sweep = vi.spyOn(fs.promises, 'readdir').mockImplementationOnce(async () => {
      throw Object.assign(new Error('i/o error'), { code: 'EIO' });
    });
    const swept = tracked('12345678');
    await expect(ops.receiveFile(project, 'src', 'b.ts', swept.source, options)).rejects.toThrow('i/o error');
    expect(swept.returned()).toBe(true);
    sweep.mockImplementation(readdir);
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      if (isPartName(path.basename(String(file)))) {
        if (String(file).includes('.c.ts.')) throw Object.assign(new Error('i/o error'), { code: 'EIO' });
        const handle = await open(file, flags, mode);
        vi.spyOn(handle, 'write').mockImplementation(async () => {
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        });
        return handle;
      }
      return open(file, flags, mode);
    });
    for (const [name, code] of [['c.ts', 'EIO'], ['d.ts', 'ENOSPC']] as const) {
      const { source, returned } = tracked('1234', '5678');
      expect(await ops.receiveFile(project, 'src', name, source, options)).toMatchObject({ ok: false, reason: 'failed', code });
      expect(returned(), name).toBe(true);
    }
    expect(fs.readdirSync(at('src'))).toEqual(['a.ts']);
  });
});

describe('the claim', () => {
  it('stays once another process has opened it and written into it', async () => {
    const { source, reached, release } = gated('mine', 'more');
    const done = ops.receiveFile(project, 'src', 'b.ts', source, { mode: 0o644, mtimeMs: MTIME, replace: false, size: 8 });
    await reached;
    // a dev server writing its output opens the existing empty file without O_EXCL and fills it
    fs.writeFileSync(at('src/b.ts'), 'dev server output');
    const cancelled = new Error('cancelled');
    release(cancelled);
    await expect(done).rejects.toBe(cancelled);
    expect(fs.readFileSync(at('src/b.ts'), 'utf8')).toBe('dev server output');
    expect(partsIn('src')).toEqual([]);
  });
});

describe('the stale part sweep', () => {
  it('remembers only the folders swept within the last hour', async () => {
    let clock = Date.now();
    const timed = createTransferOps({ platform: process.platform, log: () => undefined, now: () => clock });
    const maps: Array<Map<unknown, unknown>> = [];
    const set = Map.prototype.set;
    vi.spyOn(Map.prototype, 'set').mockImplementation(function record(this: Map<unknown, unknown>, key, value) {
      // the sweep's map holds when each folder was swept; other maps keyed by the folder (a link walk's answers) are not it
      if (key === folderKey(at('src')) && typeof value === 'number' && !maps.includes(this)) maps.push(this);
      return set.call(this, key, value);
    });
    fs.mkdirSync(at('other'));
    expect(await timed.receiveFile(project, 'src', 'b.ts', chunks('x'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 1 })).toEqual({ ok: true });
    clock += 2 * 60 * 60 * 1000;
    expect(await timed.receiveFile(project, 'other', 'c.ts', chunks('x'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 1 })).toEqual({ ok: true });
    expect(maps).toHaveLength(1);
    expect([...maps[0]!.keys()]).toEqual([folderKey(at('other'))]);
  });
});

describe('walk of a tree that changes while it is read', () => {
  it('leaves out an entry gone since its folder was read, and lists one it cannot read with its error', async () => {
    fs.writeFileSync(at('src/gone.tmp'), '');
    fs.writeFileSync(at('src/locked.ts'), '');
    const lstat = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (target: fs.PathLike, opts?: fs.StatOptions) => {
      if (String(target) === at('src/gone.tmp')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (String(target) === at('src/locked.ts')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return lstat(target, opts);
    }) as typeof fs.promises.lstat);
    const entries = await walked(at('src'));
    expect(entries.map((entry) => [entry.relativePath, entry.kind, entry.error])).toEqual([['', 'dir', undefined], ['a.ts', 'file', undefined], ['locked.ts', 'other', 'EACCES']]);
  });

  it('leaves out a link gone before its target was read', async () => {
    fs.symlinkSync(at('src'), at('src/link'), 'junction');
    const readlink = fs.promises.readlink;
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (target: fs.PathLike, opts?: unknown) => {
      if (String(target) === at('src/link')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return readlink(target, opts as BufferEncoding);
    }) as typeof fs.promises.readlink);
    expect((await walked(at('src'))).map((entry) => entry.relativePath)).toEqual(['', 'a.ts']);
  });

  it('a move across file systems leaves a folder it cannot make, with everything under it, and carries the rest', async () => {
    fs.mkdirSync(at('dest'));
    fs.mkdirSync(at('src/deep/deeper'), { recursive: true });
    fs.writeFileSync(at('src/deep/b.txt'), 'bee');
    fs.writeFileSync(at('src/deep/deeper/c.txt'), 'see');
    fs.writeFileSync(at('src/z.txt'), 'zed');
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === at('src')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      return rename(from, to);
    });
    const mkdir = fs.promises.mkdir;
    vi.spyOn(fs.promises, 'mkdir').mockImplementation((async (target: fs.PathLike, opts?: fs.MakeDirectoryOptions) => {
      if (String(target) === at('dest/moved/deep')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return mkdir(target, opts);
    }) as typeof fs.promises.mkdir);
    expect(await ops.move(project, 'src', project, 'dest', 'moved', false)).toEqual({ ok: true, left: ['deep'] });
    expect(fs.readFileSync(at('dest/moved/a.ts'), 'utf8')).toBe('old text');
    expect(fs.readFileSync(at('dest/moved/z.txt'), 'utf8')).toBe('zed');
    expect(fs.readFileSync(at('src/deep/deeper/c.txt'), 'utf8')).toBe('see');
    expect(fs.existsSync(at('src/a.ts'))).toBe(false);
  });

  it('a move across file systems lists at most MOVE_LEFT_LISTED items it left, and counts the rest', async () => {
    fs.mkdirSync(at('dest'));
    for (let index = 0; index < MOVE_LEFT_LISTED + 2; index++) fs.writeFileSync(at(`src/f${index}.txt`), 'x');
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === at('src')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      return rename(from, to);
    });
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      if (path.basename(String(file)).startsWith('f') && flags === 'r') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return open(file, flags, mode);
    });
    const moved = await ops.move(project, 'src', project, 'dest', 'moved', false);
    if (!moved.ok) throw new Error(moved.reason);
    expect(moved.left).toHaveLength(MOVE_LEFT_LISTED);
    expect(moved.leftMore).toBe(2);
  });
});

describe('renames Windows refuses for a moment', () => {
  // an antivirus scanner holding a just-closed file makes the rename fail with EPERM, EBUSY or EACCES for a moment
  it.runIf(!posix)('lands the part and moves the item once the file is let go', async () => {
    const rename = fs.promises.rename;
    let refused = 0;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (refused < 2) {
        refused += 1;
        throw Object.assign(new Error('operation not permitted'), { code: refused === 1 ? 'EPERM' : 'EBUSY' });
      }
      return rename(from, to);
    });
    expect(await ops.receiveFile(project, 'src', 'b.ts', chunks('new'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 3 })).toEqual({ ok: true });
    expect(fs.readFileSync(at('src/b.ts'), 'utf8')).toBe('new');
    refused = 0;
    fs.mkdirSync(at('lib'));
    expect(await ops.move(project, 'src/b.ts', project, 'lib', 'b.ts', false)).toEqual({ ok: true, left: [] });
    expect(fs.readFileSync(at('lib/b.ts'), 'utf8')).toBe('new');
  });
});

describe('resolvesWithin', () => {
  it('refuses a folder outside the root, and a file named before more segments', async () => {
    fs.mkdirSync(at('dl/sub'), { recursive: true });
    fs.writeFileSync(at('dl/CUR'), 'a file now, a link after a later Replace');
    expect(await resolvesWithin(at('dl'), at('dl'), 'sub')).toBe(true);
    expect(await resolvesWithin(at('dl'), at('dl'), 'CUR')).toBe(true);
    expect(await resolvesWithin(at('dl'), at('dl'), 'CUR/..')).toBe(false);
    expect(await resolvesWithin(at('dl'), at('dl'), 'CUR/x')).toBe(false);
    expect(await resolvesWithin(at('dl/sub'), at('dl'), 'sub')).toBe(false);
    expect(await resolvesWithin(at('dl/sub'), root, 'proj/dl/sub')).toBe(false);
  });
});

describe.runIf(posix)('modes on a POSIX host', () => {
  // the umask in force, as an exclusive create applies it
  const umask = (): number => {
    const probe = at('probe');
    fs.writeFileSync(probe, '', { mode: 0o777 });
    const mode = fs.statSync(probe).mode & 0o777;
    fs.rmSync(probe);
    return 0o777 & ~mode;
  };

  it('creates a received file with its source\'s permission bits under the umask, so a Windows source\'s 0666 is not world-writable', async () => {
    const mask = umask();
    expect(await ops.receiveFile(project, 'src', 'from-windows.txt', chunks('x'), { mode: 0o100666, mtimeMs: MTIME, replace: false, size: 1 })).toEqual({ ok: true });
    expect(fs.statSync(at('src/from-windows.txt')).mode & 0o7777).toBe(0o666 & ~mask);
    expect(await ops.receiveFile(project, 'src', 'run.sh', chunks('x'), { mode: 0o4755, mtimeMs: MTIME, replace: false, size: 1 })).toEqual({ ok: true });
    expect(fs.statSync(at('src/run.sh')).mode & 0o7777).toBe(0o755 & ~mask);
    expect(await ops.receiveFile(project, 'src', 'read-only.txt', chunks('x'), { mode: 0o444, mtimeMs: MTIME, replace: false, size: 1 })).toEqual({ ok: true });
    expect(fs.readFileSync(at('src/read-only.txt'), 'utf8')).toBe('x');
  });

  it('carries a folder\'s mode under the umask, the owner\'s rwx always kept', async () => {
    const mask = umask();
    expect(await ops.makeFolder(project, '', 'private', 0o700)).toEqual({ ok: true });
    expect(fs.statSync(at('private')).mode & 0o777).toBe(0o700);
    expect(await ops.makeFolder(project, '', 'shared', 0o775)).toEqual({ ok: true });
    expect(fs.statSync(at('shared')).mode & 0o777).toBe(0o775 & ~mask);
    expect(await ops.makeFolder(project, '', 'read-only', 0o555)).toEqual({ ok: true });
    expect(fs.statSync(at('read-only')).mode & 0o777).toBe(0o755 & ~mask);
  });
});

describe.runIf(posix)('verifyLink', () => {
  it('removes a link made within a folder that a later Replace made lead outside, and keeps one still inside', async () => {
    fs.mkdirSync(at('dl/sub'), { recursive: true });
    // already in the folder the download merges into
    fs.symlinkSync('sub', at('dl/cur'));
    expect(await ops.makeLink(project, 'dl', 'a', 'cur/..', false, 'dl')).toEqual({ ok: true });
    expect(await ops.makeLink(project, 'dl', 'b', 'sub', false, 'dl')).toEqual({ ok: true });
    // the user's Replace of cur: now a/.. leads above dl
    expect(await ops.makeLink(project, 'dl', 'cur', '.', true, 'dl')).toEqual({ ok: true });
    expect(await ops.verifyLink(project, 'dl/a', 'dl')).toEqual({ ok: false, reason: 'outside' });
    expect(await ops.verifyLink(project, 'dl/b', 'dl')).toEqual({ ok: true });
    expect(await ops.verifyLink(project, 'dl/gone', 'dl')).toEqual({ ok: true });
    expect(fs.readdirSync(at('dl')).sort()).toEqual(['b', 'cur', 'sub']);
  });

  it('refuses the CUR file, a -> CUR/.., cur -> . sequence when the link is made', async () => {
    fs.mkdirSync(at('dl'));
    expect(await ops.receiveFile(project, 'dl', 'CUR', chunks('x'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 1 })).toEqual({ ok: true });
    expect(await ops.makeLink(project, 'dl', 'a', 'CUR/..', false, 'dl')).toEqual({ ok: false, reason: 'outside' });
    expect(await ops.makeLink(project, 'dl', 'cur', '.', true, 'dl')).toEqual({ ok: true });
    // a case-insensitive host replaced CUR itself, which the refusal above made harmless
    if (process.platform === 'linux') expect(fs.readdirSync(at('dl')).sort()).toEqual(['CUR', 'cur']);
  });
});

describe('a rename Windows refuses while another process holds the target', () => {
  it.runIf(!posix)('lands nothing over a claim another process wrote into while the rename waited', async () => {
    const rename = fs.promises.rename;
    let refused = false;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (!refused && String(to) === at('src/b.ts')) {
        refused = true;
        // the dev server that opened the empty claim writes into it, and holds it open for a moment
        fs.writeFileSync(at('src/b.ts'), 'dev server output');
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      return rename(from, to);
    });
    expect(await ops.receiveFile(project, 'src', 'b.ts', chunks('mine'), { mode: 0o644, mtimeMs: MTIME, replace: false, size: 4 })).toEqual({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(at('src/b.ts'), 'utf8')).toBe('dev server output');
    expect(partsIn('src')).toEqual([]);
  });

  it.runIf(!posix)('moves nothing over a file another process made at the target while the rename waited', async () => {
    fs.mkdirSync(at('lib'));
    const rename = fs.promises.rename;
    let refused = false;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (!refused && String(to) === at('lib/a.ts')) {
        refused = true;
        fs.writeFileSync(at('lib/a.ts'), 'theirs');
        throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      }
      return rename(from, to);
    });
    expect(await ops.move(project, 'src/a.ts', project, 'lib', 'a.ts', false)).toEqual({ ok: false, reason: 'exists' });
    expect(fs.readFileSync(at('lib/a.ts'), 'utf8')).toBe('theirs');
    expect(fs.readFileSync(at('src/a.ts'), 'utf8')).toBe('old text');
  });
});

describe('a cancel on the host', () => {
  it('stops a copy mid-file, rejecting, with no part and no claim left', async () => {
    fs.mkdirSync(at('lib'));
    fs.writeFileSync(at('src/big.bin'), Buffer.alloc(4 * 64 * 1024, 7));
    const controller = new AbortController();
    const open = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (isPartName(path.basename(String(file)))) {
        const write = handle.write.bind(handle);
        vi.spyOn(handle, 'write').mockImplementation((async (...args: Parameters<typeof write>) => {
          controller.abort();
          return write(...args);
        }) as typeof handle.write);
      }
      return handle;
    });
    await expect(ops.copy(project, 'src/big.bin', project, 'lib', 'big.bin', false, controller.signal)).rejects.toThrow();
    expect(fs.readdirSync(at('lib'))).toEqual([]);
  });

  it('stops a move across file systems after the item under way, keeping the sources not yet moved', async () => {
    fs.mkdirSync(at('dest'));
    fs.mkdirSync(at('src/b'));
    fs.writeFileSync(at('src/b/x.ts'), 'x');
    fs.writeFileSync(at('src/c.ts'), 'c');
    const controller = new AbortController();
    const rename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === at('src')) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      return rename(from, to);
    });
    const rm = fs.promises.rm;
    vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      // the first source deleted after its copy landed
      if (path.dirname(String(target)) === at('src')) controller.abort();
      return rm(target, options);
    });
    await expect(ops.move(project, 'src', project, 'dest', 'moved', false, controller.signal)).rejects.toThrow();
    expect(fs.readdirSync(at('src')).sort()).toEqual(['b', 'c.ts']);
    expect(fs.readdirSync(at('dest/moved'))).toEqual(['a.ts']);
  });
});

describe.runIf(posix)('a link whose check cannot finish', () => {
  it('is removed and refused, never left on disk', async () => {
    fs.mkdirSync(at('dl/sub'), { recursive: true });
    const lstat = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation((async (target: fs.PathLike, opts?: fs.StatOptions) => {
      if (String(target) === at('dl/sub')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return lstat(target, opts);
    }) as typeof fs.promises.lstat);
    expect(await ops.makeLink(project, 'dl', 'a', 'sub/x', false, 'dl')).toMatchObject({ ok: false, code: 'EACCES' });
    vi.mocked(fs.promises.lstat).mockRestore();
    expect(fs.readdirSync(at('dl'))).toEqual(['sub']);
  });
});

describe.runIf(posix)('replace on a POSIX host', () => {
  it('keeps the replaced file\'s permission bits, as scp and rsync do, rather than the source\'s', async () => {
    fs.writeFileSync(at('src/.env'), 'SECRET=old');
    fs.chmodSync(at('src/.env'), 0o600);
    expect(await ops.receiveFile(project, 'src', '.env', chunks('SECRET=new'), { mode: 0o100666, mtimeMs: MTIME, replace: true, size: 10 })).toEqual({ ok: true });
    expect(fs.readFileSync(at('src/.env'), 'utf8')).toBe('SECRET=new');
    expect(fs.statSync(at('src/.env')).mode & 0o777).toBe(0o600);
  });
});
