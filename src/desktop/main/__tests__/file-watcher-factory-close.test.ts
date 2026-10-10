import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

// Linux and Windows watch with fs.watch, so the factory is loaded as on macOS to take the @parcel/watcher path on every host.
const H = vi.hoisted(() => {
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const deferred = <T>(): Deferred<T> => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
  };
  return {
    platform,
    deferred,
    subscribes: [] as { dir: string; call: Deferred<{ unsubscribe(): Promise<void> }> }[],
    unsubscribes: [] as Deferred<void>[],
  };
});

// Each native call stays in flight until the test settles it.
vi.mock('@parcel/watcher', () => ({
  subscribe: (dir: string) => {
    const call = H.deferred<{ unsubscribe(): Promise<void> }>();
    H.subscribes.push({ dir, call });
    return call.promise;
  },
}));

import { createInProcessTreeHost } from '../../watch-worker/fs-watch-tree';
import { DesktopFileWatcherFactory } from '../platform/file-watcher-factory';

let dir: string;
let factory: DesktopFileWatcherFactory;
const noFolders = { folders: () => [], onDidChange: () => ({ dispose: () => undefined }) };

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function landSubscribe(index: number): void {
  H.subscribes[index]!.call.resolve({
    unsubscribe: () => {
      const call = H.deferred<void>();
      H.unsubscribes.push(call);
      return call.promise;
    },
  });
}

function closing(): { readonly settled: () => boolean; readonly done: Promise<void> } {
  let settled = false;
  const done = factory.close().then(() => {
    settled = true;
  });
  return { settled: () => settled, done };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-watch-close-'));
  factory = new DesktopFileWatcherFactory(noFolders, () => undefined, createInProcessTreeHost(() => undefined));
  H.subscribes.length = 0;
  H.unsubscribes.length = 0;
});

afterEach(async () => {
  for (const each of H.subscribes) each.call.resolve({ unsubscribe: async () => undefined });
  for (const each of H.unsubscribes) each.resolve();
  await factory.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: H.platform, configurable: true });
});

describe('DesktopFileWatcherFactory.close', () => {
  it('waits for a subscribe still running, then for the unsubscribe it makes once the subscribe lands', async () => {
    factory.watch(dir, '**/*.txt');
    await vi.waitFor(() => expect(H.subscribes).toHaveLength(1));

    const close = closing();
    await settle();
    expect(close.settled()).toBe(false);
    expect(H.unsubscribes).toHaveLength(0);

    landSubscribe(0);
    await vi.waitFor(() => expect(H.unsubscribes).toHaveLength(1));
    await settle();
    expect(close.settled()).toBe(false);

    H.unsubscribes[0]!.resolve();
    await close.done;
  });

  it('waits for the unsubscribe of a watch disposed before it began', async () => {
    const watcher = factory.watch(dir, '**/*.txt');
    await vi.waitFor(() => expect(H.subscribes).toHaveLength(1));
    landSubscribe(0);
    await settle();
    watcher.dispose();
    await vi.waitFor(() => expect(H.unsubscribes).toHaveLength(1));

    const close = closing();
    await settle();
    expect(close.settled()).toBe(false);

    H.unsubscribes[0]!.resolve();
    await close.done;
  });

  it('starts no native work once it began, for a watch still loading the module or a watch made afterwards', async () => {
    factory.watch(dir, '**/*.txt');
    const close = closing();
    factory.watch(path.join(dir, 'later'), '**');
    fs.mkdirSync(path.join(dir, 'later'));

    await close.done;
    await settle();
    expect(H.subscribes).toHaveLength(0);
  });
});
