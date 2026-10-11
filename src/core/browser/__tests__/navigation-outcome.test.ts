import { describe, expect, it, vi } from 'vitest';
import { buildBrowserPiTools } from '../../pi-session/tools/browser-tools';

interface ToolLike {
  name: string;
  execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

// A controller whose page settles at once and whose screenshot succeeds.
const controller = {
  getPage: () => ({ waitForLoadState: async () => {}, evaluate: async () => undefined, isClosed: () => false }),
  captureScreenshot: async () => 'IMG',
};

function tools(open: () => Promise<number | undefined>): Map<string, ToolLike> {
  const scope = { open: vi.fn(open), openNewTab: vi.fn(open), waitForController: async () => false, getController: () => controller, takeUnreportedDialogs: () => [] };
  const built = buildBrowserPiTools({ pi: { defineTool: (c: unknown) => c }, scope } as never) as unknown as ToolLike[];
  return new Map(built.map((tool) => [tool.name, tool]));
}

const textOf = (res: { content: Array<{ type: string; text?: string }> }): string => res.content.map((c) => c.text ?? '').join('\n');

describe('an agent navigation follows page.goto: a failed load is an error, an HTTP error status is a loaded page', () => {
  it.each(['BrowserOpen', 'BrowserNavigate'])('%s returns an error result when the page did not load', async (name) => {
    const result = await tools(async () => { throw new Error('Navigation to http://127.0.0.1:1 failed: net::ERR_CONNECTION_REFUSED'); }).get(name)!.execute('t', { url: 'http://127.0.0.1:1/' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('net::ERR_CONNECTION_REFUSED');
  });

  it.each(['BrowserOpen', 'BrowserNavigate'])('%s succeeds on an HTTP 404 and names the status', async (name) => {
    const result = await tools(async () => 404).get(name)!.execute('t', { url: 'http://a.test/missing' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('http://a.test/missing (HTTP 404)');
  });

  it.each(['BrowserOpen', 'BrowserNavigate'])('%s names no status for a page that loaded with HTTP 200', async (name) => {
    const result = await tools(async () => 200).get(name)!.execute('t', { url: 'http://a.test/' });
    expect(textOf(result)).not.toContain('(HTTP');
  });

  it('BrowserTabs names the HTTP error status of a new tab\'s page', async () => {
    const result = await tools(async () => 404).get('BrowserTabs')!.execute('t', { action: 'new', url: 'http://a.test/missing' });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Opened new tab: http://a.test/missing (HTTP 404)');
  });
});
