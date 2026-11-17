import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readSessionFileEntries } from '../session-file-entries';

const made: string[] = [];

function fileWith(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-file-entries-'));
  made.push(dir);
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, text);
  return file;
}

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('readSessionFileEntries', () => {
  it('parses each line, skipping blank and malformed lines and a torn last one, and writes nothing', async () => {
    const text = '{"type":"session","id":"s"}\n\n{"type":"message","id":"m1"}\nnot json\r\n{"type":"message","id":"m2"}\r\n{"type":"mess';
    const file = fileWith(text);

    expect(await readSessionFileEntries(file)).toEqual([{ type: 'session', id: 's' }, { type: 'message', id: 'm1' }, { type: 'message', id: 'm2' }]);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('reads a line that spans several chunks, with a character split across two of them', async () => {
    // The prefix is 19 bytes, so the 1 MB chunk boundary falls inside a two-byte character.
    const long = '\u00e9'.repeat(1_500_000);
    const file = fileWith(`${JSON.stringify({ id: 'ab', text: long })}\n${JSON.stringify({ id: 'b' })}\n`);

    const entries = (await readSessionFileEntries(file)) as Array<{ id: string; text?: string }>;
    expect(entries.map((entry) => entry.id)).toEqual(['ab', 'b']);
    expect(entries[0]!.text).toBe(long);
  });

  it('lets the event loop turn while it reads a large file', async () => {
    const line = JSON.stringify({ text: 'x'.repeat(64 * 1024) });
    const file = fileWith(`${Array.from({ length: 96 }, () => line).join('\n')}\n`);
    let ticks = 0;
    let ticking = true;
    const tick = (): void => {
      ticks++;
      if (ticking) setImmediate(tick);
    };
    setImmediate(tick);
    try {
      expect(await readSessionFileEntries(file)).toHaveLength(96);
    } finally {
      ticking = false;
    }
    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  it('stops at an abort, rejecting with its reason', async () => {
    const file = fileWith('{"id":"a"}\n');
    const stop = new AbortController();
    const reason = new Error('gone');
    stop.abort(reason);

    await expect(readSessionFileEntries(file, stop.signal)).rejects.toBe(reason);
  });

  it('rejects for a missing file, as a read of it does', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-file-entries-'));
    made.push(dir);

    await expect(readSessionFileEntries(path.join(dir, 'missing.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
