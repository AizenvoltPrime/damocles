import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { REPO_ROOT } from '../../../../../__mocks__/source-tree';
import { installLogSink } from '../../../../logger';
import { createThreadParser } from '../parser';
import { PI_PACKAGE_DIR } from './in-process';

let logged: string[];

beforeEach(() => {
  logged = [];
  installLogSink({ appendLine: (line) => logged.push(line), show: () => undefined, dispose: () => undefined });
});

afterEach(() => installLogSink({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }));

const stopLines = (): string[] => logged.filter((line) => line.includes('the parse thread stopped'));

// The parse thread runs the worker bundle in its parse role, so it is tested through that bundle.
let workDir: string;
let bundle: string;

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-meta-parse-'));
  bundle = path.join(workDir, 'session-meta-index-worker.js');
  await build({
    entryPoints: [path.join(REPO_ROOT, 'src', 'core', 'pi-session', 'session-store', 'meta-index', 'worker.ts')],
    absWorkingDir: REPO_ROOT,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    outfile: bundle,
    external: ['node:sqlite', '@earendil-works/*'],
    logLevel: 'silent',
  });
}, 60_000);

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeSession(dir: string, n: number): string {
  const id = `01a0e000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const file = path.join(dir, `2026-01-01T00-00-0${n}-000Z_${id}.jsonl`);
  const header = { type: 'session', version: 3, id, timestamp: `2026-01-01T00:00:0${n}.000Z`, cwd: dir };
  const message = { type: 'message', id: `u${n}`, parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: `prompt ${n}` }], timestamp: 1_700_000_000_000 + n } };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
  return file;
}

describe('the thread parser', () => {
  it('parses with pi on its own thread, in request order', async () => {
    const dir = fs.mkdtempSync(path.join(workDir, 'sessions-'));
    const files = [1, 2, 3].map((n) => writeSession(dir, n));
    const parser = createThreadParser(bundle, PI_PACKAGE_DIR);
    try {
      const parsed = await Promise.all(files.map((file) => parser.parse(file, fs.statSync(file).mtimeMs)));
      expect(parsed.map((meta) => meta?.stored?.preview)).toEqual(['prompt 1', 'prompt 2', 'prompt 3']);
      expect(parsed.map((meta) => meta?.prompts)).toEqual([['prompt 1'], ['prompt 2'], ['prompt 3']]);
    } finally {
      await parser.close();
    }
  }, 60_000);

  it('stops a thread that answers nothing for the stall timeout, answering its waiting parses with nothing', async () => {
    const silent = path.join(workDir, 'silent-parse-thread.js');
    fs.writeFileSync(silent, "require('node:worker_threads').parentPort.on('message', () => undefined);\n");
    const parser = createThreadParser(silent, PI_PACKAGE_DIR, 200);
    try {
      expect(await parser.parse(path.join(workDir, 'any.jsonl'), 1)).toBeUndefined();
      expect(stopLines()).toEqual([expect.stringContaining('no answer for 200ms); 1 parse(s) dropped')]);
    } finally {
      await parser.close();
    }
  }, 10_000);

  it('answers parses it had not finished with nothing when it closes, logging no failure, and starts a new thread for the next parse', async () => {
    const dir = fs.mkdtempSync(path.join(workDir, 'sessions-'));
    const file = writeSession(dir, 4);
    const parser = createThreadParser(bundle, PI_PACKAGE_DIR);
    const dropped = parser.parse(file, fs.statSync(file).mtimeMs);
    await parser.close();
    expect(await dropped).toBeUndefined();
    expect(stopLines()).toEqual([]);

    try {
      expect((await parser.parse(file, fs.statSync(file).mtimeMs))?.stored?.preview).toBe('prompt 4');
    } finally {
      await parser.close();
    }
  }, 60_000);
});
