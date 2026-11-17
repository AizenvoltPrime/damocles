import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { initPiLoader, type PiCodingAgentModule } from '../../pi-loader';
import { createReadTool } from '../read-tool';

/**
 * `afterStat` runs once a text stream has opened and sized its file, before it reads a byte; `closed` lists the files whose
 * stream closed. The image sniff opens files too, but never sizes them.
 */
const fsHooks = vi.hoisted(() => ({ afterStat: undefined as (() => Promise<void> | void) | undefined, closed: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const stat = handle.stat.bind(handle);
      const close = handle.close.bind(handle);
      let sized = false;
      return Object.assign(handle, {
        stat: async (...statArgs: Parameters<typeof stat>) => {
          const stats = await stat(...statArgs);
          sized = true;
          const hook = fsHooks.afterStat;
          fsHooks.afterStat = undefined;
          await hook?.();
          return stats;
        },
        // Node's file stream calls `close` again once its handle closed, so only the first call counts.
        close: async () => {
          await close();
          if (sized) fsHooks.closed.push(String(args[0]));
          sized = false;
        },
      });
    },
  };
});

let pi: PiCodingAgentModule;
const dirs: string[] = [];

beforeAll(async () => {
  pi = (await initPiLoader())!;
});

afterEach(() => {
  fsHooks.afterStat = undefined;
  fsHooks.closed = [];
  vi.mocked(readFile).mockClear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-read-'));
  dirs.push(dir);
  return dir;
}

type ReadParams = { path: string; offset?: number; limit?: number };

function run(tool: ToolDefinition, cwd: string, params: ReadParams): Promise<unknown> {
  return tool.execute('tc', params as never, undefined, undefined, { cwd } as never);
}

/** The settled outcome, so a rejection compares by its message like a result does by its value. */
function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error: (error as Error).message }));
}

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

describe('the read override', () => {
  it('keeps pi\'s exact name and definition, and stays parallel', () => {
    const tool = createReadTool(pi, tempDir());
    const pis = pi.createReadToolDefinition(tempDir());

    expect(tool.name).toBe('read');
    expect(tool.description).toBe(pis.description);
    expect(tool.parameters).toEqual(pis.parameters);
    expect(tool.executionMode).toBeUndefined();
  });

  it.each<[string, string | Buffer, Omit<ReadParams, 'path'>]>([
    ['a small text file', 'a\nb\nc\n', {}],
    ['an offset and limit', lines(50), { offset: 10, limit: 5 }],
    ['an offset past the end', 'a\nb\n', { offset: 9 }],
    ['a file over the line limit', lines(2500), {}],
    ['a file over the byte limit', `${'y'.repeat(200)}\n`.repeat(400), {}],
    ['a first line over the byte limit', `${'z'.repeat(60 * 1024)}\nrest\n`, {}],
    ['CRLF text with a BOM', '\uFEFFa\r\nb\r\n', {}],
    ['an image', PNG, {}],
  ])('answers exactly as pi\'s read does, for %s', async (_label, content, params) => {
    const cwd = tempDir();
    const file = typeof content === 'string' ? 'f.txt' : 'f.png';
    fs.writeFileSync(path.join(cwd, file), content);

    const ours = await outcome(run(createReadTool(pi, cwd), cwd, { path: file, ...params }));
    const pis = await outcome(run(pi.createReadToolDefinition(cwd) as unknown as ToolDefinition, cwd, { path: file, ...params }));

    expect(ours).toEqual(pis);
  });

  it('fails as pi\'s read does on a missing file', async () => {
    const cwd = tempDir();

    const ours = await outcome(run(createReadTool(pi, cwd), cwd, { path: 'missing.txt' }));
    const pis = await outcome(run(pi.createReadToolDefinition(cwd) as unknown as ToolDefinition, cwd, { path: 'missing.txt' }));

    expect(ours).toEqual(pis);
  });

  it('reads and sniffs an image inside the file\'s mutation queue slot', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'f.png'), PNG);
    const inSlot: string[] = [];
    const withFileMutationQueue = <T>(file: string, fn: () => Promise<T>): Promise<T> => pi.withFileMutationQueue(file, () => {
      inSlot.push(file);
      return fn();
    });

    const ours = await outcome(run(createReadTool({ ...pi, withFileMutationQueue }, cwd), cwd, { path: 'f.png' }));

    expect(ours).toEqual(await outcome(run(pi.createReadToolDefinition(cwd) as unknown as ToolDefinition, cwd, { path: 'f.png' })));
    expect(inSlot).toEqual([path.join(cwd, 'f.png'), path.join(cwd, 'f.png')]);
  });

  // pi's queue rethrows a realpath error other than ENOENT and ENOTDIR before it runs the operation.
  it.each<[string, string | Buffer]>([
    ['f.txt', lines(3)],
    ['f.png', PNG],
  ])('reads %s unqueued, as pi\'s read does, when the queue cannot key it', async (file, content) => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, file), content);
    const withFileMutationQueue = vi.fn(() => Promise.reject(Object.assign(new Error('EPERM: operation not permitted, realpath'), { code: 'EPERM' })));

    const ours = await outcome(run(createReadTool({ ...pi, withFileMutationQueue }, cwd), cwd, { path: file }));

    expect(ours).toEqual(await outcome(run(pi.createReadToolDefinition(cwd) as unknown as ToolDefinition, cwd, { path: file })));
    expect(withFileMutationQueue).toHaveBeenCalled();
  });

  it('runs an operation that fails inside its queue slot once, never again unqueued', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'f.png'), PNG);
    vi.mocked(readFile).mockRejectedValueOnce(new Error('read failed'));

    const ours = await outcome(run(createReadTool(pi, cwd), cwd, { path: 'f.png' }));

    expect(ours).toEqual({ error: 'read failed' });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('reads the whole new content of a file a write holds truncated in its mutation slot, never the empty file', async () => {
    const cwd = tempDir();
    const file = path.join(cwd, 'f.txt');
    fs.writeFileSync(file, 'old\n');
    let truncated!: () => void;
    const isTruncated = new Promise<void>((resolve) => (truncated = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));

    const writing = pi.withFileMutationQueue(file, async () => {
      fs.writeFileSync(file, '');
      truncated();
      await released;
      fs.writeFileSync(file, 'new 1\nnew 2\n');
    });
    await isTruncated;
    const reading = run(createReadTool(pi, cwd), cwd, { path: 'f.txt' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await writing;

    expect(await reading).toMatchObject({ content: [{ type: 'text', text: 'new 1\nnew 2\n' }] });
  });

  it('fails as pi\'s read does on a directory', async () => {
    const cwd = tempDir();
    fs.mkdirSync(path.join(cwd, 'sub'));

    const ours = await outcome(run(createReadTool(pi, cwd), cwd, { path: 'sub' }));
    const pis = await outcome(run(pi.createReadToolDefinition(cwd) as unknown as ToolDefinition, cwd, { path: 'sub' }));

    expect(ours).toEqual(pis);
  });
});

describe('the read override\'s text stream', () => {
  it('reads a range of a large file through the stream, never readFile', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'big.txt'), lines(200_000));

    const ours = await outcome(run(createReadTool(pi, cwd), cwd, { path: 'big.txt', offset: 150_000, limit: 5 }));

    expect(readFile).not.toHaveBeenCalled();
    expect(fsHooks.closed).toEqual([path.join(cwd, 'big.txt')]);
    expect(ours).toEqual(await outcome(run(pi.createReadToolDefinition(cwd) as unknown as ToolDefinition, cwd, { path: 'big.txt', offset: 150_000, limit: 5 })));
  });

  it('holds the file\'s mutation slot until the stream closed, so a write queued meanwhile lands after the read', async () => {
    const cwd = tempDir();
    const file = path.join(cwd, 'f.txt');
    fs.writeFileSync(file, 'old 1\nold 2\n');
    const order: string[] = [];
    let writing: Promise<void> | undefined;
    fsHooks.afterStat = async () => {
      writing = pi.withFileMutationQueue(file, async () => {
        order.push(`write after ${fsHooks.closed.length} close`);
        fs.writeFileSync(file, 'new\n');
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const result = await run(createReadTool(pi, cwd), cwd, { path: 'f.txt' });
    await writing;

    expect(result).toMatchObject({ content: [{ type: 'text', text: 'old 1\nold 2\n' }] });
    expect(order).toEqual(['write after 1 close']);
    expect(fs.readFileSync(file, 'utf-8')).toBe('new\n');
  });

  // pi 1.5.2 `test/read-streaming.test.ts:224`.
  it('reads a file up to its size when opened, as readFile does', async () => {
    const cwd = tempDir();
    const file = path.join(cwd, 'growing.txt');
    // Larger than one 64 KB stream chunk, so the append lands before the stream reaches the end.
    fs.writeFileSync(file, `head\n${'x'.repeat(200_000)}`);
    fsHooks.afterStat = () => fs.appendFileSync(file, '\nadded');

    const result = await run(createReadTool(pi, cwd), cwd, { path: 'growing.txt', limit: 1 });

    expect(result).toMatchObject({ content: [{ type: 'text', text: 'head\n\n[1 more lines in file. Use offset=2 to continue.]' }] });
  });

  it('stops reading when aborted, closing the file and freeing its slot', async () => {
    const cwd = tempDir();
    const file = path.join(cwd, 'f.txt');
    fs.writeFileSync(file, lines(50_000));
    const controller = new AbortController();
    fsHooks.afterStat = () => controller.abort();

    await expect(createReadTool(pi, cwd).execute('tc', { path: 'f.txt' } as never, controller.signal, undefined, { cwd } as never)).rejects.toThrow('Operation aborted');

    // pi answers the abort at once; the stream winds down after it.
    await vi.waitFor(() => expect(fsHooks.closed).toEqual([file]));
    await expect(pi.withFileMutationQueue(file, async () => 'free')).resolves.toBe('free');
  });
});
