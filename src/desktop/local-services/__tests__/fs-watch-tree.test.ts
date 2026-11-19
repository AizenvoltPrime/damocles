import { describe, expect, it, vi } from 'vitest';

// lstatSync fails with the code a test names for a path; any other path passes through.
const failing = vi.hoisted(() => new Map<string, string>());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: ((p: import('node:fs').PathLike, options?: unknown) => {
      const code = failing.get(String(p));
      if (code !== undefined) throw Object.assign(new Error(`${code}: lstat '${String(p)}'`), { code });
      return actual.lstatSync(p, options as never);
    }) as typeof actual.lstatSync,
  };
});

import { lstatNow } from '../../watch-worker/fs-watch-tree';

describe('lstatNow', () => {
  it('logs a failure other than an entry that is gone, and answers undefined for each', () => {
    failing.set('/w/file/child', 'ENOTDIR');
    failing.set('/w/gone', 'ENOENT');
    failing.set('/w/pending-delete', 'EPERM');
    const lines: string[] = [];
    expect(lstatNow('/w/file/child', (line) => lines.push(line))).toBeUndefined();
    expect(lstatNow('/w/gone', (line) => lines.push(line))).toBeUndefined();
    expect(lstatNow('/w/pending-delete', (line) => lines.push(line))).toBeUndefined();
    expect(lines).toEqual(["[watcher] could not stat /w/pending-delete: EPERM: lstat '/w/pending-delete'"]);
  });
});
