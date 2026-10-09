import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { expect, vi } from 'vitest';

/**
 * Holds the first rename onto a file named like `file` (its write is then in flight), calls `flush`, queues `second`
 * while that flush waits, and releases the rename. Fails when the flush settles while the rename is still held; returns
 * what `onDisk` reads the moment the flush settles, before anything else is awaited.
 */
export async function flushAcrossHeldRename<T>(file: string, steps: {
  readonly first: () => unknown;
  readonly flush: () => Promise<void>;
  readonly second: () => unknown;
  readonly onDisk: () => T;
}): Promise<T> {
  const rename = fsp.rename.bind(fsp);
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let reach: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    // Basenames: the writer renames onto the realpath, which differs from `file` under an 8.3 or linked temp folder.
    if (path.basename(String(to)) === path.basename(file)) {
      reach();
      await released;
    }
    return rename(from, to);
  });
  try {
    const first = Promise.resolve(steps.first());
    await reached;
    let flushed = false;
    const flushing = steps.flush().then(() => { flushed = true; });
    const second = Promise.resolve(steps.second());
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(flushed).toBe(false);
    release();
    const onDisk = await flushing.then(steps.onDisk);
    await Promise.allSettled([first, second]);
    return onDisk;
  } finally {
    release();
    spy.mockRestore();
  }
}
