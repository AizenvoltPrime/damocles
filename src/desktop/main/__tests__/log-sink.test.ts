import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ opened: [] as Array<{ path: string; text: string }> }));

vi.mock('electron', async () => {
  const nodeFs = await import('node:fs');
  return {
    shell: {
      // What the file holds at the moment it is opened.
      openPath: async (p: string) => {
        electron.opened.push({ path: p, text: nodeFs.readFileSync(p, 'utf8') });
        return '';
      },
    },
  };
});

import { createDesktopLogSinkFactory } from '../platform/log-sink';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

let dir: string;
let stderr: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-log-'));
  electron.opened.length = 0;
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('desktop log sink', () => {
  it('rotates the file once the next batch would pass the size limit', async () => {
    const file = path.join(dir, 'Damocles.log');
    fs.writeFileSync(file, 'x'.repeat(MAX_FILE_BYTES - 4));
    const sink = createDesktopLogSinkFactory(dir, false).create('Damocles');

    sink.appendLine('past the limit');
    await nextTurn();

    expect(fs.readFileSync(path.join(dir, 'Damocles.1.log'), 'utf8')).toHaveLength(MAX_FILE_BYTES - 4);
    expect(fs.readFileSync(file, 'utf8')).toBe('past the limit\n');
    sink.dispose();
  });

  it('keeps appending when rotation fails, and says so once on stderr', async () => {
    const file = path.join(dir, 'Damocles.log');
    fs.writeFileSync(file, 'x'.repeat(MAX_FILE_BYTES));
    fs.writeFileSync(path.join(dir, 'Damocles.2.log'), 'older');
    // A non-empty directory where the oldest rotation lands makes the rename fail.
    fs.mkdirSync(path.join(dir, 'Damocles.3.log', 'occupied'), { recursive: true });
    const sink = createDesktopLogSinkFactory(dir, false).create('Damocles');

    sink.appendLine('first');
    await nextTurn();
    sink.appendLine('second');
    await nextTurn();

    expect(fs.readFileSync(file, 'utf8').endsWith('first\nsecond\n')).toBe(true);
    expect(stderr.filter((line) => line.includes('could not rotate'))).toHaveLength(1);
    sink.dispose();
  });

  it('drops a batch it cannot write instead of throwing, and says so once on stderr', async () => {
    // A directory where the log file belongs makes every append fail.
    fs.mkdirSync(path.join(dir, 'Damocles.log'));
    const sink = createDesktopLogSinkFactory(dir, false).create('Damocles');

    sink.appendLine('lost');
    await nextTurn();
    sink.appendLine('lost too');
    await nextTurn();

    expect(stderr.filter((line) => line.includes('dropped 1 log line(s)'))).toHaveLength(1);
    expect(() => sink.dispose()).not.toThrow();
  });

  it('writes pending lines before the file is shown and when disposed', async () => {
    const file = path.join(dir, 'Damocles.log');
    const sink = createDesktopLogSinkFactory(dir, false).create('Damocles');

    sink.appendLine('before show');
    sink.show();
    expect(electron.opened).toEqual([{ path: file, text: 'before show\n' }]);

    sink.appendLine('before dispose');
    sink.dispose();
    expect(fs.readFileSync(file, 'utf8')).toBe('before show\nbefore dispose\n');
    sink.appendLine('after dispose');
    await nextTurn();
    expect(fs.readFileSync(file, 'utf8')).toBe('before show\nbefore dispose\n');
  });
});
