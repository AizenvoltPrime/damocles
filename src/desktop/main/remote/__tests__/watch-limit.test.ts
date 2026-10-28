import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { Emitter } from '../../../local-services/emitter';
import { startInotifyTree } from '../../../local-services/file-watcher-factory';
import { testRemote } from '../../__tests__/test-workspaces';
import { createWatchLimits, SUGGESTED_WATCHES, WATCH_LIMIT_FEATURE, type WatchLimitDeps } from '../watch-limit';

const KEY = 'ssh+h1';
const APP = { name: 'app', fsPath: '/srv/app', os: 'linux' as const };

// The daemon watcher's reports, raised by the test as the factory raises them on ENOSPC.
function fakeWatcher(limit: number | null = 8192) {
  const reached = new Emitter<[string]>('watcher', () => undefined);
  const roots: string[] = [];
  return {
    watchLimits: { roots: () => [...roots], onReached: (listener: (root: string) => void) => reached.add(listener), limit: async () => limit },
    raise: (root: string) => {
      roots.push(root);
      reached.fire(root);
    },
  };
}

function limits(overrides: Partial<WatchLimitDeps> = {}) {
  const notified: Array<[string, string]> = [];
  const changed: string[] = [];
  const watchLimits = createWatchLimits({
    projects: () => [APP],
    notify: (authorityKey, project) => notified.push([authorityKey, project]),
    changed: (authorityKey) => changed.push(authorityKey),
    log: () => undefined,
    ...overrides,
  });
  return { watchLimits, notified, changed };
}

// a daemon's events cross the in-memory channel on later tasks
const delivered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('the target watcher running out of inotify watches', () => {
  it('reaches main over the workspace channel as one notification naming the project, and the card\'s notice for that connection', async () => {
    const watcher = fakeWatcher();
    const remote = testRemote({ watchers: createFakePlatform().fileWatchers, watchLimits: watcher.watchLimits });
    const { watchLimits, notified, changed } = limits();
    const connection = { features: [WATCH_LIMIT_FEATURE], workspace: remote.endpoint };
    watchLimits.watch(KEY, connection);
    await delivered();
    expect(watchLimits.notice(KEY, connection)).toBeUndefined();
    watcher.raise('/srv/app/src');
    await delivered();
    expect(notified).toEqual([[KEY, 'app']]);
    expect(changed).toEqual([KEY]);
    expect(watchLimits.notice(KEY, connection)).toEqual({ code: 'watchLimit', params: { project: 'app', suggested: SUGGESTED_WATCHES, limit: 8192 } });
    // a second folder on the same connection: no second notification
    watcher.raise('/srv/app/docs');
    await delivered();
    expect(notified).toHaveLength(1);
    // another connection's card shows nothing of it
    expect(watchLimits.notice(KEY, {})).toBeUndefined();
    remote.disconnect('done');
  });

  it('notifies again on a new connection, from the folders the daemon already reports when it attaches', async () => {
    const watcher = fakeWatcher(null);
    const { watchLimits, notified } = limits();
    const first = testRemote({ watchers: createFakePlatform().fileWatchers, watchLimits: watcher.watchLimits });
    const heard = watchLimits.watch(KEY, { features: [WATCH_LIMIT_FEATURE], workspace: first.endpoint });
    watcher.raise('/srv/app');
    await delivered();
    heard.dispose();
    first.disconnect('network');
    const second = testRemote({ watchers: createFakePlatform().fileWatchers, watchLimits: watcher.watchLimits });
    const connection = { features: [WATCH_LIMIT_FEATURE], workspace: second.endpoint };
    watchLimits.watch(KEY, connection);
    await delivered();
    expect(notified).toEqual([[KEY, 'app'], [KEY, 'app']]);
    // an unreadable limit is left out, never guessed
    expect(watchLimits.notice(KEY, connection)).toEqual({ code: 'watchLimit', params: { project: 'app', suggested: SUGGESTED_WATCHES } });
    second.disconnect('done');
  });

  it('tells nothing about a folder outside this computer\'s projects, nor hears a daemon without the feature', async () => {
    const watcher = fakeWatcher();
    const remote = testRemote({ watchers: createFakePlatform().fileWatchers, watchLimits: watcher.watchLimits });
    const { watchLimits, notified } = limits({ projects: () => [APP, { name: 'apps', fsPath: '/srv/apps', os: 'linux' }] });
    watchLimits.watch(KEY, { features: [WATCH_LIMIT_FEATURE], workspace: remote.endpoint });
    watcher.raise('/srv/application');
    watcher.raise('/home/other/repo');
    await delivered();
    expect(notified).toEqual([]);
    const old = vi.fn();
    watchLimits.watch('ssh+h2', { features: [], workspace: { request: old, onEvent: old } });
    expect(old).not.toHaveBeenCalled();
    remote.disconnect('done');
  });
});

describe('the inotify tree watch', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports the limit when a folder gets no watch for ENOSPC, and keeps watching the others', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-inotify-'));
    fs.mkdirSync(path.join(root, 'a'));
    fs.mkdirSync(path.join(root, 'b'));
    const watched: string[] = [];
    const watch = ((dir: string) => {
      if (dir === path.join(root!, 'b')) throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
      watched.push(dir);
      return { on: () => undefined, close: () => undefined };
    }) as unknown as typeof fs.watch;
    const limit = vi.fn();
    const logs: string[] = [];
    const tree = startInotifyTree(root, () => undefined, () => undefined, (line) => logs.push(line), limit, watch);
    await vi.waitFor(() => expect(watched).toEqual([root, path.join(root!, 'a')]));
    expect(limit).toHaveBeenCalledTimes(1);
    expect(logs.some((line) => line.includes('fs.inotify.max_user_watches'))).toBe(true);
    tree.dispose();
  });

  it('reports the limit when the root itself gets no watch', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-inotify-'));
    const watch = (() => {
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    }) as unknown as typeof fs.watch;
    const limit = vi.fn();
    expect(() => startInotifyTree(root!, () => undefined, () => undefined, () => undefined, limit, watch)).toThrow('ENOSPC');
    expect(limit).toHaveBeenCalledTimes(1);
  });
});
