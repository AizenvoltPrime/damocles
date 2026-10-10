import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface RecursiveWatch {
  readonly watcher: import('node:fs').FSWatcher;
  // The factory's own listener, which a test calls to deliver what Node would.
  readonly deliver: (eventType: string, filename: string | null) => void;
  open: boolean;
}

const H = vi.hoisted(() => ({
  parcelLoaded: false,
  // Drops what the real recursive watches report, as a change buffer that overflowed does.
  dropping: false,
  // Holds every fs.promises.readdir until it settles.
  gate: undefined as Promise<void> | undefined,
  recursive: [] as RecursiveWatch[],
  statted: [] as string[],
}));

// Windows must never load @parcel/watcher; the factory runs only if something imports it.
vi.mock('@parcel/watcher', () => {
  H.parcelLoaded = true;
  return {};
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: ((p: import('node:fs').PathLike, options?: unknown) => {
      H.statted.push(String(p));
      return actual.lstatSync(p, options as never);
    }) as typeof actual.lstatSync,
    promises: {
      ...actual.promises,
      lstat: ((p: import('node:fs').PathLike, options?: unknown) => {
        H.statted.push(String(p));
        return actual.promises.lstat(p, options as never);
      }) as typeof actual.promises.lstat,
      readdir: (async (...args: unknown[]) => {
        await H.gate;
        return actual.promises.readdir(...(args as [string]));
      }) as typeof actual.promises.readdir,
    },
    watch: ((target: string, options: unknown, listener?: (eventType: string, filename: string | null) => void) => {
      if (!(options as { recursive?: boolean } | undefined)?.recursive || !listener) return actual.watch(target, options as never, listener as never);
      const watcher = actual.watch(target, options as never, (eventType: string, filename: string | null) => {
        if (!H.dropping) listener(eventType, filename);
      });
      const entry: RecursiveWatch = { watcher, deliver: listener, open: true };
      const close = watcher.close.bind(watcher);
      watcher.close = () => {
        entry.open = false;
        close();
      };
      H.recursive.push(entry);
      return watcher;
    }) as typeof actual.watch,
  };
});

import * as fs from 'node:fs';
import type { FileWatcher } from '../../../platform/file-watcher';
import { createInProcessTreeHost, REOPEN_FIRST_MS, SHALLOW_COALESCE_MS } from '../../watch-worker/fs-watch-tree';
import { DesktopFileWatcherFactory } from '../platform/file-watcher-factory';

let dir: string;
let factory: DesktopFileWatcherFactory;
let lines: string[];
const noFolders = { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) };
const WAIT = { timeout: 15_000 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Long enough for a flush and the scans it queues to settle.
const quiet = (): Promise<void> => sleep(SHALLOW_COALESCE_MS * 6);

function openWatches(): RecursiveWatch[] {
  return H.recursive.filter((entry) => entry.open);
}

// Every event as "<type> <path under base>", with / separators.
function record(watcher: FileWatcher, base = dir): string[] {
  const events: string[] = [];
  const add = (type: string) => (fsPath: string): void => {
    events.push(`${type} ${path.relative(base, fsPath).split(path.sep).join('/')}`);
  };
  watcher.onDidCreate(add('create'));
  watcher.onDidChange(add('change'));
  watcher.onDidDelete(add('delete'));
  return events;
}

// The startup scan absorbs what it lists, so a fresh probe name is written until one is reported; its stragglers then settle.
async function live(watcher: FileWatcher, root = dir): Promise<void> {
  const seen = vi.fn();
  const subscription = watcher.onDidCreate(seen);
  fs.mkdirSync(path.join(root, 'probe'), { recursive: true });
  let attempt = 0;
  await vi.waitFor(() => {
    fs.writeFileSync(path.join(root, 'probe', String(attempt++)), 'probe');
    expect(seen).toHaveBeenCalled();
  }, WAIT);
  subscription.dispose();
  await quiet();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-watch-win-'));
  lines = [];
  const log = (line: string): number => lines.push(line);
  // The tree runs on this thread, where the node:fs mock above reaches it.
  factory = new DesktopFileWatcherFactory(noFolders, log, createInProcessTreeHost(log));
  H.dropping = false;
  H.gate = undefined;
  H.recursive.length = 0;
  H.statted.length = 0;
});

afterEach(async () => {
  H.dropping = false;
  H.gate = undefined;
  await factory.close();
  fs.rmSync(dir, { recursive: true, force: true });
  expect(H.parcelLoaded).toBe(false);
});

// Real ReadDirectoryChangesW watches through Node's recursive fs.watch, the Windows backend.
describe.runIf(process.platform === 'win32')('DesktopFileWatcherFactory on Windows', { timeout: 30_000 }, () => {
  it('reports a file created, changed, renamed and deleted, and nothing for a read', async () => {
    const watcher = factory.watch(dir, '**');
    await live(watcher);
    const events = record(watcher);
    const file = path.join(dir, 'a.txt');

    fs.writeFileSync(file, 'one');
    await vi.waitFor(() => expect(events).toEqual(['create a.txt']), WAIT);
    fs.appendFileSync(file, ' two');
    await vi.waitFor(() => expect(events).toContain('change a.txt'), WAIT);
    // A read moves the last-access time, which Windows reports as a change to the file and its directory.
    const old = new Date(Date.now() - 3 * 3600_000);
    fs.utimesSync(file, old, fs.statSync(file).mtime);
    await quiet();
    events.length = 0;
    fs.readFileSync(file);
    await quiet();
    expect(events).toEqual([]);

    fs.renameSync(file, path.join(dir, 'b.txt'));
    await vi.waitFor(() => expect(events).toEqual(['delete a.txt', 'create b.txt']), WAIT);
    fs.rmSync(path.join(dir, 'b.txt'));
    await vi.waitFor(() => expect(events).toContain('delete b.txt'), WAIT);
    await quiet();
    expect(events).toEqual(['delete a.txt', 'create b.txt', 'delete b.txt']);
  });

  it('reports an atomic replace as a change, never a create', async () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{}');
    const watcher = factory.watch(dir, '**');
    await live(watcher);
    const events = record(watcher);

    fs.writeFileSync(`${file}.tmp`, '{"a":1}');
    fs.renameSync(`${file}.tmp`, file);
    await vi.waitFor(() => expect(events).toContain('change settings.json'), WAIT);
    await quiet();
    expect(events.filter((event) => event.endsWith('settings.json'))).toEqual(['change settings.json']);
  });

  it('reports a directory made with its contents, moved in, renamed, moved out and deleted, once per entry', async () => {
    const watcher = factory.watch(dir, '**');
    await live(watcher);
    const events = record(watcher);
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-stage-'));
    try {
      fs.mkdirSync(path.join(dir, 'made', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'made', 'deep', 'm.txt'), 'x');
      await vi.waitFor(() => expect(events).toContain('create made/deep/m.txt'), WAIT);
      await quiet();
      expect([...events].sort()).toEqual(['create made', 'create made/deep', 'create made/deep/m.txt']);

      events.length = 0;
      fs.mkdirSync(path.join(staging, 'pack', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(staging, 'pack', 'a.txt'), 'x');
      fs.writeFileSync(path.join(staging, 'pack', 'sub', 'b.txt'), 'x');
      fs.renameSync(path.join(staging, 'pack'), path.join(dir, 'pack'));
      await vi.waitFor(() => expect(events).toContain('create pack/sub/b.txt'), WAIT);
      await quiet();
      expect([...events].sort()).toEqual(['create pack', 'create pack/a.txt', 'create pack/sub', 'create pack/sub/b.txt']);

      events.length = 0;
      fs.renameSync(path.join(dir, 'pack'), path.join(dir, 'renamed'));
      await vi.waitFor(() => expect(events).toContain('create renamed/sub/b.txt'), WAIT);
      await quiet();
      expect([...events].sort()).toEqual([
        'create renamed', 'create renamed/a.txt', 'create renamed/sub', 'create renamed/sub/b.txt',
        'delete pack', 'delete pack/a.txt', 'delete pack/sub', 'delete pack/sub/b.txt',
      ]);

      events.length = 0;
      fs.renameSync(path.join(dir, 'renamed'), path.join(staging, 'out'));
      await vi.waitFor(() => expect(events).toContain('delete renamed'), WAIT);
      await quiet();
      expect([...events].sort()).toEqual(['delete renamed', 'delete renamed/a.txt', 'delete renamed/sub', 'delete renamed/sub/b.txt']);

      events.length = 0;
      fs.rmSync(path.join(dir, 'made'), { recursive: true });
      await vi.waitFor(() => expect(events).toContain('delete made'), WAIT);
      await quiet();
      expect([...events].sort()).toEqual(['delete made', 'delete made/deep', 'delete made/deep/m.txt']);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });

  it('reports a case-only rename of a file or a directory as a delete and a create', async () => {
    fs.writeFileSync(path.join(dir, 'readme.md'), 'x');
    fs.mkdirSync(path.join(dir, 'Docs'));
    fs.writeFileSync(path.join(dir, 'Docs', 'a.md'), 'x');
    const watcher = factory.watch(dir, '**');
    await live(watcher);
    const events = record(watcher);

    fs.renameSync(path.join(dir, 'readme.md'), path.join(dir, 'README.md'));
    await vi.waitFor(() => expect(events).toContain('create README.md'), WAIT);
    await quiet();
    expect(events).toEqual(['delete readme.md', 'create README.md']);

    events.length = 0;
    fs.renameSync(path.join(dir, 'Docs'), path.join(dir, 'docs'));
    await vi.waitFor(() => expect(events).toContain('create docs/a.md'), WAIT);
    await quiet();
    expect(events).toEqual(['delete Docs/a.md', 'delete Docs', 'create docs', 'create docs/a.md']);
  });

  it('never stats or reports a path in the ignore set', async () => {
    const watcher = factory.watch(dir, '**');
    await live(watcher);
    const events = record(watcher);
    H.statted.length = 0;
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-stage-'));
    try {
      fs.mkdirSync(path.join(staging, 'pkg'));
      fs.writeFileSync(path.join(staging, 'pkg', 'index.js'), 'x');
      fs.mkdirSync(path.join(dir, 'node_modules'));
      fs.renameSync(path.join(staging, 'pkg'), path.join(dir, 'node_modules', 'pkg'));
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, 'node_modules', `f${i}.js`), 'x');
    fs.mkdirSync(path.join(dir, '.git', 'objects', 'ab'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'objects', 'ab', 'cdef'), 'x');
    fs.writeFileSync(path.join(dir, 'src.md'), 'x');
    await vi.waitFor(() => expect(events).toContain('create src.md'), WAIT);
    await quiet();

    expect(events.filter((event) => event.includes('node_modules') || event.includes('objects'))).toEqual([]);
    expect(H.statted.filter((p) => p.includes('node_modules') || p.includes(`${path.sep}objects`))).toEqual([]);
  });

  it('reports the files of a deleted root, closes its handle, and reports what the recreated root holds once', async () => {
    const root = path.join(dir, 'project');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'x');
    const watcher = factory.watch(root, '**');
    await live(watcher, root);
    const events = record(watcher, root);

    fs.rmSync(root, { recursive: true });
    await vi.waitFor(() => expect(lines).toContain(`[watcher] ${root} is gone; watching for it to come back`), WAIT);
    expect(events).toEqual(expect.arrayContaining(['delete sub/a.txt', 'delete sub']));
    expect(openWatches()).toEqual([]);
    expect(fs.existsSync(root)).toBe(false);

    events.length = 0;
    const staging = fs.mkdtempSync(path.join(dir, 'stage-'));
    fs.mkdirSync(path.join(staging, 'again'));
    fs.writeFileSync(path.join(staging, 'b.txt'), 'x');
    fs.writeFileSync(path.join(staging, 'again', 'c.txt'), 'x');
    fs.renameSync(staging, root);
    await vi.waitFor(() => expect(events).toContain('create again/c.txt'), WAIT);
    await quiet();
    expect([...events].sort()).toEqual(['create again', 'create again/c.txt', 'create b.txt']);
    expect(openWatches()).toHaveLength(1);
  });

  it('rescans on a null filename and reports exactly what changed while events were lost', async () => {
    fs.writeFileSync(path.join(dir, 'kept.txt'), 'kept');
    fs.writeFileSync(path.join(dir, 'edited.txt'), 'before');
    fs.writeFileSync(path.join(dir, 'removed.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'old', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'old', 'inner', 'x.txt'), 'x');
    const watcher = factory.watch(dir, '**');
    await live(watcher);
    const events = record(watcher);

    H.dropping = true;
    fs.writeFileSync(path.join(dir, 'edited.txt'), 'after, and longer');
    fs.rmSync(path.join(dir, 'removed.txt'));
    fs.writeFileSync(path.join(dir, 'added.txt'), 'x');
    fs.mkdirSync(path.join(dir, 'fresh', 'inner'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'fresh', 'inner', 'f.txt'), 'x');
    fs.rmSync(path.join(dir, 'old'), { recursive: true });
    await quiet();
    H.dropping = false;
    expect(events).toEqual([]);

    openWatches()[0]!.deliver('change', null);
    await vi.waitFor(() => expect(events).toContain('create fresh/inner/f.txt'), WAIT);
    await quiet();
    expect([...events].sort()).toEqual([
      'change edited.txt',
      'create added.txt', 'create fresh', 'create fresh/inner', 'create fresh/inner/f.txt',
      'delete old', 'delete old/inner', 'delete old/inner/x.txt', 'delete removed.txt',
    ]);
    expect(lines.filter((line) => line.includes('rescanning'))).toHaveLength(1);

    // A second overflow within the note interval rescans without another log line, and finds nothing new.
    openWatches()[0]!.deliver('change', null);
    await quiet();
    expect(events).toHaveLength(9);
    expect(lines.filter((line) => line.includes('rescanning'))).toHaveLength(1);
  });

  it('reports every file of a burst of thousands exactly once, and nothing else', async () => {
    const burst = path.join(dir, 'burst');
    fs.mkdirSync(burst);
    const watcher = factory.watch(dir, '**');
    await live(watcher);
    const events = record(watcher);
    const count = 3000;

    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(burst, `file-${i}.txt`), `content ${i}`);
    await vi.waitFor(() => expect(new Set(events).size).toBe(count), WAIT);
    await sleep(500);
    expect(events).toHaveLength(count);
    expect(new Set(events)).toEqual(new Set(Array.from({ length: count }, (_, i) => `create burst/file-${i}.txt`)));
  });

  it('emits nothing once closed during a rescan, and close waits for that rescan', async () => {
    const watcher = factory.watch(dir, '**');
    await live(watcher);
    const events = record(watcher);
    H.dropping = true;
    fs.writeFileSync(path.join(dir, 'lost.txt'), 'x');
    await quiet();
    H.dropping = false;
    let release!: () => void;
    H.gate = new Promise((resolve) => (release = resolve));

    openWatches()[0]!.deliver('change', null);
    let closed = false;
    const closing = factory.close().then(() => {
      closed = true;
    });
    await sleep(100);
    expect(closed).toBe(false);
    release();
    await closing;
    await quiet();
    expect(events).toEqual([]);
    expect(openWatches()).toEqual([]);
  });

  it('opens the watch again after an error and reports what changed while it was down', async () => {
    const watcher = factory.watch(dir, '**');
    await live(watcher);
    const events = record(watcher);
    const first = openWatches()[0]!;

    first.watcher.emit('error', Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' }));
    expect(first.open).toBe(false);
    expect(lines).toContain(`[watcher] ${dir}: EPERM: operation not permitted, watch`);
    expect(lines).toContain(`[watcher] watching ${dir} again in ${REOPEN_FIRST_MS} ms`);
    fs.writeFileSync(path.join(dir, 'meanwhile.txt'), 'x');
    await vi.waitFor(() => expect(events).toContain('create meanwhile.txt'), WAIT);
    expect(openWatches()).toHaveLength(1);
    expect(openWatches()[0]).not.toBe(first);

    fs.writeFileSync(path.join(dir, 'after.txt'), 'x');
    await vi.waitFor(() => expect(events).toContain('create after.txt'), WAIT);
    await quiet();
    expect(events).toEqual(['create meanwhile.txt', 'create after.txt']);
  });

  it('shares one recursive handle per root and closes it with the last watcher', async () => {
    const first = factory.watch(dir, '**/*.md');
    const second = factory.watch(dir, '**/*.txt');
    expect(openWatches()).toHaveLength(1);
    first.dispose();
    expect(openWatches()).toHaveLength(1);
    second.dispose();
    expect(openWatches()).toEqual([]);
  });

  it('reports paths under the 8.3 short form the root was given', async () => {
    const long = path.join(fs.realpathSync.native(dir), 'Long Directory Name');
    fs.mkdirSync(long);
    const short = execSync(`for %I in ("${long}") do @echo %~sI`, { shell: 'cmd.exe', encoding: 'utf8' }).trim();
    const watcher = factory.watch(short, '**');
    await live(watcher, short);
    const created = vi.fn();
    watcher.onDidCreate(created);

    fs.mkdirSync(path.join(long, 'Nested Folder'));
    fs.writeFileSync(path.join(long, 'Nested Folder', 'Some File.txt'), 'x');
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(path.join(short, 'Nested Folder', 'Some File.txt')), WAIT);
    expect(created.mock.calls.map(([p]) => String(p)).every((p) => p.startsWith(`${short}${path.sep}`))).toBe(true);
  });

  it('never loads @parcel/watcher', async () => {
    const watcher = factory.watch(dir, '**');
    await live(watcher);
    watcher.dispose();
    await factory.close();
    expect(H.parcelLoaded).toBe(false);
  });
});
