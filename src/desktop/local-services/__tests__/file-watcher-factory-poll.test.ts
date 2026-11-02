import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FsWatchTreeHost } from '../../watch-worker/fs-watch-tree';

const H = vi.hoisted(() => ({ watched: [] as string[] }));

// fs.watch calls are recorded: a polled root holds no inotify watch
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: ((...args: Parameters<typeof actual.watch>) => {
      H.watched.push(String(args[0]));
      return actual.watch(...args);
    }) as typeof actual.watch,
  };
});

const fs = await import('node:fs');
const { DesktopFileWatcherFactory } = await import('../file-watcher-factory');

const noWindowsTree: FsWatchTreeHost = { start: () => { throw new Error('no Windows tree on Linux'); }, close: async () => undefined };
const folders = { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) };

// the factory chooses a mode only where it watches with the inotify tree
describe.skipIf(process.platform !== 'linux')('the watcher factory on a polled root', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-poll-'));
    H.watched.length = 0;
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('polls every root on WSL 1, holding no fs.watch, and still reports changes', { timeout: 20_000 }, async () => {
    const logs: string[] = [];
    const factory = new DesktopFileWatcherFactory(folders, (line) => logs.push(line), noWindowsTree, {
      osrelease: () => '4.4.0-26100-Microsoft',
      mountinfo: () => '2 2 0:2 / / rw - lxfs rootfs rw',
      realpath: (target) => target,
      log: (line) => logs.push(line),
    });
    const tree = factory.watch(root, '**/*');
    const shallow = factory.watch(root, '*.json');
    const created: string[] = [];
    tree.onDidCreate((fsPath) => created.push(fsPath));
    await Promise.all([tree.ready, shallow.ready]);
    fs.mkdirSync(path.join(root, 'folder'));
    fs.renameSync(path.join(root, 'folder'), path.join(root, 'renamed'));
    fs.writeFileSync(path.join(root, 'renamed', 'file.txt'), 'x');
    await vi.waitFor(() => expect(created).toContain(path.join(root, 'renamed', 'file.txt')), { timeout: 15_000, interval: 200 });
    expect(H.watched).toEqual([]);
    expect(logs).toContain(`[watcher] ${root} is polled every 5000 ms`);
    tree.dispose();
    shallow.dispose();
    await factory.close();
  });

  it('ends a polled root whose first snapshot cannot be taken as a watch that could not start, logged', async () => {
    const logs: string[] = [];
    const factory = new DesktopFileWatcherFactory(folders, (line) => logs.push(line), noWindowsTree, {
      osrelease: () => '4.4.0-26100-Microsoft',
      mountinfo: () => '2 2 0:2 / / rw - lxfs rootfs rw',
      realpath: (target) => target,
      log: (line) => logs.push(line),
    });
    const tmpdir = process.env['TMPDIR'];
    // the snapshot folder cannot be made under a temp folder that does not exist
    process.env['TMPDIR'] = path.join(root, 'missing-temp');
    try {
      const tree = factory.watch(root, '**/*');
      await tree.ready;
      await vi.waitFor(() => expect(logs.some((line) => line.startsWith(`[watcher] could not watch ${root}: ENOENT`))).toBe(true));
      tree.dispose();
    } finally {
      if (tmpdir === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = tmpdir;
    }
    expect(H.watched).toEqual([]);
    await factory.close();
  });

  it('waits for a missing polled root by a check every 5 s, holding no fs.watch on an ancestor, and polls it once it is there', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const factory = new DesktopFileWatcherFactory(folders, () => undefined, noWindowsTree, {
        osrelease: () => '4.4.0-26100-Microsoft',
        mountinfo: () => '2 2 0:2 / / rw - lxfs rootfs rw',
        realpath: (target) => target,
        log: () => undefined,
      });
      const later = path.join(root, 'later');
      const tree = factory.watch(later, '**/*');
      const created: string[] = [];
      tree.onDidCreate((fsPath) => created.push(fsPath));
      await tree.ready;
      expect(vi.getTimerCount()).toBe(1);
      fs.mkdirSync(later);
      fs.writeFileSync(path.join(later, 'made.txt'), 'x');
      vi.advanceTimersByTime(4_999);
      await new Promise((resolve) => setImmediate(resolve));
      expect(created).toEqual([]);
      // the check finds the root, stops waiting and starts the poll, which reports what the root already holds
      vi.advanceTimersByTime(1);
      await new Promise((resolve) => setImmediate(resolve));
      expect(created).toEqual([path.join(later, 'made.txt')]);
      expect(vi.getTimerCount()).toBe(0);
      expect(H.watched).toEqual([]);
      tree.dispose();
      await factory.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the inotify tree for a root on the distro\'s own file system', async () => {
    const factory = new DesktopFileWatcherFactory(folders, () => undefined, noWindowsTree, {
      osrelease: () => '6.18.54.1-microsoft-standard-WSL2',
      mountinfo: () => '67 59 8:48 / / rw,relatime - ext4 /dev/sdd rw',
      realpath: (target) => target,
      log: () => undefined,
    });
    const tree = factory.watch(root, '**/*');
    await tree.ready;
    expect(H.watched).toContain(root);
    tree.dispose();
    await factory.close();
  });
});
