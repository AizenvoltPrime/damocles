import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileBytes, readOpenedFile } from '../file-bytes';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-file-bytes-'));
  dirs.push(dir);
  return dir;
}

/** stat answers for `file` as for a FIFO, as when a FIFO stands at the path. */
function statAsFifo(file: string): void {
  const stat = fs.promises.stat.bind(fs.promises);
  vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, options?: fs.StatOptions) => {
    const stats = await stat(target, options);
    return String(target) === file ? Object.assign(stats, { isFile: () => false, isFIFO: () => true, isDirectory: () => false }) : stats;
  }) as typeof fs.promises.stat);
}

describe('readFileBytes', () => {
  it('reads a regular file within the limit through a handle opened without blocking', async () => {
    const file = path.join(tempDir(), 'a.txt');
    fs.writeFileSync(file, 'alpha\n');
    const open = vi.spyOn(fs.promises, 'open');

    const read = await readFileBytes(file);

    expect(read.kind === 'bytes' && read.bytes.toString('utf8')).toBe('alpha\n');
    expect(open).toHaveBeenCalledWith(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  });

  it('refuses a file over the limit from its size, opening nothing', async () => {
    const file = path.join(tempDir(), 'big.txt');
    fs.writeFileSync(file, 'x'.repeat(11));
    const open = vi.spyOn(fs.promises, 'open');

    expect(await readFileBytes(file, 10)).toEqual({ kind: 'tooLarge', bytes: 11 });
    expect(open).not.toHaveBeenCalled();
  });

  it('answers a folder and a missing path, opening nothing', async () => {
    const dir = tempDir();
    const open = vi.spyOn(fs.promises, 'open');

    expect(await readFileBytes(dir)).toEqual({ kind: 'notAFile', folder: true });
    expect(await readFileBytes(path.join(dir, 'gone.txt'))).toEqual({ kind: 'missing' });
    expect(open).not.toHaveBeenCalled();
  });

  it('never opens a path whose stat is not a regular file', async () => {
    const file = path.join(tempDir(), 'pipe');
    fs.writeFileSync(file, 'never read');
    statAsFifo(file);
    const open = vi.spyOn(fs.promises, 'open');

    expect(await readFileBytes(file)).toEqual({ kind: 'notAFile', folder: false });
    expect(open).not.toHaveBeenCalled();
  });

  it('answers an open the system refuses as unreadable, with its code', async () => {
    const file = path.join(tempDir(), 'locked.txt');
    fs.writeFileSync(file, 'x');
    vi.spyOn(fs.promises, 'open').mockRejectedValue(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));

    expect(await readFileBytes(file)).toEqual({ kind: 'unreadable', error: 'EBUSY: resource busy or locked', code: 'EBUSY' });
  });
});

describe('readOpenedFile', () => {
  it('stops one byte past the limit when the file grew after its stat', async () => {
    const file = path.join(tempDir(), 'growing.txt');
    fs.writeFileSync(file, 'x'.repeat(10));
    const handle = await fs.promises.open(file, 'r');
    try {
      const statOfHandle = handle.stat.bind(handle);
      // the first stat sees the file within the limit; it holds a megabyte by the time it is read
      vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
        const stats = await statOfHandle();
        fs.writeFileSync(file, 'x'.repeat(1024 * 1024));
        return stats;
      });
      const read = vi.spyOn(handle, 'read');

      expect(await readOpenedFile(handle, 16)).toEqual({ kind: 'tooLarge', bytes: 1024 * 1024 });
      const asked = read.mock.calls.reduce((total, call) => total + ((call as unknown[])[2] as number), 0);
      expect(asked).toBeLessThanOrEqual(17);
    } finally {
      await handle.close();
    }
  });
});

describe.runIf(process.platform !== 'win32')('readFileBytes on POSIX special files', () => {
  it('never opens a FIFO, which would hold the open until a writer came', async () => {
    const fifo = path.join(tempDir(), 'pipe');
    execFileSync('mkfifo', [fifo]);
    const open = vi.spyOn(fs.promises, 'open');

    expect(await readFileBytes(fifo)).toEqual({ kind: 'notAFile', folder: false });
    expect(open).not.toHaveBeenCalled();
  });

  it('answers a FIFO swapped in after the stat from its handle, without waiting for a writer', async () => {
    const file = path.join(tempDir(), 'swapped');
    fs.writeFileSync(file, 'regular');
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementationOnce((async (target: fs.PathLike) => {
      const stats = await stat(target);
      fs.rmSync(file);
      execFileSync('mkfifo', [file]);
      return stats;
    }) as typeof fs.promises.stat);

    expect(await readFileBytes(file)).toEqual({ kind: 'notAFile', folder: false });
  });

  it('never reads a device, whose stat size is 0', async () => {
    const open = vi.spyOn(fs.promises, 'open');

    expect(await readFileBytes('/dev/zero')).toEqual({ kind: 'notAFile', folder: false });
    expect(open).not.toHaveBeenCalled();
  });
});
