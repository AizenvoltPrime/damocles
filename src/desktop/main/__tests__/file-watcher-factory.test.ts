import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  hiddenOnce: new Set<string>(),
  unlistable: new Set<string>(),
  openWatches: new Set<object>(),
}));

// Pass-through, except for the paths a test marks (one existsSync that answers false, a replay listing that fails); fs.watch handles are counted.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: import('node:fs').PathLike) => {
      if (H.hiddenOnce.delete(String(p))) return false;
      return actual.existsSync(p);
    },
    readdirSync: ((p: import('node:fs').PathLike, options?: unknown) => {
      if (H.unlistable.has(String(p)) && (options as { withFileTypes?: boolean } | undefined)?.withFileTypes) {
        throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(p)}'`), { code: 'EACCES' });
      }
      return actual.readdirSync(p, options as never);
    }) as typeof actual.readdirSync,
    watch: ((...args: Parameters<typeof actual.watch>) => {
      const watcher = actual.watch(...args);
      H.openWatches.add(watcher);
      const close = watcher.close.bind(watcher);
      watcher.close = () => {
        H.openWatches.delete(watcher);
        close();
      };
      return watcher;
    }) as typeof actual.watch,
  };
});

import * as fs from 'node:fs';
import type { OpenFolder, WorkspaceFolders } from '../../../platform/workspace-folders';
import type { FileWatcher } from '../../../platform/file-watcher';
import { DesktopFileWatcherFactory, isShallowGlob, SHALLOW_COALESCE_MS, watchRoot } from '../platform/file-watcher-factory';

let dir: string;
let factory: DesktopFileWatcherFactory;
let lines: string[];
const noFolders: WorkspaceFolders = { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) };
const WAIT = { timeout: 8000 };

beforeEach(() => {
  // Not realpath'd: the temp directory may sit under a symlink (macOS /var) or an 8.3 short name (Windows), as a user's project can.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-watch-'));
  lines = [];
  factory = new DesktopFileWatcherFactory(noFolders, (line) => lines.push(line));
  H.hiddenOnce.clear();
  H.unlistable.clear();
  H.openWatches.clear();
});

afterEach(async () => {
  await factory.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// A recursive subscription starts asynchronously; a probe file matching the glob shows it is live.
async function untilLive(watcher: FileWatcher, probeDir: string, probeName: string): Promise<void> {
  const seen = vi.fn();
  const subscription = watcher.onDidCreate(seen);
  fs.mkdirSync(probeDir, { recursive: true });
  let attempt = 0;
  await vi.waitFor(() => {
    const each = path.join(probeDir, String(attempt++));
    fs.mkdirSync(each);
    fs.writeFileSync(path.join(each, probeName), 'probe');
    expect(seen).toHaveBeenCalled();
  }, WAIT);
  subscription.dispose();
}


describe('watchRoot', () => {
  it('subscribes at the static prefix, recursively only when the rest of the glob needs it', () => {
    expect(watchRoot(dir, 'auth.json')).toEqual({ root: dir, recursive: false });
    expect(watchRoot(dir, '*.jsonl')).toEqual({ root: dir, recursive: false });
    expect(watchRoot(dir, '{AGENTS.md,CLAUDE.md}')).toEqual({ root: dir, recursive: false });
    expect(watchRoot(dir, '.pi/skills/**')).toEqual({ root: path.join(dir, '.pi', 'skills'), recursive: true });
    expect(watchRoot(dir, '.damocles/settings*.json')).toEqual({ root: path.join(dir, '.damocles'), recursive: false });
    expect(watchRoot(dir, '**/*.md')).toEqual({ root: dir, recursive: true });
    expect(isShallowGlob('a/*.md')).toBe(false);
  });
});

// Real native watches: a recursive subscription and a replay can each take a moment to start on a loaded machine.
describe('DesktopFileWatcherFactory', { timeout: 20_000 }, () => {
  it('watches a file under an absolute base that does not exist yet, including an atomic replace', async () => {
    const agentDir = path.join(dir, 'pi', 'agent');
    const watcher = factory.watch(agentDir, 'auth.json');
    const created = vi.fn();
    const changed = vi.fn();
    const deleted = vi.fn();
    watcher.onDidCreate(created);
    watcher.onDidChange(changed);
    watcher.onDidDelete(deleted);

    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(path.join(agentDir, 'auth.json')), WAIT);

    fs.writeFileSync(path.join(agentDir, 'auth.json.tmp'), '{"a":1}');
    fs.renameSync(path.join(agentDir, 'auth.json.tmp'), path.join(agentDir, 'auth.json'));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(path.join(agentDir, 'auth.json')), WAIT);

    fs.rmSync(path.join(agentDir, 'auth.json'));
    await vi.waitFor(() => expect(deleted).toHaveBeenCalledWith(path.join(agentDir, 'auth.json')), WAIT);
    watcher.dispose();
  });

  it('filters a recursive root by the glob', async () => {
    const watcher = factory.watch(dir, 'skills/**/SKILL.md');
    await untilLive(watcher, path.join(dir, 'skills', 'probe'), 'SKILL.md');
    const created = vi.fn();
    const changed = vi.fn();
    watcher.onDidCreate(created);
    watcher.onDidChange(changed);

    fs.mkdirSync(path.join(dir, 'skills', 'a'));
    fs.writeFileSync(path.join(dir, 'skills', 'a', 'notes.md'), 'x');
    fs.writeFileSync(path.join(dir, 'skills', 'a', 'SKILL.md'), 'x');
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(path.join(dir, 'skills', 'a', 'SKILL.md')), WAIT);
    fs.writeFileSync(path.join(dir, 'skills', 'a', 'notes.md'), 'y');
    fs.writeFileSync(path.join(dir, 'skills', 'a', 'SKILL.md'), 'y');
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(path.join(dir, 'skills', 'a', 'SKILL.md')), WAIT);

    const reported = [...created.mock.calls, ...changed.mock.calls].map(([p]) => p);
    expect(reported).not.toContain(path.join(dir, 'skills', 'a', 'notes.md'));
    watcher.dispose();
  });

  // parcel-bundler/watcher#97: a directory moved in used to arrive as one create, and on Linux nothing under it was watched afterwards.
  it('reports what a directory moved into a recursive root holds, once each, and later changes deep inside it', async () => {
    const watcher = factory.watch(dir, '**/*.md');
    await untilLive(watcher, path.join(dir, 'probe'), 'a.md');
    const created = vi.fn();
    const changed = vi.fn();
    watcher.onDidCreate(created);
    watcher.onDidChange(changed);
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-stage-'));
    try {
      fs.mkdirSync(path.join(staging, 'pack', 'b', 'c'), { recursive: true });
      fs.writeFileSync(path.join(staging, 'pack', 'SKILL.md'), 'x');
      fs.writeFileSync(path.join(staging, 'pack', 'b', 'c', 'deep.md'), 'x');
      fs.renameSync(path.join(staging, 'pack'), path.join(dir, 'moved'));
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    const skill = path.join(dir, 'moved', 'SKILL.md');
    const deep = path.join(dir, 'moved', 'b', 'c', 'deep.md');
    await vi.waitFor(() => expect(created.mock.calls.map(([p]) => p)).toEqual(expect.arrayContaining([skill, deep])), WAIT);

    const later = path.join(dir, 'moved', 'b', 'c', 'later.md');
    fs.writeFileSync(later, 'y');
    fs.writeFileSync(`${deep}.tmp`, 'replaced');
    fs.renameSync(`${deep}.tmp`, deep);
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(later), WAIT);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(deep), WAIT);
    await new Promise((resolve) => setTimeout(resolve, SHALLOW_COALESCE_MS * 4));
    const creates = created.mock.calls.map(([p]) => p);
    expect(creates.filter((p) => p === skill)).toHaveLength(1);
    expect(creates.filter((p) => p === deep)).toHaveLength(1);
    watcher.dispose();
  });

  it('reports files under directories made in one mkdir -p, and in them afterwards', async () => {
    const watcher = factory.watch(dir, '**/*.md');
    await untilLive(watcher, path.join(dir, 'probe'), 'a.md');
    const created = vi.fn();
    watcher.onDidCreate(created);

    const leaf = path.join(dir, 'x', 'y', 'z');
    fs.mkdirSync(leaf, { recursive: true });
    fs.writeFileSync(path.join(leaf, 'first.md'), 'x');
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(path.join(leaf, 'first.md')), WAIT);
    fs.writeFileSync(path.join(leaf, 'second.md'), 'x');
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(path.join(leaf, 'second.md')), WAIT);
    watcher.dispose();
  });

  it('reports each file of a removed subtree as deleted', async () => {
    const watcher = factory.watch(dir, '**/*.md');
    await untilLive(watcher, path.join(dir, 'probe'), 'a.md');
    const created = vi.fn();
    const deleted = vi.fn();
    watcher.onDidCreate(created);
    watcher.onDidDelete(deleted);
    const files = [path.join(dir, 'tree', 'a.md'), path.join(dir, 'tree', 'sub', 'b.md')];
    fs.mkdirSync(path.join(dir, 'tree', 'sub'), { recursive: true });
    for (const file of files) fs.writeFileSync(file, 'x');
    await vi.waitFor(() => expect(created.mock.calls.map(([p]) => p)).toEqual(expect.arrayContaining(files)), WAIT);

    fs.rmSync(path.join(dir, 'tree'), { recursive: true });
    await vi.waitFor(() => expect(deleted.mock.calls.map(([p]) => p)).toEqual(expect.arrayContaining(files)), WAIT);
    watcher.dispose();
  });

  it('reports nothing under node_modules in a recursive root', async () => {
    const watcher = factory.watch(dir, '**/*.md');
    await untilLive(watcher, path.join(dir, 'probe'), 'a.md');
    const created = vi.fn();
    watcher.onDidCreate(created);

    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-stage-'));
    try {
      fs.mkdirSync(path.join(staging, 'pkg'));
      fs.writeFileSync(path.join(staging, 'pkg', 'README.md'), 'x');
      fs.mkdirSync(path.join(dir, 'node_modules'));
      fs.renameSync(path.join(staging, 'pkg'), path.join(dir, 'node_modules', 'pkg'));
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(dir, 'node_modules', 'top.md'), 'x');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.md'), 'x');
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(path.join(dir, 'src', 'a.md')), WAIT);
    await new Promise((resolve) => setTimeout(resolve, SHALLOW_COALESCE_MS * 4));
    expect(created.mock.calls.map(([p]) => p).filter((p: string) => p.includes('node_modules'))).toEqual([]);
    watcher.dispose();
  });

  it('reports a root reached through a symlink or junction under the path it was given', async () => {
    const real = path.join(dir, 'real');
    const link = path.join(dir, 'link');
    fs.mkdirSync(real);
    fs.symlinkSync(real, link, 'junction');
    const watcher = factory.watch(link, '**/*.md');
    await untilLive(watcher, path.join(real, 'probe'), 'a.md');
    const created = vi.fn();
    watcher.onDidCreate(created);

    fs.writeFileSync(path.join(real, 'notes.md'), 'x');
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(path.join(link, 'notes.md')), WAIT);
    watcher.dispose();
  });

  it('never throws from watch(): a root it cannot list is logged and fires nothing', () => {
    const file = path.join(dir, 'plain');
    fs.writeFileSync(file, 'not a directory');
    let watcher: FileWatcher | undefined;
    expect(() => {
      watcher = factory.watch(file, 'a.json');
    }).not.toThrow();
    expect(watcher).toBeDefined();
    expect(lines.some((line) => line.startsWith(`[watcher] could not watch ${file}`))).toBe(true);
    watcher!.dispose();
  });

  it('delivers to the other listeners when one throws, and logs it', async () => {
    const watcher = factory.watch(dir, 'a.json');
    const second = vi.fn();
    watcher.onDidCreate(() => {
      throw new Error('listener bug');
    });
    watcher.onDidCreate(second);

    fs.writeFileSync(path.join(dir, 'a.json'), '{}');
    await vi.waitFor(() => expect(second).toHaveBeenCalledWith(path.join(dir, 'a.json')), WAIT);
    expect(lines.some((line) => line.includes('a listener threw') && line.includes('listener bug'))).toBe(true);
    watcher.dispose();
  });

  it.each([
    ['a shallow', 'a.json'],
    ['a recursive', '**/*.json'],
  ])('waits again for %s root that is deleted, and resumes when it is recreated', async (_kind, glob) => {
    const root = path.join(dir, 'project', '.damocles');
    fs.mkdirSync(root, { recursive: true });
    const watcher = factory.watch(root, glob);
    if (glob.includes('**')) await untilLive(watcher, path.join(root, 'probe'), 'a.json');
    const created = vi.fn();
    const deleted = vi.fn();
    watcher.onDidCreate(created);
    watcher.onDidDelete(deleted);
    const file = path.join(root, 'a.json');

    fs.writeFileSync(file, '{}');
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(file), WAIT);
    fs.rmSync(root, { recursive: true, force: true });
    await vi.waitFor(() => expect(deleted).toHaveBeenCalledWith(file), WAIT);
    await vi.waitFor(() => expect(lines).toContain(`[watcher] ${root} is gone; watching for it to come back`), WAIT);

    created.mockClear();
    fs.mkdirSync(root);
    fs.writeFileSync(file, '{"again":true}');
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(file), WAIT);
    watcher.dispose();
  });

  it('logs a replay it cannot list and keeps watching', async () => {
    const late = path.join(dir, 'late');
    const watcher = factory.watch(late, 'a.json');
    const created = vi.fn();
    watcher.onDidCreate(created);
    H.unlistable.add(late);

    fs.mkdirSync(late);
    await vi.waitFor(() => expect(lines.some((line) => line.startsWith(`[watcher] could not list ${late}`))).toBe(true), WAIT);
    fs.writeFileSync(path.join(late, 'a.json'), '{}');
    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(path.join(late, 'a.json')), WAIT);
    watcher.dispose();
  });

  it('replays to listeners added right after watch() a directory that appeared while the watch started', async () => {
    fs.writeFileSync(path.join(dir, 'a.json'), '{}');
    H.hiddenOnce.add(dir);
    const watcher = factory.watch(dir, 'a.json');
    const created = vi.fn();
    watcher.onDidCreate(created);

    await vi.waitFor(() => expect(created).toHaveBeenCalledWith(path.join(dir, 'a.json')), WAIT);
    watcher.dispose();
  });

  it('reports a burst of writes to one file once, not once per raw event', async () => {
    const file = path.join(dir, 'a.json');
    fs.writeFileSync(file, '0');
    const watcher = factory.watch(dir, 'a.json');
    const changed = vi.fn();
    watcher.onDidChange(changed);

    for (let i = 1; i <= 20; i++) fs.writeFileSync(file, String(i));
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), WAIT);
    await new Promise((resolve) => setTimeout(resolve, SHALLOW_COALESCE_MS * 4));
    expect(changed.mock.calls.length).toBeLessThanOrEqual(2);
    watcher.dispose();
  });

  it('shares one native watch per root and closes it with the last watcher', () => {
    const first = factory.watch(dir, 'a.json');
    const second = factory.watch(dir, 'b.json');
    expect(H.openWatches.size).toBe(1);

    first.dispose();
    expect(H.openWatches.size).toBe(1);
    second.dispose();
    expect(H.openWatches.size).toBe(0);
  });

  it('watchWorkspace matches relative to each open project and follows the project list', async () => {
    let open: OpenFolder[] = [];
    const listeners = new Set<() => void>();
    const folders: WorkspaceFolders = {
      folders: () => open,
      onDidChange: (cb) => {
        listeners.add(cb);
        return { dispose: () => { listeners.delete(cb); } };
      },
    };
    const setOpen = (next: OpenFolder[]): void => {
      open = next;
      for (const cb of [...listeners]) cb();
    };
    const alpha = path.join(dir, 'alpha');
    const beta = path.join(dir, 'beta');
    for (const project of [alpha, beta]) fs.mkdirSync(path.join(project, '.damocles'), { recursive: true });
    const workspaceFactory = new DesktopFileWatcherFactory(folders, (line) => lines.push(line));
    const watcher = workspaceFactory.watchWorkspace('.damocles/settings.json');
    const events: string[] = [];
    watcher.onDidCreate((p) => events.push(`create ${p}`));
    watcher.onDidChange((p) => events.push(`change ${p}`));
    const alphaFile = path.join(alpha, '.damocles', 'settings.json');
    const betaFile = path.join(beta, '.damocles', 'settings.json');

    setOpen([{ fsPath: alpha, name: 'alpha' }]);
    fs.writeFileSync(path.join(alpha, '.damocles', 'settings.local.json'), '{}');
    fs.writeFileSync(betaFile, '{}');
    fs.writeFileSync(alphaFile, '{}');
    await vi.waitFor(() => expect(events).toContain(`create ${alphaFile}`), WAIT);

    setOpen([{ fsPath: beta, name: 'beta' }]);
    fs.writeFileSync(alphaFile, '{"a":1}');
    fs.writeFileSync(betaFile, '{"b":1}');
    await vi.waitFor(() => expect(events).toContain(`change ${betaFile}`), WAIT);
    await new Promise((resolve) => setTimeout(resolve, SHALLOW_COALESCE_MS * 4));
    expect(events).toEqual([`create ${alphaFile}`, `change ${betaFile}`]);

    watcher.dispose();
    expect(listeners.size).toBe(0);
    await workspaceFactory.close();
  });
});
