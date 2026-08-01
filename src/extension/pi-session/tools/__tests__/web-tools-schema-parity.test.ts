import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-loader';
import { toolCategory } from '../../tool-normalization';

/**
 * Schema parity + routing for the native web tools (Phase 7, US-028.3): the five PascalCase tools
 * register with the expected param keys, classify as read-only, route `execute` to the mocked
 * exa/extract layer, and return a structured error result instead of throwing on failure.
 */

vi.mock('../../web-access/exa', () => ({
  webSearchExa: vi.fn(),
  codeSearchExa: vi.fn(),
  EXA_CATEGORIES: [
    'company',
    'research paper',
    'news',
    'pdf',
    'github',
    'personal site',
    'people',
    'financial report',
  ],
}));
vi.mock('../../web-access/extract', () => ({
  extractUrl: vi.fn(),
  extractUrls: vi.fn(),
  clampBudget: (n: number) => Math.min(30_000, Math.max(1000, Math.floor(n))),
  MIN_CHAR_BUDGET: 1000,
  SINGLE_URL_BUDGET: 30_000,
}));
vi.mock('../../web-access/feed', () => ({
  fetchFeed: vi.fn(),
}));
vi.mock('../../web-access/youtube', () => ({
  parseVideoId: vi.fn(),
  fetchTranscript: vi.fn(),
}));

import { buildWebPiTools } from '../../web-access/web-tools';
import { WEB_PI_TOOL_NAMES } from '../../web-access/web-tool-specs';
import { webSearchExa, codeSearchExa } from '../../web-access/exa';
import { extractUrl, extractUrls } from '../../web-access/extract';
import { fetchFeed } from '../../web-access/feed';
import { parseVideoId, fetchTranscript } from '../../web-access/youtube';

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
  vi.mocked(fetchFeed).mockResolvedValue({
    title: 'My Feed',
    items: [
      { title: 'Post One', link: 'https://f/1', published: '2025-01-06T00:00:00.000Z', summary: 'one' },
      { title: 'Post Two', link: 'https://f/2', published: '2025-01-05T00:00:00.000Z', summary: 'two' },
    ],
  });
  vi.mocked(parseVideoId).mockReturnValue('dQw4w9WgXcQ');
  vi.mocked(fetchTranscript).mockResolvedValue({
    videoId: 'dQw4w9WgXcQ',
    title: 'A Video',
    lang: 'en',
    text: 'transcript body line one\nline two',
  });
});

describe('web tools — names + schema', () => {
  it('registers WebSearch / WebFetch / CodeSearch / FeedRead / YouTubeTranscript in order', () => {
    const tools = buildWebPiTools({ pi: piStub }) as unknown as PiTool[];
    expect(tools.map((t) => t.name)).toEqual(['WebSearch', 'WebFetch', 'CodeSearch', 'FeedRead', 'YouTubeTranscript']);
    expect([...WEB_PI_TOOL_NAMES]).toEqual(['WebSearch', 'WebFetch', 'CodeSearch', 'FeedRead', 'YouTubeTranscript']);
  });

  it('exposes the expected param keys per tool', () => {
    const tools = buildTools();
    expect(Object.keys(tools.WebSearch!.parameters.properties ?? {}).sort()).toEqual(
      ['category', 'endPublishedDate', 'excludeDomains', 'includeDomains', 'numResults', 'queries', 'query', 'startPublishedDate'].sort(),
    );
    expect(Object.keys(tools.WebFetch!.parameters.properties ?? {}).sort()).toEqual(
      ['includeImages', 'includeLinks', 'maxChars', 'raw', 'url', 'urls'].sort(),
    );
    expect(Object.keys(tools.CodeSearch!.parameters.properties ?? {}).sort()).toEqual(['maxTokens', 'query']);
    expect(Object.keys(tools.FeedRead!.parameters.properties ?? {}).sort()).toEqual(['limit', 'url']);
    expect(Object.keys(tools.YouTubeTranscript!.parameters.properties ?? {}).sort()).toEqual(['lang', 'url']);
  });

  it('classifies all five as read-only (gate auto-allows them)', () => {
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

  it('WebSearch threads structured filters into webSearchExa and flags advanced routing', async () => {
    const result = await buildTools().WebSearch!.execute('t', {
      query: 'transformers',
      includeDomains: ['arxiv.org'],
      startPublishedDate: '2024-01-01',
      category: 'research paper',
    });
    expect(webSearchExa).toHaveBeenCalledWith(
      'transformers',
      { includeDomains: ['arxiv.org'], startPublishedDate: '2024-01-01', category: 'research paper' },
      undefined,
    );
    expect(result.details?.advanced).toBe(true);
  });

  it('WebSearch category alone does not flag advanced routing', async () => {
    const result = await buildTools().WebSearch!.execute('t', { query: 'llm news', category: 'news' });
    expect(webSearchExa).toHaveBeenCalledWith('llm news', { category: 'news' }, undefined);
    expect(result.details?.advanced).toBeUndefined();
  });

  it('WebFetch routes a single url to extractUrl with an options object', async () => {
    const result = await buildTools().WebFetch!.execute('t', { url: 'https://a' });
    expect(extractUrl).toHaveBeenCalledWith('https://a', undefined, {});
    expect(extractUrls).not.toHaveBeenCalled();
    expect(result.details?.successful).toBe(1);
    expect(result.content[0]?.text).toContain('fetch-md');
  });

  it('WebFetch routes multiple urls to extractUrls with an options object', async () => {
    const result = await buildTools().WebFetch!.execute('t', { urls: ['https://a', 'https://b'] });
    expect(extractUrls).toHaveBeenCalledWith(['https://a', 'https://b'], undefined, {});
    expect(result.details?.urlCount).toBe(2);
    expect(result.details?.successful).toBe(2);
  });

  it('WebFetch threads output-control options into extractUrl and reflects them in details', async () => {
    const result = await buildTools().WebFetch!.execute('t', {
      url: 'https://a',
      raw: true,
      maxChars: 5000,
      includeLinks: false,
      includeImages: false,
    });
    expect(extractUrl).toHaveBeenCalledWith('https://a', undefined, {
      raw: true,
      budget: 5000,
      includeLinks: false,
      includeImages: false,
    });
    expect(result.details?.raw).toBe(true);
    expect(result.details?.maxChars).toBe(5000);
    expect(result.details?.includeLinks).toBe(false);
    expect(result.details?.includeImages).toBe(false);
  });

  it('WebFetch echoes the effective (clamped) maxChars, not the raw request', async () => {
    const tooSmall = await buildTools().WebFetch!.execute('t', { url: 'https://a', maxChars: 10 });
    expect(tooSmall.details?.maxChars).toBe(1000); // floored
    const tooBig = await buildTools().WebFetch!.execute('t', { url: 'https://a', maxChars: 999_999 });
    expect(tooBig.details?.maxChars).toBe(30_000); // ceiled to SINGLE_URL_BUDGET
  });

  it('WebFetch caps fan-out at 20 urls and notes the drop', async () => {
    const urls = Array.from({ length: 25 }, (_, i) => `https://a/${i}`);
    const result = await buildTools().WebFetch!.execute('t', { urls });
    const passed = vi.mocked(extractUrls).mock.calls.at(-1)![0];
    expect(passed).toHaveLength(20);
    expect(result.details?.urlCount).toBe(20);
    expect(result.content[0]?.text).toMatch(/only the first 20 were fetched/i);
  });

  it('WebSearch surfaces the degraded note in the model-visible text, not just details', async () => {
    vi.mocked(webSearchExa).mockResolvedValueOnce({
      markdown: 'unfiltered-results',
      resultCount: 2,
      degraded: true,
      note: 'Advanced search unavailable; domain/date filters were dropped and the query ran without them.',
    });
    const result = await buildTools().WebSearch!.execute('t', {
      query: 'transformers',
      includeDomains: ['arxiv.org'],
    });
    expect(result.details?.degraded).toBe(true);
    expect(result.content[0]?.text).toMatch(/filters were dropped/i);
    expect(result.content[0]?.text).toContain('unfiltered-results');
  });

  it('CodeSearch routes to codeSearchExa and reports the mode', async () => {
    const result = await buildTools().CodeSearch!.execute('t', { query: 'debounce' });
    expect(codeSearchExa).toHaveBeenCalled();
    expect(result.content[0]?.text).toBe('code-md');
    expect(result.details?.mode).toBe('code-context');
  });

  it('FeedRead routes to fetchFeed and renders items as markdown', async () => {
    const result = await buildTools().FeedRead!.execute('t', { url: 'https://f/rss', limit: 5 });
    expect(fetchFeed).toHaveBeenCalledWith('https://f/rss', undefined, 5);
    expect(result.content[0]?.text).toContain('My Feed');
    expect(result.content[0]?.text).toContain('[Post One](https://f/1)');
    expect(result.details?.itemCount).toBe(2);
  });

  it('YouTubeTranscript parses the id, routes to fetchTranscript, and returns plain-text', async () => {
    const result = await buildTools().YouTubeTranscript!.execute('t', { url: 'https://youtu.be/dQw4w9WgXcQ' });
    expect(parseVideoId).toHaveBeenCalledWith('https://youtu.be/dQw4w9WgXcQ');
    expect(fetchTranscript).toHaveBeenCalledWith('dQw4w9WgXcQ', undefined, undefined);
    expect(result.content[0]?.text).toContain('transcript body line one');
    expect(result.details?.videoId).toBe('dQw4w9WgXcQ');
    expect(result.details?.chars).toBeGreaterThan(0);
  });

  it('YouTubeTranscript fails soft with a clear message on an unparseable id', async () => {
    vi.mocked(parseVideoId).mockReturnValueOnce(null);
    vi.mocked(fetchTranscript).mockClear();
    const result = await buildTools().YouTubeTranscript!.execute('t', { url: 'not-a-video' });
    expect(fetchTranscript).not.toHaveBeenCalled();
    expect(result.content[0]?.text).toContain('Error');
    expect(result.details?.error).toBeTruthy();
  });

  it('YouTubeTranscript surfaces a fetchTranscript diagnostic without throwing', async () => {
    vi.mocked(fetchTranscript).mockResolvedValueOnce({ videoId: 'dQw4w9WgXcQ', text: '', error: 'no captions available for this video' });
    const result = await buildTools().YouTubeTranscript!.execute('t', { url: 'https://youtu.be/dQw4w9WgXcQ' });
    expect(result.content[0]?.text).toContain('no captions available');
    expect(result.details?.error).toMatch(/no captions/i);
  });
});

describe('web tools — fail-soft', () => {
  it('returns a structured error result instead of throwing when CodeSearch fails', async () => {
    vi.mocked(codeSearchExa).mockRejectedValueOnce(new Error('exa down'));
    const result = await buildTools().CodeSearch!.execute('t', { query: 'x' });
    expect(result.content[0]?.text).toContain('exa down');
    expect(result.details?.error).toBe('exa down');
  });

  it('returns a structured error result instead of throwing when FeedRead fails', async () => {
    vi.mocked(fetchFeed).mockRejectedValueOnce(new Error('feed boom'));
    const result = await buildTools().FeedRead!.execute('t', { url: 'https://f/rss' });
    expect(result.content[0]?.text).toContain('feed boom');
    expect(result.details?.error).toBe('feed boom');
  });

  it('rejects empty input without calling the backend', async () => {
    const search = await buildTools().WebSearch!.execute('t', {});
    expect(search.content[0]?.text).toContain('Error');
    const fetch = await buildTools().WebFetch!.execute('t', {});
    expect(fetch.content[0]?.text).toContain('Error');
  });
});
