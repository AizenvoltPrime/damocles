import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-loader';
import { toolCategory } from '../../tool-normalization';

/**
 * Schema parity + routing for the native web tools (Phase 7, US-028.3): the three PascalCase tools
 * register with the expected param keys, classify as read-only, route `execute` to the mocked
 * exa/extract layer, and return a structured error result instead of throwing on failure.
 */

vi.mock('../../web-access/exa', () => ({
  webSearchExa: vi.fn(),
  codeSearchExa: vi.fn(),
}));
vi.mock('../../web-access/extract', () => ({
  extractUrl: vi.fn(),
  extractUrls: vi.fn(),
}));

import { buildWebPiTools, WEB_PI_TOOL_NAMES } from '../../web-access/web-tools';
import { webSearchExa, codeSearchExa } from '../../web-access/exa';
import { extractUrl, extractUrls } from '../../web-access/extract';

const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

interface PiTool {
  name: string;
  label: string;
  parameters: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }>;
}

function buildTools(): Record<string, PiTool> {
  const tools = buildWebPiTools({ pi: piStub }) as unknown as PiTool[];
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

beforeEach(() => {
  vi.mocked(webSearchExa).mockResolvedValue({ markdown: 'search-md', resultCount: 3 });
  vi.mocked(codeSearchExa).mockResolvedValue({ markdown: 'code-md', mode: 'code-context' });
  vi.mocked(extractUrl).mockResolvedValue({ url: 'https://a', title: 'A', markdown: 'fetch-md', error: null, truncated: false });
  vi.mocked(extractUrls).mockResolvedValue([
    { url: 'https://a', title: 'A', markdown: 'a-md', error: null, truncated: false },
    { url: 'https://b', title: 'B', markdown: 'b-md', error: null, truncated: false },
  ]);
});

describe('web tools — names + schema', () => {
  it('registers WebSearch / WebFetch / CodeSearch in order', () => {
    const tools = buildWebPiTools({ pi: piStub }) as unknown as PiTool[];
    expect(tools.map((t) => t.name)).toEqual(['WebSearch', 'WebFetch', 'CodeSearch']);
    expect([...WEB_PI_TOOL_NAMES]).toEqual(['WebSearch', 'WebFetch', 'CodeSearch']);
  });

  it('exposes the expected param keys per tool', () => {
    const tools = buildTools();
    expect(Object.keys(tools.WebSearch!.parameters.properties ?? {}).sort()).toEqual(['numResults', 'queries', 'query']);
    expect(Object.keys(tools.WebFetch!.parameters.properties ?? {}).sort()).toEqual(['url', 'urls']);
    expect(Object.keys(tools.CodeSearch!.parameters.properties ?? {}).sort()).toEqual(['maxTokens', 'query']);
  });

  it('classifies all three as read-only (gate auto-allows them)', () => {
    for (const name of WEB_PI_TOOL_NAMES) {
      expect(toolCategory(name)).toBe('read');
    }
  });
});

describe('web tools — execute routing', () => {
  it('WebSearch routes to webSearchExa and returns its markdown', async () => {
    const result = await buildTools().WebSearch!.execute('t', { query: 'vscode' });
    expect(webSearchExa).toHaveBeenCalled();
    expect(result.content[0]?.text).toBe('search-md');
    expect(result.details?.totalResults).toBe(3);
  });

  it('WebFetch routes a single url to extractUrl', async () => {
    const result = await buildTools().WebFetch!.execute('t', { url: 'https://a' });
    expect(extractUrl).toHaveBeenCalledWith('https://a', undefined);
    expect(extractUrls).not.toHaveBeenCalled();
    expect(result.details?.successful).toBe(1);
    expect(result.content[0]?.text).toContain('fetch-md');
  });

  it('WebFetch routes multiple urls to extractUrls', async () => {
    const result = await buildTools().WebFetch!.execute('t', { urls: ['https://a', 'https://b'] });
    expect(extractUrls).toHaveBeenCalledWith(['https://a', 'https://b'], undefined);
    expect(result.details?.urlCount).toBe(2);
    expect(result.details?.successful).toBe(2);
  });

  it('CodeSearch routes to codeSearchExa and reports the mode', async () => {
    const result = await buildTools().CodeSearch!.execute('t', { query: 'debounce' });
    expect(codeSearchExa).toHaveBeenCalled();
    expect(result.content[0]?.text).toBe('code-md');
    expect(result.details?.mode).toBe('code-context');
  });
});

describe('web tools — fail-soft', () => {
  it('returns a structured error result instead of throwing when CodeSearch fails', async () => {
    vi.mocked(codeSearchExa).mockRejectedValueOnce(new Error('exa down'));
    const result = await buildTools().CodeSearch!.execute('t', { query: 'x' });
    expect(result.content[0]?.text).toContain('exa down');
    expect(result.details?.error).toBe('exa down');
  });

  it('rejects empty input without calling the backend', async () => {
    const search = await buildTools().WebSearch!.execute('t', {});
    expect(search.content[0]?.text).toContain('Error');
    const fetch = await buildTools().WebFetch!.execute('t', {});
    expect(fetch.content[0]?.text).toContain('Error');
  });
});
