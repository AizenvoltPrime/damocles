import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// links: each faked link's path, lowercased, and what readlink answers for it (a share or WSL path); the link really leads to
// a local folder. touched: every file system call naming a path through a faked link (lstat and readlink of the link itself
// excepted) or a UNC path, which the network rule forbids the factory to make.
// recursive: every recursive fs.watch, with the factory's own listener, which a test calls to deliver what Node would; dropping:
// drops what those watches really report. lstats: every lstatSync path.
const H = vi.hoisted(() => ({
  links: new Map<string, string>(),
  touched: [] as string[],
  recursive: [] as Array<{ readonly watcher: import('node:fs').FSWatcher; readonly deliver: (eventType: string, filename: string | null) => void }>,
  dropping: false,
  lstats: [] as string[],
  forbidden(op: string, file: string): boolean {
    const spelled = file.toLowerCase();
    if (/^[\\/]{2}/.test(spelled)) return true;
    for (const link of this.links.keys()) {
      if (spelled === link && op !== 'lstat' && op !== 'readlink') return true;
      if (spelled.startsWith(`${link}\\`) || spelled.startsWith(`${link}/`)) return true;
    }
    return false;
  },
}));

const fsMock = vi.hoisted(() => (actual: typeof import('node:fs')) => {
  const guard = <F extends (...args: never[]) => unknown>(op: string, fn: F): F => ((...args: Parameters<F>) => {
    if (H.forbidden(op, String(args[0]))) H.touched.push(`${op} ${String(args[0])}`);
    return fn(...args);
  }) as F;
  const readlinkSync = ((file: import('node:fs').PathLike, ...rest: unknown[]) => H.links.get(String(file).toLowerCase()) ?? (actual.readlinkSync as (...a: unknown[]) => unknown)(file, ...rest)) as typeof actual.readlinkSync;
  const realpathSync = Object.assign(guard('realpath', actual.realpathSync), { native: guard('realpath', actual.realpathSync.native) });
  const promises = {
    ...actual.promises,
    lstat: guard('lstat', actual.promises.lstat),
    readdir: guard('readdir', actual.promises.readdir),
    realpath: guard('realpath', actual.promises.realpath),
    stat: guard('stat', actual.promises.stat),
  };
  const lstatSync = guard('lstat', actual.lstatSync);
  const watch = guard('watch', actual.watch);
  const overrides = {
    lstatSync: ((file: import('node:fs').PathLike, ...rest: unknown[]) => {
      H.lstats.push(String(file));
      return (lstatSync as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.lstatSync,
    statSync: guard('stat', actual.statSync),
    existsSync: guard('exists', actual.existsSync),
    readdirSync: guard('readdir', actual.readdirSync),
    watch: ((target: string, options: unknown, listener?: (eventType: string, filename: string | null) => void) => {
      if (!(options as { recursive?: boolean } | undefined)?.recursive || !listener) return (watch as (...a: unknown[]) => unknown)(target, options, listener);
      const watcher = (watch as (...a: unknown[]) => import('node:fs').FSWatcher)(target, options, (eventType: string, filename: string | null) => {
        if (!H.dropping) listener(eventType, filename);
      });
      H.recursive.push({ watcher, deliver: listener });
      return watcher;
    }) as typeof actual.watch,
    readlinkSync,
    realpathSync,
    promises,
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
vi.mock('node:fs', async (importOriginal) => fsMock(await importOriginal<typeof import('node:fs')>()));

import * as fs from 'node:fs';
import type { FileWatcher } from '../../../platform/file-watcher';
import { createInProcessTreeHost, REOPEN_FIRST_MS, SHALLOW_COALESCE_MS } from '../../watch-worker/fs-watch-tree';
import { DesktopFileWatcherFactory } from '../file-watcher-factory';
import { literalGlob } from '../../../core/watch-root';

let base: string;
// the local folder every faked link really leads to
let marker: string;
let factory: DesktopFileWatcherFactory;
let lines: string[];
const noFolders = { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) };
const WAIT = { timeout: 15_000 };

const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SHALLOW_COALESCE_MS * 6));

// A junction at `at` the network walk reads as one onto `target`, which really leads to marker.
function linkOff(at: string, target: string): void {
  fs.symlinkSync(marker, at, 'junction');
  H.links.set(at.toLowerCase(), target);
}

function created(watcher: FileWatcher): string[] {
  const seen: string[] = [];
  watcher.onDidCreate((fsPath) => seen.push(path.relative(base, fsPath).split(path.sep).join('/')));
  return seen;
}

beforeEach(() => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dm-watch-net-')));
  base = path.join(root, 'base');
  marker = path.join(root, 'marker');
  fs.mkdirSync(base);
  fs.mkdirSync(path.join(marker, 'sub'), { recursive: true });
  lines = [];
  const log = (line: string): number => lines.push(line);
  factory = new DesktopFileWatcherFactory(noFolders, log, createInProcessTreeHost(log));
  H.links.clear();
  H.touched.length = 0;
  H.recursive.length = 0;
  H.dropping = false;
  H.lstats.length = 0;
});

afterEach(async () => {
  H.dropping = false;
  await factory.close();
  H.links.clear();
  fs.rmSync(path.dirname(base), { recursive: true, force: true });
});

describe.runIf(process.platform === 'win32')('DesktopFileWatcherFactory under the network rule (win32)', { timeout: 30_000 }, () => {
  it.each([
    ['a share, recursively', 'linked/**', 'linked', '\\\\host\\share\\x'],
    ['WSL, recursively', 'linked/**', 'linked', '\\\\wsl.localhost\\Ubuntu\\home\\me'],
    ['a share, a folder below the link', 'linked/sub/*.json', 'linked/sub', '\\\\host\\share\\x'],
    ['a device path, its direct children', 'linked/*', 'linked', '\\\\?\\GLOBALROOT\\Device\\x'],
  ])('never stats or watches through a link below the base onto %s, and logs it once', async (_name, glob, watched, target) => {
    const link = path.join(base, 'linked');
    linkOff(link, target);
    const watcher = factory.watch(base, glob);
    const seen = created(watcher);
    await watcher.ready;
    // a change beside the link wakes the wait for the root, which judges the link again
    fs.writeFileSync(path.join(base, 'other.txt'), 'x');
    fs.writeFileSync(path.join(marker, 'sub', 'a.json'), '{}');
    await quiet();
    expect(H.touched).toEqual([]);
    expect(seen).toEqual([]);
    const root = path.join(base, ...watched.split('/'));
    expect(lines.filter((line) => line.includes('network rule'))).toEqual([`[watcher] ${link} is not followed under the network rule (a link onto a network share, WSL or device path off the share of ${base}, or one the check could not follow); ${root} is not watched through it`]);
  });

  it('judges a literal folder whose name holds glob syntax from the base, watching only that folder', async () => {
    fs.mkdirSync(path.join(base, 'sub'));
    const link = path.join(base, 'sub', 'New folder (2)');
    linkOff(link, '\\\\host\\share\\x');
    const watcher = factory.watch(base, `${literalGlob('sub/New folder (2)')}/*`);
    const seen = created(watcher);
    await watcher.ready;
    fs.writeFileSync(path.join(base, 'sub', 'other.txt'), 'x');
    fs.writeFileSync(path.join(marker, 'a.txt'), 'x');
    await quiet();
    expect(H.touched).toEqual([]);
    expect(seen).toEqual([]);
    expect(H.recursive).toEqual([]);
    expect(lines.filter((line) => line.includes('network rule'))).toEqual([`[watcher] ${link} is not followed under the network rule (a link onto a network share, WSL or device path off the share of ${base}, or one the check could not follow); ${link} is not watched through it`]);
  });

  it('starts the watch once the refused link is replaced by a folder', async () => {
    const link = path.join(base, 'linked');
    linkOff(link, '\\\\host\\share\\x');
    const watcher = factory.watch(base, 'linked/*.txt');
    const seen = created(watcher);
    await watcher.ready;
    fs.rmdirSync(link);
    H.links.delete(link.toLowerCase());
    fs.mkdirSync(link);
    await vi.waitFor(() => {
      fs.writeFileSync(path.join(link, `${seen.length}-${Date.now()}.txt`), 'x');
      expect(seen.length).toBeGreaterThan(0);
    }, WAIT);
    expect(H.touched).toEqual([]);
  });

  it.each([['recursive', 'linked/**'], ['shallow', 'linked/*']])('stops a live %s watch whose folder is swapped for a link onto a share, without touching the link', async (_name, glob) => {
    const folder = path.join(base, 'linked');
    fs.mkdirSync(folder);
    const watcher = factory.watch(base, glob);
    const seen = created(watcher);
    await watcher.ready;
    await vi.waitFor(() => {
      fs.writeFileSync(path.join(folder, `${seen.length}-${Date.now()}.txt`), 'x');
      expect(seen.length).toBeGreaterThan(0);
    }, WAIT);
    await quiet();
    fs.rmSync(folder, { recursive: true });
    linkOff(folder, '\\\\host\\share\\x');
    await vi.waitFor(() => expect(lines.some((line) => line.includes('network rule'))).toBe(true), WAIT);
    seen.length = 0;
    fs.writeFileSync(path.join(marker, 'later.txt'), 'x');
    fs.writeFileSync(path.join(base, 'beside.txt'), 'x');
    await quiet();
    expect(H.touched).toEqual([]);
    expect(seen).toEqual([]);
  });

  // A restarted watch worker starts every watch again directly, with no check of the factory's before it.
  it('judges the root before a Windows tree starts, touching nothing through a refused link', () => {
    const link = path.join(base, 'linked');
    linkOff(link, '\\\\host\\share\\x');
    const host = createInProcessTreeHost(() => undefined);
    expect(() => host.start(path.join(link, 'sub'), false, () => undefined, () => undefined, base)).toThrow(link);
    expect(H.touched).toEqual([]);
  });

  it('judges the root again before a Windows tree reopens its handle, never watching through a link swapped in during the delay', async () => {
    const folder = path.join(base, 'linked');
    fs.mkdirSync(folder);
    const watcher = factory.watch(base, 'linked/**');
    const seen = created(watcher);
    await watcher.ready;
    await vi.waitFor(() => {
      fs.writeFileSync(path.join(folder, `${seen.length}-${Date.now()}.txt`), 'x');
      expect(seen.length).toBeGreaterThan(0);
    }, WAIT);
    await quiet();
    H.recursive.at(-1)!.watcher.emit('error', Object.assign(new Error('EPERM: operation not permitted, watch'), { code: 'EPERM' }));
    expect(lines).toContain(`[watcher] watching ${folder} again in ${REOPEN_FIRST_MS} ms`);
    fs.rmSync(folder, { recursive: true });
    linkOff(folder, '\\\\host\\share\\x');
    await new Promise((resolve) => setTimeout(resolve, REOPEN_FIRST_MS + SHALLOW_COALESCE_MS * 6));
    expect(H.touched).toEqual([]);
    expect(lines.some((line) => line.includes('network rule'))).toBe(true);
  });

  it('judges the root again before an overflow rescan lists it', async () => {
    const folder = path.join(base, 'linked');
    fs.mkdirSync(folder);
    const watcher = factory.watch(base, 'linked/**');
    const seen = created(watcher);
    await watcher.ready;
    await vi.waitFor(() => {
      fs.writeFileSync(path.join(folder, `${seen.length}-${Date.now()}.txt`), 'x');
      expect(seen.length).toBeGreaterThan(0);
    }, WAIT);
    await quiet();
    H.dropping = true;
    fs.rmSync(folder, { recursive: true });
    linkOff(folder, '\\\\host\\share\\x');
    H.recursive.at(-1)!.deliver('change', null);
    await quiet();
    expect(H.touched).toEqual([]);
    expect(lines.some((line) => line.includes('network rule'))).toBe(true);
  });

  it('judges a shallow watch once per batch of events, never on each raw event', async () => {
    const folder = path.join(base, 'linked');
    fs.mkdirSync(folder);
    const watcher = factory.watch(base, 'linked/*');
    const seen = created(watcher);
    await watcher.ready;
    H.lstats.length = 0;
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(folder, `${i}.txt`), 'x');
    await vi.waitFor(() => expect(seen).toHaveLength(50), WAIT);
    await quiet();
    // each write raises at least two raw events, and the walk lstats the folder once
    expect(H.lstats.filter((file) => file === folder).length).toBeLessThan(25);
  });
});
