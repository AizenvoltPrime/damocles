import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logMock } = vi.hoisted(() => ({ logMock: vi.fn() }));
vi.mock('../logger', () => ({ log: logMock }));

import { approxStringLength, markActivationStart, markSinceActivation, perfSpan, timed } from '../perf';
import { formatPerfLine } from '../../shared/perf-line';

const LINE = /^\[perf\] (\S+) (\d+\.\d)ms((?: \S+=\S+)*)$/;

function loggedLines(): string[] {
  return logMock.mock.calls.map((call) => String(call[0]));
}

describe('perf', () => {
  beforeEach(() => {
    logMock.mockClear();
  });

  it('formats label, one-decimal ms and k=v fields, skipping undefined fields', () => {
    expect(formatPerfLine('sessions.list', 12.345, { files: 3, misses: 1, hits: 2, skipped: undefined }))
      .toBe('[perf] sessions.list 12.3ms files=3 misses=1 hits=2');
    expect(formatPerfLine('pi.import', 0)).toBe('[perf] pi.import 0.0ms');
  });

  it('perfSpan logs once on end, and a minMs span below its threshold logs nothing', () => {
    perfSpan('ready.settings').end({ path: 'fresh' });
    perfSpan('sessions.upsert', { minMs: 60_000 }).end({ source: 'watcher' });
    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(LINE);
    expect(lines[0]).toMatch(/^\[perf\] ready\.settings \d+\.\dms path=fresh$/);
  });

  it('timed returns a sync result and logs once', () => {
    const result = timed('activate.provider', () => 42, { n: 1 });
    expect(result).toBe(42);
    expect(loggedLines()).toHaveLength(1);
    expect(loggedLines()[0]).toMatch(/^\[perf\] activate\.provider \d+\.\dms n=1$/);
  });

  it('timed rethrows a sync error after logging it as failed', () => {
    expect(() => timed('boom', () => { throw new Error('sync'); })).toThrow('sync');
    expect(loggedLines()[0]).toMatch(/^\[perf\] boom \d+\.\dms failed=true$/);
  });

  it('timed logs an async resolve only when the promise settles', async () => {
    let resolve!: (v: string) => void;
    const pending = timed('ready.replay', () => new Promise<string>((r) => { resolve = r; }));
    await Promise.resolve();
    expect(logMock).not.toHaveBeenCalled();
    resolve('ok');
    await expect(pending).resolves.toBe('ok');
    expect(loggedLines()).toHaveLength(1);
    expect(loggedLines()[0]).toMatch(/^\[perf\] ready\.replay \d+\.\dms$/);
  });

  it('timed logs an async rejection as failed and does not swallow it', async () => {
    const pending = timed('start.total', () => Promise.reject(new Error('async')), { resumed: true });
    await expect(pending).rejects.toThrow('async');
    expect(loggedLines()).toHaveLength(1);
    expect(loggedLines()[0]).toMatch(/^\[perf\] start\.total \d+\.\dms resumed=true failed=true$/);
  });

  it('markSinceActivation logs nothing before markActivationStart', async () => {
    vi.resetModules();
    const fresh = await import('../perf');
    fresh.markSinceActivation('activate');
    expect(logMock).not.toHaveBeenCalled();
  });

  it('approxStringLength sums string lengths through arrays and objects, ignoring other values', () => {
    expect(approxStringLength([{ a: 'abc', b: 1, c: null }, 'de', { nested: { x: 'f' } }])).toBe(6);
  });

  it('markSinceActivation measures from markActivationStart', () => {
    markActivationStart();
    markSinceActivation('activate');
    expect(loggedLines()[0]).toMatch(/^\[perf\] activate \d+\.\dms$/);
  });
});
