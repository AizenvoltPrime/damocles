import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAgentLoop, type AgentEvent, type AgentTool } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { initPiLoader, type PiCodingAgentModule } from '../../pi-loader';
import { createEditTool } from '../edit-tool';
import { createReadTool } from '../read-tool';
import { createWriteTool } from '../write-tool';

/** Set to make the next diff computation fail, as a diff bug would. */
const diffFails = vi.hoisted(() => ({ on: false }));

vi.mock('../edit-diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../edit-diff')>();
  return {
    ...actual,
    generateEditDiff: (...args: Parameters<typeof actual.generateEditDiff>) => {
      if (diffFails.on) throw new Error('diff failed');
      return actual.generateEditDiff(...args);
    },
  };
});

let pi: PiCodingAgentModule;
const dirs: string[] = [];

beforeAll(async () => {
  pi = (await initPiLoader())!;
});

afterEach(() => {
  diffFails.on = false;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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
    expect(createEditTool(pi, tempDir()).executionMode).toBe('sequential');
    expect(createWriteTool(pi, tempDir()).executionMode).toBe('sequential');
  });

  it('[Edit F, read F] in one batch reads the edited file, the read starting after the edit ended', async () => {
    const cwd = tempDir();
    const file = path.join(cwd, 'f.txt');
    fs.writeFileSync(file, `${'line\n'.repeat(600)}last\n`);

    const events = await runBatch([createEditTool(pi, cwd), createReadTool(pi, cwd)], cwd, [
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

    const mine = await outcome(run(createEditTool(pi, ours), ours, { file_path: 'f.txt', old_string: 'foo', new_string: 'bar', replace_all: true } satisfies EditParams));
    const pis = await outcome(run(pi.createEditToolDefinition(theirs) as unknown as ToolDefinition, theirs, {
      path: 'f.txt',
      edits: [{ oldText: whole, newText: whole.split('foo').join('bar') }],
    }));

    expect(fs.readFileSync(path.join(ours, 'f.txt'))).toEqual(fs.readFileSync(path.join(theirs, 'f.txt')));
    expect(mine).toEqual(pis);
  });

  it.each([
    ['a lone CR', 'foo a\rfoo b\nfoo c\n', 'bar', 'bar a\rbar b\nbar c\n'],
    ['mixed CRLF and LF', 'foo a\r\nfoo b\nkeep\r\nfoo c\n', 'bar', 'bar a\r\nbar b\nkeep\r\nbar c\n'],
    ['a multi-line replacement in mixed text', 'foo a\r\nfoo b\nfoo c\r\n', 'x\ny', 'x\r\ny a\r\nx\ny b\nx\r\ny c\r\n'],
  ])('keeps each untouched line ending, writing the bytes and diff of pi\'s edit of each occurrence, for %s', async (_label, content, newString, expected) => {
    const ours = tempDir();
    const theirs = tempDir();
    fs.writeFileSync(path.join(ours, 'f.txt'), content);
    fs.writeFileSync(path.join(theirs, 'f.txt'), content);
    const lines = content.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.startsWith('foo'));

    const mine = (await run(createEditTool(pi, ours), ours, { file_path: 'f.txt', old_string: 'foo', new_string: newString, replace_all: true } satisfies EditParams)) as { content: unknown; details: unknown };
    const pis = (await run(pi.createEditToolDefinition(theirs) as unknown as ToolDefinition, theirs, {
      path: 'f.txt',
      edits: lines.map((line) => ({ oldText: line, newText: line.replace('foo', newString) })),
    })) as { details: unknown };

    expect(fs.readFileSync(path.join(ours, 'f.txt'), 'utf-8')).toBe(expected);
    expect(fs.readFileSync(path.join(theirs, 'f.txt'), 'utf-8')).toBe(expected);
    expect(mine.details).toEqual(pis.details);
    expect(mine.content).toEqual([{ type: 'text', text: 'Successfully replaced 1 block(s) in f.txt.' }]);
  });

  // pi 1.5.2 `test/edit-tool-diff-before-write.test.ts:14`.
  it('computes its diff before writing, so a failed diff leaves the file unchanged', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'foo a\nfoo b\n');
    diffFails.on = true;

    await expect(run(createEditTool(pi, cwd), cwd, { file_path: 'f.txt', old_string: 'foo', new_string: 'bar', replace_all: true })).rejects.toThrow('diff failed');
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf-8')).toBe('foo a\nfoo b\n');
  });

  it('diffs only around its replacements, numbering lines as the whole-file diff does', async () => {
    const cwd = tempDir();
    const filler = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    fs.writeFileSync(path.join(cwd, 'f.txt'), ['foo top', ...filler, 'foo bottom', ...filler].join('\r\n'));

    const result = (await run(createEditTool(pi, cwd), cwd, { file_path: 'f.txt', old_string: 'foo', new_string: 'bar', replace_all: true })) as { details: { diff: string; firstChangedLine: number } };

    expect(result.details.diff.split('\n').filter((line) => /^[+-]/.test(line))).toEqual(['-  1 foo top', '+  1 bar top', '-202 foo bottom', '+202 bar bottom']);
    expect(result.details.firstChangedLine).toBe(1);
  });

  it('says so when old_string is absent, and leaves the file', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'f.txt'), 'nothing here\n');

    await expect(run(createEditTool(pi, cwd), cwd, { file_path: 'f.txt', old_string: 'foo', new_string: 'bar', replace_all: true })).rejects.toThrow('String to replace not found in file: f.txt');
    expect(fs.readFileSync(path.join(cwd, 'f.txt'), 'utf-8')).toBe('nothing here\n');
  });

  it('fails as pi\'s edit does on a missing file and on a replacement that changes nothing', async () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'same.txt'), 'foo\n');

    const missing = await outcome(run(createEditTool(pi, cwd), cwd, { file_path: 'missing.txt', old_string: 'a', new_string: 'b', replace_all: true }));
    const pisMissing = await outcome(run(pi.createEditToolDefinition(cwd) as unknown as ToolDefinition, cwd, { path: 'missing.txt', edits: [{ oldText: 'a', newText: 'b' }] }));
    const same = await outcome(run(createEditTool(pi, cwd), cwd, { file_path: 'same.txt', old_string: 'foo', new_string: 'foo', replace_all: true }));
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
    const editing = run(createEditTool(pi, cwd), cwd, { file_path: 'f.txt', old_string: 'foo', new_string: 'bar', replace_all: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await writing;
    await editing;

    expect(fs.readFileSync(file, 'utf-8')).toBe('bar one\nbar two\n');
  });

  it('refuses an empty old_string, which cannot create a file', async () => {
    const cwd = tempDir();
    await expect(run(createEditTool(pi, cwd), cwd, { file_path: 'f.txt', old_string: '', new_string: 'x' })).rejects.toThrow('Use the Write tool');
  });
});
