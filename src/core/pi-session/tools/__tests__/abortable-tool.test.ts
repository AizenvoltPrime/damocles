import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }));
vi.mock('../../../logger', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../logger')>()), log: logSpy }));

import { abortableTool } from '../abortable-tool';

type Result = { content: Array<{ type: string; text: string }> };

/** A tool whose body settles only when the test says so, like a hung CDP or MCP call. */
function pendingTool(): { tool: ToolDefinition; resolve: (value: Result) => void; reject: (err: Error) => void } {
  let resolve!: (value: Result) => void;
  let reject!: (err: Error) => void;
  const work = new Promise<Result>((res, rej) => { resolve = res; reject = rej; });
  const tool = { name: 'BrowserClick', execute: () => work } as unknown as ToolDefinition;
  return { tool, resolve, reject };
}

const run = (tool: ToolDefinition, signal: AbortSignal): Promise<Result> =>
  abortableTool(tool).execute('t1', {}, signal, undefined, undefined as never) as unknown as Promise<Result>;

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => logSpy.mockClear());

describe('abortableTool', () => {
  it('answers an already-aborted call at once and logs, by error name only, a body that fails later', async () => {
    const { tool, reject } = pendingTool();
    const controller = new AbortController();
    controller.abort();

    expect(await run(tool, controller.signal)).toEqual({ content: [{ type: 'text', text: 'BrowserClick aborted' }], details: undefined });
    reject(new TypeError('page said: secret text'));
    await settle();

    expect(logSpy).toHaveBeenCalledWith(expect.any(String), 'BrowserClick', 'TypeError');
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain('secret text');
  });

  it('removes its abort listener once the body settles', async () => {
    const { tool, resolve } = pendingTool();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');

    const pending = run(tool, controller.signal);
    resolve({ content: [{ type: 'text', text: 'clicked' }] });
    expect(await pending).toEqual({ content: [{ type: 'text', text: 'clicked' }] });

    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
  });

  it('answers an abort mid-call at once and logs a body that rejects afterwards', async () => {
    const { tool, reject } = pendingTool();
    const controller = new AbortController();

    const pending = run(tool, controller.signal);
    controller.abort();
    expect((await pending).content[0]?.text).toBe('BrowserClick aborted');
    reject(new Error('target closed'));
    await settle();

    expect(logSpy).toHaveBeenCalledWith(expect.any(String), 'BrowserClick', 'Error');
  });

  it('still rejects with the body\'s error when the turn was not aborted', async () => {
    const { tool, reject } = pendingTool();
    const pending = run(tool, new AbortController().signal);
    reject(new Error('selector not found'));
    await expect(pending).rejects.toThrow('selector not found');
    expect(logSpy).not.toHaveBeenCalled();
  });
});
