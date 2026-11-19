import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { copyFolderForUpload, type UploadCaps, type UploadTarget } from '../upload-copy';

const statfs = vi.hoisted(() => ({ free: undefined as number | undefined, failure: undefined as Error | undefined, volumes: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    statfs: async (volume: string) => {
      statfs.volumes.push(volume);
      if (statfs.failure !== undefined) throw statfs.failure;
      return statfs.free === undefined ? actual.statfs(volume) : { bavail: statfs.free, bsize: 1 };
    },
  };
});

beforeEach(() => {
  statfs.free = undefined;
  statfs.failure = undefined;
  statfs.volumes = [];
});

const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-upload-copy-')));
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
let counter = 0;
const MiB = 1024 * 1024;
const roomy: UploadCaps = { maxEntries: 1000, maxBytes: 100 * MiB };

/** A folder named `name` under a fresh folder of base, holding `files` (path below it, with `/`, to content). */
function folderWith(name: string, files: Record<string, string>): string {
  const root = path.join(base, `t-${++counter}`, name);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

/** A fresh `damocles-uploads` stand-in, and a target whose create makes one `u-` folder in it, running `then` first. */
function uploads(then?: () => void): { root: string; target: UploadTarget; created: string[] } {
  const root = fs.mkdtempSync(path.join(base, 'uploads-'));
  const created: string[] = [];
  const target: UploadTarget = {
    volume: base,
    create: async () => {
      then?.();
      const folder = fs.mkdtempSync(path.join(root, 'u-'));
      created.push(folder);
      return folder;
    },
  };
  return { root, target, created };
}

/** Every entry below folder, `/`-separated, a folder's ending in `/`, each regular file with its content. */
function contents(folder: string, below = ''): string[] {
  return fs.readdirSync(path.join(folder, below), { withFileTypes: true }).flatMap((entry) => {
    const rel = below === '' ? entry.name : `${below}/${entry.name}`;
    if (entry.isDirectory()) return [`${rel}/`, ...contents(folder, rel)];
    return [entry.isFile() ? `${rel}=${fs.readFileSync(path.join(folder, rel), 'utf8')}` : `${rel} (not a file)`];
  }).sort();
}

describe('copyFolderForUpload', () => {
  it('copies every regular file the walk lists, hidden and .git ones included, under the folder\'s own name, with its modification time', async () => {
    const folder = folderWith('photos', { 'a.txt': 'A', 'sub/s.txt': 'S', '.hidden': 'H', '.git/HEAD': 'ref', 'sub/deeper/d.txt': 'D' });
    fs.mkdirSync(path.join(folder, 'empty'));
    const modified = new Date('2024-02-03T04:05:06Z');
    fs.utimesSync(path.join(folder, 'a.txt'), modified, modified);
    const { target, created } = uploads();
    const copied = await copyFolderForUpload(folder, target, undefined, roomy);
    expect(copied).toEqual({ copy: path.join(created[0]!, 'photos'), files: 5, leftOut: [] });
    expect(fs.readdirSync(created[0]!)).toEqual(['photos']);
    expect(contents(copied.copy)).toEqual(['.git/', '.git/HEAD=ref', '.hidden=H', 'a.txt=A', 'empty/', 'sub/', 'sub/deeper/', 'sub/deeper/d.txt=D', 'sub/s.txt=S']);
    expect(fs.statSync(path.join(copied.copy, 'a.txt')).mtime.getTime()).toBe(modified.getTime());
  });

  it('copies nothing and creates no folder when its signal is already aborted', async () => {
    const folder = folderWith('docs', { 'a.txt': 'A' });
    const { root, target } = uploads();
    const controller = new AbortController();
    controller.abort();
    await expect(copyFolderForUpload(folder, target, controller.signal, roomy)).rejects.toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('removes what it copied when its signal aborts part-way', async () => {
    const files = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`f${i}.txt`, 'x'.repeat(4096)]));
    const folder = folderWith('many', files);
    const { target, created } = uploads();
    const controller = new AbortController();
    const copying = copyFolderForUpload(folder, target, controller.signal, roomy);
    // the copy has started once its folder exists
    while (!(created[0] !== undefined && fs.existsSync(path.join(created[0], 'many')))) await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(copying).rejects.toThrow();
    expect(fs.readdirSync(created[0]!)).toEqual([]);
  });
});

describe('copyFolderForUpload: caps and free space', () => {
  it('refuses a folder over the entry cap before creating anything, naming the folder, the cap and its setting', async () => {
    const folder = folderWith('lots', { 'a.txt': 'A', 'b.txt': 'B', 'sub/c.txt': 'C' });
    const { root, target } = uploads();
    const error = await copyFolderForUpload(folder, target, undefined, { maxEntries: 3, maxBytes: MiB }).then(() => undefined, (err: unknown) => err as Error);
    expect(error?.message).toBe(`The folder ${folder} holds more than 3 entries, the most a folder upload may copy, counting its files, folders and links; the setting damocles.browser.uploadFolderMaxEntries raises that limit.`);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(statfs.volumes).toEqual([]);
    const single = await copyFolderForUpload(folder, target, undefined, { maxEntries: 1, maxBytes: MiB }).then(() => undefined, (err: unknown) => err as Error);
    expect(single?.message).toContain('holds more than 1 entry, ');
    expect((await copyFolderForUpload(folder, target, undefined, { maxEntries: 4, maxBytes: MiB })).files).toBe(3);
  });

  it('counts folders against the entry cap, so a tree of empty folders is refused before any is made', async () => {
    const folder = folderWith('hollow', {});
    for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(folder, `d${i}`, 'inner'), { recursive: true });
    const { root, target } = uploads();
    const mkdir = vi.spyOn(fs.promises, 'mkdir');
    try {
      await expect(copyFolderForUpload(folder, target, undefined, { maxEntries: 10, maxBytes: MiB })).rejects.toThrow(/holds more than 10 entries/);
      expect(mkdir).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('stops counting as soon as the entry cap is passed', async () => {
    const folder = folderWith('crowd', Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}.txt`, 'x'])));
    const lstat = vi.spyOn(fs.promises, 'lstat');
    try {
      await expect(copyFolderForUpload(folder, uploads().target, undefined, { maxEntries: 3, maxBytes: MiB })).rejects.toThrow(/more than 3 entries/);
      expect(lstat.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      lstat.mockRestore();
    }
  });

  it('stops the count at the entry its signal aborts on, with walkTree\'s abort error, and creates nothing', async () => {
    const folder = folderWith('flat', Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}.txt`, 'x'])));
    const { root, target } = uploads();
    const controller = new AbortController();
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.promises.lstat>) => {
      controller.abort();
      return fs.lstatSync(args[0]);
    });
    try {
      const error = await copyFolderForUpload(folder, target, controller.signal, roomy).then(() => undefined, (err: unknown) => err as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe('Operation aborted');
      expect(lstat.mock.calls.length).toBe(1);
    } finally {
      lstat.mockRestore();
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('stops the copy at the entry its signal aborts on, making no further folder', async () => {
    const folder = folderWith('shelves', {});
    for (let i = 0; i < 20; i++) fs.mkdirSync(path.join(folder, `d${i}`), { recursive: true });
    const { target, created } = uploads();
    const controller = new AbortController();
    const mkdir = vi.spyOn(fs.promises, 'mkdir');
    // the copy's own folder is the first mkdir, its first entry's the second
    mkdir.mockImplementation(async (...args: Parameters<typeof fs.promises.mkdir>) => {
      if (mkdir.mock.calls.length === 2) controller.abort();
      return fs.mkdirSync(...args);
    });
    try {
      await expect(copyFolderForUpload(folder, target, controller.signal, roomy)).rejects.toThrow('Operation aborted');
      expect(mkdir.mock.calls.length).toBe(2);
    } finally {
      mkdir.mockRestore();
    }
    expect(fs.readdirSync(created[0]!)).toEqual([]);
  });

  it('refuses a folder over the byte cap before creating anything, naming the folder, the cap and its setting', async () => {
    const folder = folderWith('big', { 'a.bin': 'x'.repeat(600 * 1024), 'b.bin': 'y'.repeat(600 * 1024) });
    const { root, target } = uploads();
    const error = await copyFolderForUpload(folder, target, undefined, { maxEntries: 10, maxBytes: MiB }).then(() => undefined, (err: unknown) => err as Error);
    expect(error?.message).toBe(`The folder ${folder} holds more than 1 MiB, the most a folder upload may copy; the setting damocles.browser.uploadFolderMaxSize raises that limit.`);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('lets the same folder through once the caps allow it', async () => {
    const folder = folderWith('fits', { 'a.bin': 'x'.repeat(600 * 1024), 'b.bin': 'y'.repeat(600 * 1024) });
    const { target } = uploads();
    const copied = await copyFolderForUpload(folder, target, undefined, { maxEntries: 2, maxBytes: 2 * MiB });
    expect(copied.files).toBe(2);
  });

  it('refuses a folder the volume has no room for, at 1.5 times its size, before creating anything', async () => {
    const folder = folderWith('roomy', { 'a.bin': 'x'.repeat(2 * MiB) });
    const { root, target } = uploads();
    statfs.free = MiB;
    const error = await copyFolderForUpload(folder, target, undefined, roomy).then(() => undefined, (err: unknown) => err as Error);
    expect(error?.message).toBe(`The folder ${folder} holds 2 MiB; copying it for the upload needs 3 MiB free in the browser profile's folder, which has 1 MiB free.`);
    expect(statfs.volumes).toEqual([base]);
    expect(fs.readdirSync(root)).toEqual([]);

    statfs.free = 3 * MiB - 1;
    await expect(copyFolderForUpload(folder, target, undefined, roomy)).rejects.toThrow(/needs 3 MiB free/);
    expect(fs.readdirSync(root)).toEqual([]);
    statfs.free = 3 * MiB;
    expect((await copyFolderForUpload(folder, target, undefined, roomy)).files).toBe(1);
  });

  it('rounds the amounts it needs up and the free amount down, and prints KiB or bytes below 0.1 MiB', async () => {
    // 1.5 times the folder is 3.04 MiB and 3.02 MiB is free: both would print as 3.0 at one decimal
    const near = folderWith('near', { 'a.bin': 'x'.repeat(2 * MiB + 28 * 1024) });
    const { root, target } = uploads();
    statfs.free = 3 * MiB + 20 * 1024;
    const error = await copyFolderForUpload(near, target, undefined, roomy).then(() => undefined, (err: unknown) => err as Error);
    expect(error?.message).toBe(`The folder ${near} holds 2.1 MiB; copying it for the upload needs 3.1 MiB free in the browser profile's folder, which has 3 MiB free.`);

    const small = folderWith('small', { 'a.bin': 'x'.repeat(60 * 1024 + 1) });
    statfs.free = 50 * 1024 + 1023;
    const kib = await copyFolderForUpload(small, target, undefined, roomy).then(() => undefined, (err: unknown) => err as Error);
    expect(kib?.message).toBe(`The folder ${small} holds 61 KiB; copying it for the upload needs 91 KiB free in the browser profile's folder, which has 50 KiB free.`);

    const tiny = folderWith('tiny', { 'a.txt': 'x'.repeat(600) });
    statfs.free = 1;
    const bytes = await copyFolderForUpload(tiny, target, undefined, roomy).then(() => undefined, (err: unknown) => err as Error);
    expect(bytes?.message).toBe(`The folder ${tiny} holds 600 bytes; copying it for the upload needs 900 bytes free in the browser profile's folder, which has 1 byte free.`);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('refuses, naming the check, when the free space of the profile\'s folder cannot be read, before creating anything', async () => {
    const folder = folderWith('unknown', { 'a.txt': 'A' });
    const { root, target } = uploads();
    statfs.failure = Object.assign(new Error(`EPERM: operation not permitted, statfs '${base}'`), { code: 'EPERM' });
    const error = await copyFolderForUpload(folder, target, undefined, roomy).then(() => undefined, (err: unknown) => err as Error);
    expect(error?.message).toBe(`Could not read the free space of the browser profile's folder: EPERM: operation not permitted, statfs '${base}'`);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('refuses a file that grew past the byte cap between the count and the copy, and removes the partial copy', async () => {
    const folder = folderWith('growing', { 'a.bin': 'x'.repeat(512 * 1024), 'b.bin': 'y'.repeat(256 * 1024) });
    const { target, created } = uploads(() => fs.appendFileSync(path.join(folder, 'b.bin'), 'z'.repeat(512 * 1024)));
    const error = await copyFolderForUpload(folder, target, undefined, { maxEntries: 10, maxBytes: MiB }).then(() => undefined, (err: unknown) => err as Error);
    expect(error?.message).toBe(`The folder ${folder} grew past 1 MiB while it was copied for the upload, the most a folder upload may copy; the setting damocles.browser.uploadFolderMaxSize raises that limit.`);
    expect(fs.readdirSync(created[0]!)).toEqual([]);
  });

  it('refuses a folder that gained entries past the entry cap between the count and the copy, and removes the partial copy', async () => {
    const folder = folderWith('filling', { 'a.txt': 'A', 'b.txt': 'B' });
    const { target, created } = uploads(() => fs.mkdirSync(path.join(folder, 'c')));
    const error = await copyFolderForUpload(folder, target, undefined, { maxEntries: 2, maxBytes: MiB }).then(() => undefined, (err: unknown) => err as Error);
    expect(error?.message).toBe(`The folder ${folder} grew past 2 entries while it was copied for the upload, the most a folder upload may copy, counting its files, folders and links; the setting damocles.browser.uploadFolderMaxEntries raises that limit.`);
    expect(fs.readdirSync(created[0]!)).toEqual([]);
  });
});

describe('copyFolderForUpload: a file removed while the folder is read', () => {
  const ENOENT = (file: string): Error => Object.assign(new Error(`ENOENT: no such file or directory, lstat '${file}'`), { code: 'ENOENT' });

  it('refuses as changed when a listed file is gone by the count\'s lstat', async () => {
    const folder = folderWith('fleeting', { 'a.txt': 'A' });
    const { root, target } = uploads();
    const lstat = vi.spyOn(fs.promises, 'lstat').mockImplementationOnce(async (file) => {
      fs.rmSync(file);
      throw ENOENT(String(file));
    });
    try {
      await expect(copyFolderForUpload(folder, target, undefined, roomy)).rejects.toThrow(`${path.join(folder, 'a.txt')} changed while the folder was copied for the upload; try again`);
    } finally {
      lstat.mockRestore();
    }
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('refuses as changed when a counted file is gone by the copy\'s lstat, and removes the partial copy', async () => {
    const folder = folderWith('counted', { 'a.txt': 'A' });
    const file = path.join(folder, 'a.txt');
    const { target, created } = uploads();
    const lstat = vi.spyOn(fs.promises, 'lstat');
    // the count's lstat runs as is; the copy's finds the file gone
    lstat.mockImplementation(async (...args: Parameters<typeof fs.promises.lstat>) => {
      if (lstat.mock.calls.length === 2) throw ENOENT(String(args[0]));
      return fs.lstatSync(args[0], args[1] as fs.StatSyncOptions & { bigint: true });
    });
    try {
      await expect(copyFolderForUpload(folder, target, undefined, roomy)).rejects.toThrow(`${file} changed while the folder was copied for the upload; try again`);
    } finally {
      lstat.mockRestore();
    }
    expect(fs.readdirSync(created[0]!)).toEqual([]);
  });

  it('refuses as changed when a counted subfolder is gone by the copy\'s listing, and removes the partial copy', async () => {
    const folder = folderWith('shrinking', { 'a.txt': 'A', 'sub/b.txt': 'B' });
    const sub = path.join(folder, 'sub');
    const { target, created } = uploads();
    const original = fs.promises.readdir;
    let subListings = 0;
    // the copy pass lists the folder, then finds sub gone when it lists sub
    const readdir = vi.spyOn(fs.promises, 'readdir').mockImplementation(((...args: Parameters<typeof fs.promises.readdir>) => {
      if (args[0] === sub && ++subListings === 2) fs.rmSync(sub, { recursive: true });
      return original.apply(fs.promises, args);
    }) as typeof fs.promises.readdir);
    try {
      await expect(copyFolderForUpload(folder, target, undefined, roomy)).rejects.toThrow(`${sub} changed while the folder was copied for the upload; try again`);
    } finally {
      readdir.mockRestore();
    }
    expect(fs.readdirSync(created[0]!)).toEqual([]);
  });

  it('refuses as changed when a file is gone between the copy\'s lstat and its open, and removes the partial copy', async () => {
    const folder = folderWith('vanishing', { 'a.txt': 'A' });
    const file = path.join(folder, 'a.txt');
    const { target, created } = uploads();
    const open = vi.spyOn(fs.promises, 'open');
    open.mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      if (args[0] === file) fs.rmSync(file);
      open.mockRestore();
      return fs.promises.open(...args);
    });
    try {
      await expect(copyFolderForUpload(folder, target, undefined, roomy)).rejects.toThrow(`${file} changed while the folder was copied for the upload; try again`);
    } finally {
      open.mockRestore();
    }
    expect(fs.readdirSync(created[0]!)).toEqual([]);
  });
});

describe.runIf(process.platform === 'win32')('copyFolderForUpload: links (win32)', () => {
  it('leaves out a link to a named pipe, a file link and a junction, and opens none of them', async () => {
    const pipe = `\\\\.\\pipe\\dam-upload-copy-${process.pid}-${++counter}`;
    let connections = 0;
    const server = net.createServer((socket) => {
      connections++;
      socket.end();
    });
    await new Promise<void>((resolve) => server.listen(pipe, resolve));
    try {
      const folder = folderWith('shared', { 'a.txt': 'A', 'sub/s.txt': 'S' });
      const outside = folderWith('outside', { 'o.txt': 'O' });
      fs.symlinkSync(pipe, path.join(outside, 'pipe-again'), 'file');
      fs.symlinkSync(pipe, path.join(folder, 'pipe'), 'file');
      fs.symlinkSync(path.join(outside, 'o.txt'), path.join(folder, 'sub', 'file-link'), 'file');
      fs.symlinkSync(outside, path.join(folder, 'junction'), 'junction');
      const copied = await copyFolderForUpload(folder, uploads().target, undefined, roomy);
      // a pipe connects as it opens, so one the copy made has reached the server by now
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(connections).toBe(0);
      expect(copied.files).toBe(2);
      expect([...copied.leftOut].sort()).toEqual(['junction', 'pipe', path.join('sub', 'file-link')]);
      expect(contents(copied.copy)).toEqual(['a.txt=A', 'sub/', 'sub/s.txt=S']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
