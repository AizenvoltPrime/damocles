import { describe, expect, it } from 'vitest';
import type { RemoteHost } from '../../../../platform/remote-host';
import type { PanelHost } from '../../../../platform/window-service';
import { relayedBrowserTools } from '../browser-relay';
import { buildBrowserPiTools, BROWSER_PI_TOOL_NAMES } from '../browser-tools';
import { createBrowserRequestInputTool } from '../browser-request-input-tool';

interface ToolLike {
  name: string;
  executionMode?: string;
  execute: (id: string, input: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

const pi = { defineTool: (c: unknown) => c };
// No page and no controller: the browser was never opened.
const closedScope = { getController: () => null, getCurrentPage: () => undefined, getCurrentUrl: () => 'about:blank', takeUnreportedDialogs: () => [] };

function localTools(): ToolLike[] {
  return [
    ...(buildBrowserPiTools({ pi, scope: closedScope } as never) as unknown as ToolLike[]),
    createBrowserRequestInputTool(pi as never, closedScope as never, {} as never) as unknown as ToolLike,
  ];
}

const modes = (tools: readonly ToolLike[]): Record<string, string | undefined> => Object.fromEntries(tools.map((t) => [t.name, t.executionMode]));
const allSequential = Object.fromEntries(BROWSER_PI_TOOL_NAMES.map((name) => [name, 'sequential']));

describe('browser tools run one at a time, in the order the model wrote them', () => {
  it('marks every local browser tool sequential', () => {
    expect(modes(localTools())).toEqual(allSequential);
  });

  it('keeps the mode on every tool a remote chat relays', () => {
    const relayed = relayedBrowserTools(localTools() as never, {} as RemoteHost, {} as PanelHost, 'chat') as unknown as ToolLike[];
    expect(modes(relayed)).toEqual(allSequential);
  });
});

describe('a browser tool called before BrowserOpen', () => {
  const textOf = async (run: Promise<{ content: Array<{ type: string; text?: string }> }>): Promise<string> => {
    const result = await run.catch((err: unknown) => ({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] }));
    return result.content.map((c) => c.text ?? '').join('\n');
  };
  const tool = (name: string): ToolLike => localTools().find((t) => t.name === name)!;

  it.each(['BrowserScreenshot', 'BrowserUpload'])('%s names the tool the model can call', async (name) => {
    const text = await textOf(tool(name).execute('t', name === 'BrowserUpload' ? { selector: 'input', paths: ['/tmp/a.txt'] } : {}));
    expect(text).toContain('Browser is not connected. Use BrowserOpen first.');
    expect(text).not.toContain('browser_open');
  });
});
