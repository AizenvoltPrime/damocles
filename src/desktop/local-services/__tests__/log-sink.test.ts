import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDesktopLogSinkFactory as createFactory, writeUnstartedLogLines } from '../log-sink';

const opened: Array<{ path: string; text: string; preserveFocus: boolean }> = [];
// What the file holds at the moment it is opened.
const createDesktopLogSinkFactory = (logsDir: string, echo: boolean) =>
  createFactory(logsDir, echo, (p, preserveFocus) => opened.push({ path: p, text: fs.readFileSync(p, 'utf8'), preserveFocus }));

const MAX_FILE_BYTES = 5 * 1024 * 1024;

let dir: string;
let stderr: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-log-'));
  opened.length = 0;
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
    const factory = createDesktopLogSinkFactory(dir, false);
    const sink = factory.create('Damocles');

    sink.appendLine('past the limit');
    await factory.flushed();

    expect(fs.readFileSync(path.join(dir, 'Damocles.1.log'), 'utf8')).toHaveLength(MAX_FILE_BYTES - 4);
    expect(fs.readFileSync(file, 'utf8')).toBe('past the limit\n');
    sink.dispose();
    await factory.flushed();
  });

  it('keeps lines in order across a rotation, each turn\'s batch whole in one file', async () => {
    const file = path.join(dir, 'Damocles.log');
    const line = 'y'.repeat(1023);
    const factory = createDesktopLogSinkFactory(dir, false);
    const sink = factory.create('Damocles');
    // 1 KiB lines in batches of 1024 fill one file in 5 turns; the sixth turn's batch rotates it. Each turn's write lands
    // before the next turn logs, or the next turns' lines would join one write.
    for (let turn = 0; turn < 7; turn++) {
      for (let i = 0; i < 1024; i++) sink.appendLine(`${turn}:${String(i).padStart(4, '0')}:${line.slice(7)}`);
      await factory.flushed();
    }
    await factory.flushed();

    const rotated = fs.readFileSync(path.join(dir, 'Damocles.1.log'), 'utf8').trimEnd().split('\n');
    const current = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    const keys = [...rotated, ...current].map((entry) => entry.slice(0, 6));
    expect(keys).toEqual(Array.from({ length: 7 * 1024 }, (_, n) => `${Math.floor(n / 1024)}:${String(n % 1024).padStart(4, '0')}`));
    expect(current[0]!.startsWith('5:0000')).toBe(true);
    sink.dispose();
    await factory.flushed();
  });

  it('keeps appending when rotation fails, and says so once on stderr', async () => {
    const file = path.join(dir, 'Damocles.log');
    fs.writeFileSync(file, 'x'.repeat(MAX_FILE_BYTES));
    fs.writeFileSync(path.join(dir, 'Damocles.2.log'), 'older');
    // A non-empty directory where the oldest rotation lands makes the rename fail.
    fs.mkdirSync(path.join(dir, 'Damocles.3.log', 'occupied'), { recursive: true });
    const factory = createDesktopLogSinkFactory(dir, false);
    const sink = factory.create('Damocles');

    sink.appendLine('first');
    await factory.flushed();
    sink.appendLine('second');
    await factory.flushed();

    expect(fs.readFileSync(file, 'utf8').endsWith('first\nsecond\n')).toBe(true);
    expect(stderr.filter((entry) => entry.includes('could not rotate'))).toHaveLength(1);
    sink.dispose();
    await factory.flushed();
  });

  it('drops a batch it cannot write instead of throwing, and says so once on stderr', async () => {
    // A directory where the log file belongs makes every write fail.
    fs.mkdirSync(path.join(dir, 'Damocles.log'));
    const factory = createDesktopLogSinkFactory(dir, false);
    const sink = factory.create('Damocles');

    sink.appendLine('lost');
    await factory.flushed();
    sink.appendLine('lost too');
    await factory.flushed();

    expect(stderr.filter((entry) => entry.includes('dropped 1 log line(s)'))).toHaveLength(1);
    expect(() => sink.dispose()).not.toThrow();
    await factory.flushed();
  });

  it('writes pending lines before the file is shown', async () => {
    const file = path.join(dir, 'Damocles.log');
    const factory = createDesktopLogSinkFactory(dir, false);
    const sink = factory.create('Damocles');

    sink.appendLine('before show');
    sink.show();
    await expect.poll(() => opened).toEqual([{ path: file, text: 'before show\n', preserveFocus: false }]);
    sink.dispose();
    await factory.flushed();
  });

  it('settles flushed() only once every line logged before it is on disk, in every sink', async () => {
    const factory = createDesktopLogSinkFactory(dir, false);
    const main = factory.create('Damocles');
    const git = factory.create('Git');

    main.appendLine('one');
    git.appendLine('two');
    await factory.flushed();

    expect(fs.readFileSync(path.join(dir, 'Damocles.log'), 'utf8')).toBe('one\n');
    expect(fs.readFileSync(path.join(dir, 'Git.log'), 'utf8')).toBe('two\n');
    main.dispose();
    git.dispose();
    await factory.flushed();
  });

  it('writes the lines at once when disposed with no write in flight, and drops lines logged after', async () => {
    const file = path.join(dir, 'Damocles.log');
    const factory = createDesktopLogSinkFactory(dir, false);
    const sink = factory.create('Damocles');
    sink.appendLine('written');
    await factory.flushed();

    sink.appendLine('before dispose');
    sink.dispose();
    expect(fs.readFileSync(file, 'utf8')).toBe('written\nbefore dispose\n');
    sink.appendLine('after dispose');
    await factory.flushed();
    expect(fs.readFileSync(file, 'utf8')).toBe('written\nbefore dispose\n');
  });

  it('leaves the lines a dispose finds behind a write in flight to the exit hook, which a quit reaches before the chain', async () => {
    const file = path.join(dir, 'Damocles.log');
    const factory = createDesktopLogSinkFactory(dir, false);
    const sink = factory.create('Damocles');
    sink.appendLine('in flight');
    await nextTurn();
    sink.appendLine('at quit');
    sink.dispose();

    writeUnstartedLogLines();
    expect(fs.readFileSync(file, 'utf8')).toContain('at quit\n');
    await factory.flushed();
    expect(fs.readFileSync(file, 'utf8').split('\n').filter((entry) => entry === 'at quit')).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf8')).toContain('in flight\n');
  });

  it('writes the lines a dispose finds behind a write in flight once that write lands, when no exit comes', async () => {
    const file = path.join(dir, 'Damocles.log');
    const factory = createDesktopLogSinkFactory(dir, false);
    const sink = factory.create('Damocles');
    sink.appendLine('in flight');
    await nextTurn();
    sink.appendLine('behind it');
    sink.dispose();
    await factory.flushed();
    expect(fs.readFileSync(file, 'utf8')).toBe('in flight\nbehind it\n');
  });

  it('creates the logs folder for the lines it writes at exit when no write ran before', async () => {
    const logsDir = path.join(dir, 'first-launch', 'logs');
    const factory = createDesktopLogSinkFactory(logsDir, false);
    const sink = factory.create('Damocles');
    sink.appendLine('bad init');
    writeUnstartedLogLines();
    expect(fs.readFileSync(path.join(logsDir, 'Damocles.log'), 'utf8')).toBe('bad init\n');
    expect(stderr).toEqual([]);
    sink.dispose();
    await factory.flushed();
  });

  describe('behind a write in flight', () => {
    let writes: string[];
    let release: () => void;

    beforeEach(() => {
      writes = [];
      const gate = new Promise<void>((resolve) => (release = resolve));
      const open = fs.promises.open.bind(fs.promises);
      vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        const write = handle.write.bind(handle) as (text: string) => Promise<unknown>;
        Object.assign(handle, {
          write: async (text: string) => {
            writes.push(text);
            if (writes.length === 1) await gate;
            return write(text);
          },
        });
        return handle;
      });
    });

    it('writes the lines logged meanwhile together once it lands', async () => {
      const factory = createDesktopLogSinkFactory(dir, false);
      const sink = factory.create('Damocles');
      sink.appendLine('first');
      await nextTurn();
      await expect.poll(() => writes).toEqual(['first\n']);
      for (let turn = 0; turn < 5; turn++) {
        sink.appendLine(`turn ${turn}`);
        await nextTurn();
      }
      release();
      await factory.flushed();
      expect(writes).toEqual(['first\n', 'turn 0\nturn 1\nturn 2\nturn 3\nturn 4\n']);
      expect(fs.readFileSync(path.join(dir, 'Damocles.log'), 'utf8')).toBe('first\nturn 0\nturn 1\nturn 2\nturn 3\nturn 4\n');
      sink.dispose();
      await factory.flushed();
    });

    it('keeps at most the file size waiting, and counts the lines it dropped past it in the log', async () => {
      const factory = createDesktopLogSinkFactory(dir, false);
      const sink = factory.create('Damocles');
      sink.appendLine('first');
      await nextTurn();
      await expect.poll(() => writes).toEqual(['first\n']);
      const mib = 'z'.repeat(1024 * 1024);
      for (let line = 0; line < 6; line++) sink.appendLine(`${line}${mib}`);
      release();
      await factory.flushed();
      const lines = fs.readFileSync(path.join(dir, 'Damocles.log'), 'utf8').trimEnd().split('\n');
      expect(lines.map((line) => line.slice(0, 1))).toEqual(['f', '0', '1', '2', '3', '[']);
      expect(lines.at(-1)).toBe('[log] dropped 2 log line(s) while earlier lines waited to be written');
      sink.dispose();
      await factory.flushed();
    });

    it('ends async writes only once it lands, after which a quit\'s last lines are on disk in order as they are logged', async () => {
      const file = path.join(dir, 'Damocles.log');
      const factory = createDesktopLogSinkFactory(dir, false);
      const sink = factory.create('Damocles');
      sink.appendLine('teardown');
      await nextTurn();
      await expect.poll(() => writes).toEqual(['teardown\n']);
      sink.appendLine('behind it');
      let ended = false;
      const ending = factory.endAsyncWrites().then(() => (ended = true));
      await nextTurn();
      expect(ended).toBe(false);

      release();
      await ending;
      expect(fs.readFileSync(file, 'utf8')).toBe('teardown\nbehind it\n');
      // the quit's own lines, then will-quit's dispose and the exit, with no turn of the event loop between them
      sink.appendLine('disposed; quitting');
      sink.appendLine('will-quit');
      sink.dispose();
      writeUnstartedLogLines();
      expect(fs.readFileSync(file, 'utf8')).toBe('teardown\nbehind it\ndisposed; quitting\nwill-quit\n');
      await factory.flushed();
      expect(fs.readFileSync(file, 'utf8')).toBe('teardown\nbehind it\ndisposed; quitting\nwill-quit\n');
    });
  });

  it('writes each line at once in a sink created after async writes ended', async () => {
    const factory = createDesktopLogSinkFactory(dir, false);
    await factory.endAsyncWrites();
    const sink = factory.create('Format');
    sink.appendLine('late');
    expect(fs.readFileSync(path.join(dir, 'Format.log'), 'utf8')).toBe('late\n');
    sink.dispose();
    await factory.flushed();
  });

  it('writes at exit only the lines no write was started for', async () => {
    const file = path.join(dir, 'Damocles.log');
    const factory = createDesktopLogSinkFactory(dir, false);
    const sink = factory.create('Damocles');
    sink.appendLine('started');
    await nextTurn();
    sink.appendLine('never started');

    writeUnstartedLogLines();
    expect(fs.readFileSync(file, 'utf8')).toContain('never started\n');
    await factory.flushed();
    expect(fs.readFileSync(file, 'utf8').split('\n').filter((entry) => entry === 'never started')).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf8')).toContain('started\n');
    sink.dispose();
    await factory.flushed();
  });
});
