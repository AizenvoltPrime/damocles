import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSON_CONFIG_LOCK_STALE_MS, writeJsonConfig } from '../json-config-write';

const WRITES_PER_PROCESS = 200;
const PREFIXES = ['a', 'b'] as const;

let workDir: string;
let childBundle: string;

beforeAll(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'damocles-json-write-'));
  childBundle = path.join(workDir, 'writer-child.cjs');
  // The child runs the real module in a plain node process, so it is bundled rather than loaded through Vitest.
  await build({
    entryPoints: [path.join(__dirname, 'fixtures', 'json-config-writer-child.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: childBundle,
    logLevel: 'silent',
  });
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
});

interface ChildRun {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly exited: Promise<{ code: number | null; stderr: string }>;
}

function startWriter(file: string, prefix: string): ChildRun {
  const child = fork(childBundle, [file, prefix, String(WRITES_PER_PROCESS)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
  });
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.once('exit', (code) => resolve({ code, stderr }));
  });
  return { child, ready, exited };
}

describe('writeJsonConfig across processes', () => {
  it('keeps every mutation from two interleaved writers, and a lock-free reader always sees parseable JSON', async () => {
    const file = path.join(workDir, 'two-writers', 'settings.json');
    const writers = PREFIXES.map((prefix) => startWriter(file, prefix));
    await Promise.all(writers.map((w) => w.ready));
    for (const w of writers) w.child.send('go');

    let done = false;
    const allExited = Promise.all(writers.map((w) => w.exited)).finally(() => {
      done = true;
    });

    const unparseable: string[] = [];
    let parsedReads = 0;
    while (!done) {
      // Pacing only: a reader holding the file open nonstop makes every Windows rename retry.
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      let text: string;
      try {
        text = await readFile(file, 'utf-8');
      } catch (err) {
        // Before the first rename the file does not exist yet.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        continue;
      }
      try {
        JSON.parse(text);
        parsedReads++;
      } catch {
        unparseable.push(text);
      }
    }

    const results = await allExited;
    expect(results).toEqual(PREFIXES.map(() => ({ code: 0, stderr: '' })));
    expect(unparseable).toEqual([]);
    // The reader ran alongside the writers rather than after them.
    expect(parsedReads).toBeGreaterThan(10);

    const final = JSON.parse(await readFile(file, 'utf-8')) as Record<string, number>;
    const expected = Object.fromEntries(
      PREFIXES.flatMap((prefix) => Array.from({ length: WRITES_PER_PROCESS }, (_, i) => [`${prefix}-${i}`, i])),
    );
    expect(Object.keys(final)).toHaveLength(PREFIXES.length * WRITES_PER_PROCESS);
    expect(final).toEqual(expected);
    // The lock is released and no temp file is left beside the target.
    expect(readdirSync(path.dirname(file))).toEqual(['settings.json']);
  }, 60_000);
});

describe('writeJsonConfig stale lock', () => {
  it('takes over a lock left by a dead process and completes the write', async () => {
    const dir = path.join(workDir, 'stale');
    const file = path.join(dir, 'mcp.json');
    const lockDir = `${file}.lock`;
    mkdirSync(lockDir, { recursive: true });
    // A dead holder stops refreshing the lock's mtime, so it ages past the stale threshold.
    const deadAt = (Date.now() - JSON_CONFIG_LOCK_STALE_MS * 3) / 1000;
    utimesSync(lockDir, deadAt, deadAt);

    const started = Date.now();
    await writeJsonConfig(file, (current) => {
      expect(current).toBeUndefined();
      return JSON.stringify({ servers: { x: {} } });
    });

    // A live lock would hold the write for at least the stale threshold.
    expect(Date.now() - started).toBeLessThan(JSON_CONFIG_LOCK_STALE_MS);
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual({ servers: { x: {} } });
    expect(existsSync(lockDir)).toBe(false);
  }, 30_000);
});
