import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { runAgentLoop, type AgentEvent, type AgentTool } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { initPiLoader, type PiCodingAgentModule } from '../../pi-loader';
import { createEditTool } from '../edit-tool';
import { editTooLarge, notARegularFile } from '../local-file-operations';
import { EDITOR_HARD_MAX_DOCUMENT_BYTES } from '../../../../shared/types/messages';
import { createReadTool } from '../read-tool';
import { createWriteTool } from '../write-tool';
import { FILE_PATCH_TIMEOUT_MS } from '../file-patch';
import { createThreadDiffService, DIFF_WATCHDOG_GRACE_MS, diffService, type DiffService } from '../../../diff';
import { buildDiffWorker } from '../../../diff/__tests__/worker-bundle';
import type { FilePatch } from '../../../../shared/types/file-patch';
import { log } from '../../../logger';

vi.mock('../../../logger', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../logger')>()), log: vi.fn() }));

/** Paths whose stat answers as a FIFO's, every path the edit operations' readFile was asked for, and what runs after a stat answers. */
const files = vi.hoisted(() => ({ fifos: new Set<string>(), reads: [] as string[], afterStat: undefined as ((file: string) => void) | undefined }));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    stat: (async (file: string, options?: object) => {
      const stats = await actual.stat(file, options);
      files.afterStat?.(String(file));
      return files.fifos.has(String(file)) ? Object.assign(stats, { isFile: () => false, isFIFO: () => true }) : stats;
    }) as typeof actual.stat,
    readFile: ((file: string, ...rest: never[]) => {
      files.reads.push(String(file));
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest);
    }) as typeof actual.readFile,
  };
});

let pi: PiCodingAgentModule;
const dirs: string[] = [];

beforeAll(async () => {
  pi = (await initPiLoader())!;
});

afterEach(() => {
  vi.mocked(log).mockClear();
  files.fifos.clear();
  files.reads = [];
  files.afterStat = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function editLogs(): unknown[][] {
  return vi.mocked(log).mock.calls.filter(([format]) => String(format).startsWith('[edit]'));
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-edit-'));
  dirs.push(dir);
  return dir;
}

type EditParams = { file_path: string; old_string: string; new_string: string; replace_all?: boolean };

function run(tool: ToolDefinition, cwd: string, params: unknown): Promise<unknown> {
  return tool.execute('tc', params as never, undefined, undefined, { cwd } as never);
}

function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error: (error as Error).message }));
}

// pi's details carry a display diff, which Damocles' Edit does not compute since nothing reads it.
function withoutDisplayDiff(details: unknown): unknown {
  const { diff: _diff, ...rest } = details as { diff?: string };
  return rest;
}

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  } as AssistantMessage;
}

/** Runs one model reply holding `calls` as a batch through pi's agent loop, then a reply that ends the run. */
async function runBatch(tools: ToolDefinition[], cwd: string, calls: ToolCall[]): Promise<AgentEvent[]> {
  const replies = [assistant(calls, 'toolUse'), assistant([{ type: 'text', text: 'done' }], 'stop')];
  const events: AgentEvent[] = [];
  const agentTools = tools.map((tool) => ({
    ...tool,
    execute: (id: string, params: unknown, signal?: AbortSignal) => tool.execute(id, params as never, signal, undefined, { cwd } as never),
  })) as unknown as AgentTool[];
  await runAgentLoop(
    [{ role: 'user', content: 'go', timestamp: Date.now() }],
    { messages: [], tools: agentTools },
    { model: { provider: 'test', api: 'test', id: 'test' }, convertToLlm: (messages: unknown[]) => messages } as never,
    (event) => {
      events.push(event);
    },
    undefined,
    (() => {
      const stream = createAssistantMessageEventStream();
      const message = replies.shift()!;
      queueMicrotask(() => stream.push({ type: 'done', reason: message.stopReason as 'stop', message }));
      return stream;
    }) as never,
  );
  return events;
}

describe('Edit and write run their batch in order', () => {
  it('are sequential, so pi runs any batch holding one call after call', () => {
    expect(createEditTool(pi, tempDir(), diffService()).executionMode).toBe('sequential');
    expect(createWriteTool(pi, tempDir(), diffService()).executionMode).toBe('sequential');
  });

  it('[Edit F, read F] in one batch reads the edited file, the read starting after the edit ended', async () => {
    const cwd = tempDir();
    const file = path.join(cwd, 'f.txt');
    fs.writeFileSync(file, `${'line\n'.repeat(600)}last\n`);

    const events = await runBatch([createEditTool(pi, cwd, diffService()), createReadTool(pi, cwd)], cwd, [
      { type: 'toolCall', id: 'e', name: 'Edit', arguments: { file_path: file, old_string: 'last\n', new_string: 'last\nappended\n' } },
      { type: 'toolCall', id: 'r', name: 'read', arguments: { path: file } },
    ]);

    const order = events.filter((e) => e.type === 'tool_execution_start' || e.type === 'tool_execution_end').map((e) => `${e.type}:${(e as { toolName: string }).toolName}`);
    expect(order).toEqual(['tool_execution_start:Edit', 'tool_execution_end:Edit', 'tool_execution_start:read', 'tool_execution_end:read']);
    const read = events.find((e) => e.type === 'tool_execution_end' && e.toolName === 'read') as { result: { content: Array<{ text: string }> }; isError: boolean };
    expect(read.isError).toBe(false);
    expect(read.result.content[0]!.text).toBe(fs.readFileSync(file, 'utf-8'));
    expect(read.result.content[0]!.text.endsWith('last\nappended\n')).toBe(true);
  });
});

describe('Edit of a single replacement', () => {
  it.each([
    ['LF text', 'one\ntwo\nthree\n', 'two', 'TWO'],
    ['CRLF text with a BOM', '\uFEFFone\r\ntwo\r\nthree\r\n', 'two\nthree', '2\n3'],
    ['mixed line endings and a lone CR', 'one\rtwo\nthree\r\nfour\n', 'three', 'a\nb'],
    ['a fuzzy match of smart quotes and trailing whitespace', 'say \u201chi\u201d  \nkeep\n', 'say "hi"', 'say "bye"'],
    ['a fuzzy match of a dash in CRLF text', 'it\u2019s \u2013 done\r\nkeep\r\n', 'it\'s - done', 'done'],
  ])('leaves the bytes pi\'s edit leaves and answers as it does, for %s', async (_label, content, oldString, newString) => {
    const ours = tempDir();
    const theirs = tempDir();
    fs.writeFileSync(path.join(ours, 'f.txt'), content);
    fs.writeFileSync(path.join(theirs, 'f.txt'), content);

    const mine = await outcome(run(createEditTool(pi, ours, diffService()), ours, { file_path: 'f.txt', old_string: oldString, new_string: newString } satisfies EditParams));
    const pis = await outcome(run(pi.createEditToolDefinition(theirs) as unknown as ToolDefinition, theirs, { path: 'f.txt', edits: [{ oldText: oldString, newText: newString }] }));

    expect(fs.readFileSync(path.join(ours, 'f.txt'))).toEqual(fs.readFileSync(path.join(theirs, 'f.txt')));
    const { value } = pis as { value: { content: unknown; details: unknown } };
    expect(mine).toEqual({ value: { ...value, details: withoutDisplayDiff(value.details) } });
  });

  it.each([
    ['an absent old_string', 'one\n', 'two', 'TWO'],
    ['an old_string found twice', 'a\na\n', 'a', 'b'],
    ['a replacement that changes nothing', 'one\n', 'one', 'one'],
    ['a missing file', undefined, 'a', 'b'],
  ])('fails as pi\'s edit does on %s, and leaves the file', async (_label, content, oldString, newString) => {
    const cwd = tempDir();
    if (content !== undefined) fs.writeFileSync(path.join(cwd, 'f.txt'), content);

    const mine = await outcome(run(createEditTool(pi, cwd, diffService()), cwd, { file_path: 'f.txt', old_string: oldString, new_string: newString } satisfies EditParams));
    const pis = await outcome(run(pi.createEditToolDefinition(cwd) as unknown as ToolDefinition, cwd, { path: 'f.txt', edits: [{ oldText: oldString, newText: newString }] }));

    expect(mine).toEqual(pis);
    expect(mine).toHaveProperty('error');
    if (content !== undefined) expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf-8')).toBe(content);
  });

  it('still writes when its patch job fails, logging it once and recording no patch', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'a\nb\n');
    const failing = { filePatch: diffService().filePatch, editPatch: () => Promise.reject(new Error('diff failed')) };

    const result = (await run(createEditTool(pi, cwd, failing), cwd, { file_path: 'f.txt', old_string: 'b', new_string: 'B' })) as { details: unknown };

    expect(result.details).toEqual({ firstChangedLine: 2 });
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf-8')).toBe('a\nB\n');
    expect(editLogs()).toEqual([['[edit] no diff recorded for %s: %O', path.resolve(cwd, 'f.txt'), new Error('diff failed')]]);
  });
});

describe('Edit stopped while its patch is queued', () => {
  it.each([
    ['a single replacement', false],
    ['replace_all', true],
  ])('answers as pi\'s edit does and writes nothing, for %s', async (_label, replaceAll) => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'foo a\nkeep\n');
    const signals: Array<AbortSignal | undefined> = [];
    let answer!: (patch: FilePatch) => void;
    let queued!: () => void;
    const patchQueued = new Promise<void>((resolve) => (queued = resolve));
    const pending = (options: Parameters<DiffService['filePatch']>[3]): Promise<FilePatch> => {
      signals.push(options?.signal);
      queued();
      return new Promise((resolve) => (answer = resolve));
    };
    const deferred = {
      filePatch: (...args: Parameters<DiffService['filePatch']>) => pending(args[3]),
      editPatch: (...args: Parameters<DiffService['editPatch']>) => pending(args[4]),
    };
    const stop = new AbortController();

    const editing = createEditTool(pi, cwd, deferred).execute('tc', { file_path: 'f.txt', old_string: 'foo', new_string: 'bar', ...(replaceAll ? { replace_all: true } : {}) }, stop.signal, undefined, { cwd } as never);
    await patchQueued;
    stop.abort();
    answer({ patchOmitted: 'tooLarge' });

    await expect(editing).rejects.toThrow('Operation aborted');
    expect(signals).toEqual([stop.signal]);
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf-8')).toBe('foo a\nkeep\n');
  });
});

describe('Edit on the diff worker', () => {
  let workDir: string;
  let bundle: string;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-edit-worker-'));
    bundle = await buildDiffWorker(workDir);
  }, 60_000);

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  // A single replacement's patch has no changed-line bound, so only the tool lane's budget and the worker keep core's thread free.
  it('keeps the event loop responsive while it patches a single replacement that rewrites 5,000 lines', async () => {
    const cwd = tempDir();
    const before = Array.from({ length: 5_000 }, (_, i) => `  const value${i} = compute(${i});`).join('\n');
    const after = Array.from({ length: 5_000 }, (_, i) => `  let renamed${i} = other(${i * 7});`).join('\n');
    fs.writeFileSync(path.join(cwd, 'big.ts'), `header\n${before}\nfooter\n`);
    const thread = createThreadDiffService(bundle);
    const patched: string[] = [];
    const counting = {
      filePatch: (file: string, base: string, next: string) => (patched.push(`filePatch ${file}`), thread.filePatch(file, base, next)),
      editPatch: (...args: Parameters<DiffService['editPatch']>) => (patched.push(`editPatch ${args[0]}`), thread.editPatch(...args)),
    };
    const delay = monitorEventLoopDelay({ resolution: 10 });
    try {
      delay.enable();
      // the histogram records nothing before its first timer tick
      await new Promise((resolve) => setTimeout(resolve, 50));
      const start = performance.now();
      const result = (await run(createEditTool(pi, cwd, counting), cwd, { file_path: 'big.ts', old_string: before, new_string: after } satisfies EditParams)) as { details: unknown };
      const elapsed = performance.now() - start;
      await new Promise((resolve) => setTimeout(resolve, 50));
      delay.disable();

      expect(patched).toEqual(['editPatch big.ts']);
      expect(result.details).toEqual({ firstChangedLine: 2, patchOmitted: 'tooLarge' });
      expect(fs.readFileSync(path.join(cwd, 'big.ts'), 'utf-8')).toBe(`header\n${after}\nfooter\n`);
      expect(delay.max / 1e6).toBeLessThan(250);
      expect(elapsed).toBeLessThan(FILE_PATCH_TIMEOUT_MS + DIFF_WATCHDOG_GRACE_MS + 2_000);
    } finally {
      await thread.close();
    }
  }, 60_000);
});

describe('Edit replace_all', () => {
  it.each([
    ['LF text', 'foo a\nfoo b\nkeep\nfoo c\n'],
    ['CRLF text', 'foo a\r\nfoo b\r\nkeep\r\nfoo c\r\n'],
    ['CRLF text with a BOM', '\uFEFFfoo a\r\nfoo b\r\nkeep\r\nfoo c\r\n'],
  ])('leaves the bytes pi\'s edit leaves and answers as it does, for %s', async (_label, content) => {
    const ours = tempDir();
    const theirs = tempDir();
    fs.writeFileSync(path.join(ours, 'f.txt'), content);
    fs.writeFileSync(path.join(theirs, 'f.txt'), content);
    // pi applies a replace-all as one whole-file edit, unique by construction.
    const whole = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

    const mine = await outcome(run(createEditTool(pi, ours, diffService()), ours, { file_path: 'f.txt', old_string: 'foo', new_string: 'bar', replace_all: true } satisfies EditParams));
    const pis = await outcome(run(pi.createEditToolDefinition(theirs) as unknown as ToolDefinition, theirs, {
      path: 'f.txt',
      edits: [{ oldText: whole, newText: whole.split('foo').join('bar') }],
    }));

    expect(fs.readFileSync(path.join(ours, 'f.txt'))).toEqual(fs.readFileSync(path.join(theirs, 'f.txt')));
    const { value } = pis as { value: { content: unknown; details: unknown } };
    expect(mine).toEqual({ value: { ...value, details: withoutDisplayDiff(value.details) } });
  });

  it.each([
    ['a lone CR', 'foo a\rfoo b\nfoo c\n', 'bar', 'bar a\rbar b\nbar c\n'],
    ['mixed CRLF and LF', 'foo a\r\nfoo b\nkeep\r\nfoo c\n', 'bar', 'bar a\r\nbar b\nkeep\r\nbar c\n'],
    ['a multi-line replacement in mixed text', 'foo a\r\nfoo b\nfoo c\r\n', 'x\ny', 'x\r\ny a\r\nx\ny b\nx\r\ny c\r\n'],
  ])('keeps each untouched line ending, writing the bytes and patch of pi\'s edit of each occurrence, for %s', async (_label, content, newString, expected) => {
    const ours = tempDir();
    const theirs = tempDir();
    fs.writeFileSync(path.join(ours, 'f.txt'), content);
    fs.writeFileSync(path.join(theirs, 'f.txt'), content);
    const lines = content.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.startsWith('foo'));

    const mine = (await run(createEditTool(pi, ours, diffService()), ours, { file_path: 'f.txt', old_string: 'foo', new_string: newString, replace_all: true } satisfies EditParams)) as { content: unknown; details: unknown };
    const pis = (await run(pi.createEditToolDefinition(theirs) as unknown as ToolDefinition, theirs, {
      path: 'f.txt',
      edits: lines.map((line) => ({ oldText: line, newText: line.replace('foo', newString) })),
    })) as { details: unknown };

    expect(fs.readFileSync(path.join(ours, 'f.txt'), 'utf-8')).toBe(expected);
    expect(fs.readFileSync(path.join(theirs, 'f.txt'), 'utf-8')).toBe(expected);
    expect(mine.details).toEqual(withoutDisplayDiff(pis.details));
    expect(mine.content).toEqual([{ type: 'text', text: 'Successfully replaced 1 block(s) in f.txt.' }]);
  });

  it('still writes when its patch job fails, logging it once and recording no patch', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'foo a\nfoo b\n');
    const failing = { filePatch: () => Promise.reject(new Error('diff failed')), editPatch: diffService().editPatch };

    const result = (await run(createEditTool(pi, cwd, failing), cwd, { file_path: 'f.txt', old_string: 'foo', new_string: 'bar', replace_all: true })) as { details: unknown };

    expect(result.details).toEqual({ firstChangedLine: 1 });
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf-8')).toBe('bar a\nbar b\n');
    expect(editLogs()).toEqual([['[edit] no diff recorded for %s: %O', path.resolve(cwd, 'f.txt'), new Error('diff failed')]]);
  });

  it('computes its patch on the diff service and numbers the first changed line as pi does', async () => {
    const cwd = tempDir();
    const filler = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    fs.writeFileSync(path.join(cwd, 'f.txt'), [...filler, 'foo mid', ...filler, 'foo bottom'].join('\r\n'));
    const patched: string[] = [];
    const counting = { filePatch: (file: string, before: string, after: string) => (patched.push(file), diffService().filePatch(file, before, after)), editPatch: diffService().editPatch };

    const result = (await run(createEditTool(pi, cwd, counting), cwd, { file_path: 'f.txt', old_string: 'foo', new_string: 'bar', replace_all: true })) as { details: { patch: string; firstChangedLine: number } };

    expect(patched).toEqual(['f.txt']);
    expect(result.details.firstChangedLine).toBe(201);
    expect(result.details.patch.split('\n').filter((line) => /^(@@|[+-][^+-])/.test(line))).toEqual(['@@ -197,9 +197,9 @@', '-foo mid', '+bar mid', '@@ -398,5 +398,5 @@', '-foo bottom', '+bar bottom']);
  });

  it('says so when old_string is absent, and leaves the file', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'nothing here\n');

    await expect(run(createEditTool(pi, cwd, diffService()), cwd, { file_path: 'f.txt', old_string: 'foo', new_string: 'bar', replace_all: true })).rejects.toThrow('String to replace not found in file: f.txt');
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf-8')).toBe('nothing here\n');
  });

  it('fails as pi\'s edit does on a missing file and on a replacement that changes nothing', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'same.txt'), 'foo\n');

    const missing = await outcome(run(createEditTool(pi, cwd, diffService()), cwd, { file_path: 'missing.txt', old_string: 'a', new_string: 'b', replace_all: true }));
    const pisMissing = await outcome(run(pi.createEditToolDefinition(cwd) as unknown as ToolDefinition, cwd, { path: 'missing.txt', edits: [{ oldText: 'a', newText: 'b' }] }));
    const same = await outcome(run(createEditTool(pi, cwd, diffService()), cwd, { file_path: 'same.txt', old_string: 'foo', new_string: 'foo', replace_all: true }));
    const pisSame = await outcome(run(pi.createEditToolDefinition(cwd) as unknown as ToolDefinition, cwd, { path: 'same.txt', edits: [{ oldText: 'foo\n', newText: 'foo\n' }] }));

    expect(missing).toEqual(pisMissing);
    expect(same).toEqual(pisSame);
  });

  it('computes its result in the file\'s mutation slot, so a write holding the slot keeps its change', async () => {
    const cwd = tempDir();
    const file = path.join(cwd, 'f.txt');
    fs.writeFileSync(file, 'foo one\n');
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));

    const writing = pi.withFileMutationQueue(file, async () => {
      await released;
      fs.writeFileSync(file, 'foo one\nfoo two\n');
    });
    const editing = run(createEditTool(pi, cwd, diffService()), cwd, { file_path: 'f.txt', old_string: 'foo', new_string: 'bar', replace_all: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await writing;
    await editing;

    expect(fs.readFileSync(file, 'utf-8')).toBe('bar one\nbar two\n');
  });

  it('refuses an empty old_string, which cannot create a file', async () => {
    const cwd = tempDir();
    await expect(run(createEditTool(pi, cwd, diffService()), cwd, { file_path: 'f.txt', old_string: '', new_string: 'x' })).rejects.toThrow('Use the Write tool');
  });
});

describe('Edit of a path that is not a regular file', () => {
  it.each([
    ['a single edit', {}],
    ['replace_all', { replace_all: true }],
  ])('refuses %s with the approval\'s message, never reading the file', async (_label, extra) => {
    const cwd = tempDir();
    const file = path.join(cwd, 'pipe');
    fs.writeFileSync(file, 'never read');
    files.fifos.add(file);

    const result = await outcome(run(createEditTool(pi, cwd, diffService()), cwd, { file_path: 'pipe', old_string: 'never', new_string: 'x', ...extra }));

    expect(result).toEqual({ error: notARegularFile('pipe') });
    expect(result).toEqual({ error: 'Could not edit file: pipe. It is not a regular file.' });
    expect(files.reads.filter((read) => read === file)).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('never read');
  });

  it('refuses a folder, and leaves a missing file to pi\'s own refusal', async () => {
    const cwd = tempDir();
    fs.mkdirSync(path.join(cwd, 'dir'));
    expect(await outcome(run(createEditTool(pi, cwd, diffService()), cwd, { file_path: 'dir', old_string: 'a', new_string: 'b' }))).toEqual({ error: notARegularFile('dir') });
    expect(await outcome(run(createEditTool(pi, cwd, diffService()), cwd, { file_path: 'gone.txt', old_string: 'a', new_string: 'b' }))).toEqual({ error: 'Could not edit file: gone.txt. Error code: ENOENT.' });
  });

  it.runIf(process.platform !== 'win32')('refuses a FIFO without opening it, which would wait for a writer', async () => {
    const cwd = tempDir();
    execFileSync('mkfifo', [path.join(cwd, 'pipe')]);

    expect(await outcome(run(createEditTool(pi, cwd, diffService()), cwd, { file_path: 'pipe', old_string: 'a', new_string: 'b' }))).toEqual({ error: notARegularFile('pipe') });
    expect(files.reads).toEqual([]);
  });
});

/** The call's outcome, or that it was still waiting after two seconds, as a blocked open waits for a peer that never comes. */
function within2s(promise: Promise<unknown>): Promise<unknown> {
  return Promise.race([outcome(promise), new Promise((resolve) => setTimeout(() => resolve('still waiting after 2 s'), 2000))]);
}

/** Lets a read open that waits on the FIFO at `fifo` go on, so a failing run leaves no thread blocked. */
function releaseFifo(fifo: string): void {
  try {
    fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
  } catch (err) {
    // ENXIO: nothing waits on it
    if ((err as NodeJS.ErrnoException).code !== 'ENXIO') throw err;
  }
}

describe('Edit reads and writes only through checked handles', () => {
  it.runIf(process.platform !== 'win32').each([
    ['a single edit', {}],
    ['replace_all', { replace_all: true }],
  ])('refuses %s of a FIFO swapped in after the tool\'s stat, without waiting for a writer', async (_label, extra) => {
    const cwd = tempDir();
    const file = path.join(cwd, 'swapped');
    fs.writeFileSync(file, 'never read');
    files.afterStat = (target) => {
      if (target !== file) return;
      files.afterStat = undefined;
      fs.rmSync(file);
      execFileSync('mkfifo', [file]);
    };

    try {
      expect(await within2s(run(createEditTool(pi, cwd, diffService()), cwd, { file_path: 'swapped', old_string: 'never', new_string: 'x', ...extra }))).toEqual({ error: notARegularFile(file) });
    } finally {
      releaseFifo(file);
    }
  });

  it.each([
    ['a single edit', {}],
    ['replace_all', { replace_all: true }],
  ])('refuses %s of a file over the editor\'s hard limit, naming its size, without reading it', async (_label, extra) => {
    const cwd = tempDir();
    const file = path.join(cwd, 'huge.txt');
    fs.writeFileSync(file, 'a');
    fs.truncateSync(file, EDITOR_HARD_MAX_DOCUMENT_BYTES + 1);

    const result = await outcome(run(createEditTool(pi, cwd, diffService()), cwd, { file_path: 'huge.txt', old_string: 'a', new_string: 'b', ...extra }));

    expect(result).toEqual({ error: editTooLarge(file, EDITOR_HARD_MAX_DOCUMENT_BYTES + 1) });
    expect(result).toEqual({ error: `Could not edit file: ${file}. It is 67108865 bytes, over the 67108864-byte limit of the Edit tool.` });
    expect(fs.statSync(file).size).toBe(EDITOR_HARD_MAX_DOCUMENT_BYTES + 1);
  });
});
