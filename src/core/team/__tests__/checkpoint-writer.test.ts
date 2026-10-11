import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// The real rename, observed so a test counts the writes that landed and can fail one.
vi.mock('../../config/json-config-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/json-config-write')>();
  return { ...actual, renameWithRetry: vi.fn(actual.renameWithRetry) };
});

import { renameWithRetry } from '../../config/json-config-write';
import { CheckpointWriter } from '../checkpoint-writer';
import type { TeamCheckpoint } from '../types';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-checkpoint-writer-'));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
afterEach(() => vi.mocked(renameWithRetry).mockClear());

const KEY = 1_790_000_000_000;

function checkpoint(asOf: number, overrides: Partial<TeamCheckpoint> = {}): TeamCheckpoint {
  return {
    version: 1,
    teamId: 'team-1',
    cancelledAt: KEY,
    live: true,
    asOf,
    messagesThrough: `m-${asOf}`,
    members: [{
      agentId: 'lead-1', name: 'Lead', role: 'lead', attempt: 0, resumeCount: 0, status: 'running', undelivered: [],
      usage: { totalInputTokens: asOf, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
      toolCallCount: asOf,
    }],
    readerCursors: [],
    review: {
      specialistReviewRounds: [], reviewedSpecialists: [], confirmedComplete: [], reportedSummaries: [], pendingStandby: [],
      owedTerminalAction: [], nudgeDelivered: [], terminalNudgeDelivered: [], briefConflicts: [], conflictNudges: 0,
      leadReviewStalls: 0, lastReviewRoundNotification: null,
    },
    operatorSteers: [],
    ...overrides,
  };
}

/** A writer over a fresh checkpoints folder that does not exist yet, whose snapshot is whatever `state.current` holds. */
function writer(): { writer: CheckpointWriter; file: string; dir: string; state: { current: TeamCheckpoint }; errors: Error[] } {
  const dir = path.join(ROOT, crypto.randomUUID(), 'checkpoints');
  const file = path.join(dir, `${KEY}.json`);
  const state = { current: checkpoint(1) };
  const errors: Error[] = [];
  const w = new CheckpointWriter({ filePath: file, snapshot: () => state.current, onError: (err) => errors.push(err) });
  return { writer: w, file, dir, state, errors };
}

const onDisk = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf-8'));
const writesTo = (file: string): number => vi.mocked(renameWithRetry).mock.calls.filter(([, to]) => to === file).length;

describe('CheckpointWriter', () => {
  it('writes a burst of schedules at most twice and ends on the latest state', async () => {
    const { writer: w, file, state, errors } = writer();

    for (let i = 1; i <= 20; i++) {
      state.current = checkpoint(i);
      w.schedule();
    }

    expect(await w.flush()).toBe(true);
    expect(writesTo(file)).toBeGreaterThanOrEqual(1);
    expect(writesTo(file)).toBeLessThanOrEqual(2);
    expect(onDisk(file)).toEqual(checkpoint(20));
    expect(errors).toEqual([]);
  });

  it('takes the pending snapshot when its write starts, so changes made during a write land with it', async () => {
    const { writer: w, file, state } = writer();
    const { renameWithRetry: realRename } = await vi.importActual<typeof import('../../config/json-config-write')>('../../config/json-config-write');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let renaming!: () => void;
    const inFlight = new Promise<void>((resolve) => { renaming = resolve; });
    vi.mocked(renameWithRetry).mockImplementationOnce(async (from, to) => {
      renaming();
      await held;
      await realRename(from, to);
    });

    w.schedule();
    await inFlight;
    state.current = checkpoint(7);
    w.schedule();
    state.current = checkpoint(8);
    w.schedule();
    release();

    expect(await w.flush()).toBe(true);
    expect(writesTo(file)).toBe(2);
    expect(onDisk(file)).toEqual(checkpoint(8));
  });

  it('leaves a sealed checkpoint as sealed: later live schedules write nothing', async () => {
    const { writer: w, file, state } = writer();
    w.schedule();
    expect(await w.flush()).toBe(true);

    w.seal(() => ({ ...checkpoint(5), stoppedBy: 'user' }));
    state.current = checkpoint(6);
    w.schedule();

    expect(await w.flush()).toBe(true);
    const sealed = onDisk(file) as Record<string, unknown>;
    expect(sealed).toMatchObject({ stoppedBy: 'user', asOf: 5 });
    expect('live' in sealed).toBe(false);
  });

  it('lets a second seal replace the sealed content', async () => {
    const { writer: w, file } = writer();
    w.seal(() => ({ ...checkpoint(5), stoppedBy: 'user' }));
    w.seal(() => ({ ...checkpoint(9), stoppedBy: 'user' }));

    expect(await w.flush()).toBe(true);
    const { live: _live, ...expected } = { ...checkpoint(9), stoppedBy: 'user' as const };
    expect(onDisk(file)).toEqual(expected);
  });

  it('removes a stale temp file a crashed write left before its first write, and nothing else', async () => {
    const { writer: w, file, dir } = writer();
    fs.mkdirSync(dir, { recursive: true });
    const stale = `${file}.48151.tmp`;
    const other = path.join(dir, 'notes.txt');
    fs.writeFileSync(stale, '{"version":1');
    fs.writeFileSync(other, 'keep');

    w.schedule();

    expect(await w.flush()).toBe(true);
    expect(fs.readdirSync(dir).sort()).toEqual([path.basename(file), 'notes.txt']);
  });

  it('removes the temp file an older writer named without a pid', async () => {
    const { writer: w, file, dir } = writer();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, '{"version":1');

    w.schedule();

    expect(await w.flush()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([path.basename(file)]);
  });

  it('does not report a stale temp it cannot remove as a failed write', async () => {
    const { writer: w, file, dir, errors } = writer();
    // A folder under a temp file's name, which rm without `recursive` refuses.
    fs.mkdirSync(`${file}.48151.tmp`, { recursive: true });

    w.schedule();

    expect(await w.flush()).toBe(true);
    expect(errors).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual([path.basename(file), `${path.basename(file)}.48151.tmp`]);
  });

  it('serializes each written checkpoint once', async () => {
    const { writer: w } = writer();
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      w.schedule();
      expect(await w.flush()).toBe(true);
      expect(stringify).toHaveBeenCalledTimes(1);
    } finally {
      stringify.mockRestore();
    }
  });

  it('reports a seal whose content cannot be built, never throws it, and ends live writes so the last snapshot stays', async () => {
    const { writer: w, file, state, errors } = writer();
    w.schedule();
    expect(await w.flush()).toBe(true);
    const broken = new Error('take failed');

    expect(() => w.seal(() => { throw broken; })).not.toThrow();
    state.current = checkpoint(6);
    w.schedule();

    expect(await w.flush()).toBe(false);
    expect(errors).toEqual([broken]);
    expect(onDisk(file)).toEqual(checkpoint(1));
    expect(w.hasLanded).toBe(true);
  });

  it('reports a snapshot that throws through flush and onError, never into the caller', async () => {
    const dir = path.join(ROOT, crypto.randomUUID(), 'checkpoints');
    const errors: Error[] = [];
    const broken = new Error('snapshot failed');
    const w = new CheckpointWriter({ filePath: path.join(dir, `${KEY}.json`), snapshot: () => { throw broken; }, onError: (err) => errors.push(err) });

    expect(() => w.schedule()).not.toThrow();
    expect(await w.flush()).toBe(false);
    expect(errors).toEqual([broken]);
  });

  it('reports a failed rename through flush, never throws, and lands the next write', async () => {
    const { writer: w, file, state, errors } = writer();
    const locked = Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    vi.mocked(renameWithRetry).mockRejectedValueOnce(locked);

    expect(() => w.schedule()).not.toThrow();
    expect(await w.flush()).toBe(false);
    expect(errors).toEqual([locked]);
    expect(fs.existsSync(file)).toBe(false);

    state.current = checkpoint(2);
    w.schedule();
    expect(await w.flush()).toBe(true);
    expect(onDisk(file)).toEqual(checkpoint(2));
    // The failed write's temp file does not outlive the write that replaced it.
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });

  it('does not rewrite an unchanged snapshot', async () => {
    const { writer: w, file } = writer();
    w.schedule();
    expect(await w.flush()).toBe(true);
    expect(writesTo(file)).toBe(1);

    w.schedule();
    w.schedule();

    expect(await w.flush()).toBe(true);
    expect(writesTo(file)).toBe(1);
  });

  it('creates the folder at its first write, and a write after the folder was removed recreates nothing and reports ENOENT', async () => {
    const { writer: w, file, dir, state, errors } = writer();
    expect(fs.existsSync(dir)).toBe(false);
    w.schedule();
    expect(await w.flush()).toBe(true);
    expect(fs.existsSync(file)).toBe(true);

    fs.rmSync(path.dirname(dir), { recursive: true });
    state.current = checkpoint(3);
    w.schedule();

    expect(await w.flush()).toBe(false);
    expect(fs.existsSync(path.dirname(dir))).toBe(false);
    expect(errors.map((e) => (e as NodeJS.ErrnoException).code)).toEqual(['ENOENT']);
  });
});
