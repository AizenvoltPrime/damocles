import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { initPiLoader, type PiCodingAgentModule } from '../../pi-loader';
import { createReadTool } from '../read-tool';

let pi: PiCodingAgentModule;
const dirs: string[] = [];

beforeAll(async () => {
  pi = (await initPiLoader())!;
});

afterEach(() => {
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
    const detectSupportedImageMimeTypeFromFile = vi.fn(() => Promise.reject(new Error('sniff failed')));

    const ours = await outcome(run(createReadTool({ ...pi, detectSupportedImageMimeTypeFromFile }, cwd), cwd, { path: 'f.png' }));

    expect(ours).toEqual({ error: 'sniff failed' });
    expect(detectSupportedImageMimeTypeFromFile).toHaveBeenCalledTimes(1);
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
});
