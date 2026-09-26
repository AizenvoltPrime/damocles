import { describe, it, expect, vi, beforeEach } from 'vitest';

const shiki = vi.hoisted(() => {
  const instance = { loadLanguage: vi.fn(async () => undefined), loadTheme: vi.fn(async () => undefined) };
  return { instance, createHighlighter: vi.fn(async () => instance) };
});

vi.mock('shiki', () => ({
  createHighlighter: shiki.createHighlighter,
  bundledLanguages: { typescript: {}, python: {} },
}));
const spans = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('@/utils/perf', () => ({
  perfSpan: (label: string) => ({ end: (fields?: Record<string, unknown>) => void spans.push({ label, ...fields }) }),
  resourceFields: (names: string[]) => ({ fields: Object.fromEntries(names.map((n) => [n, 'fetched'])), lastEnd: 0 }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function freshModule() {
  vi.resetModules();
  return import('../useShikiHighlighter');
}

beforeEach(() => {
  vi.clearAllMocks();
  spans.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('getHighlighter', () => {
  it('starts with only the requested theme and loads only the requested language', async () => {
    const { getHighlighter } = await freshModule();

    await getHighlighter('ts', 'github-dark');

    expect(shiki.createHighlighter).toHaveBeenCalledWith({ themes: ['github-dark'], langs: [] });
    expect(shiki.instance.loadLanguage.mock.calls).toEqual([['typescript']]);
    expect(shiki.instance.loadTheme).not.toHaveBeenCalled();
  });

  it('loads a new theme once, however many callers ask for it at the same time', async () => {
    const { getHighlighter } = await freshModule();
    await getHighlighter('ts', 'github-dark');

    await Promise.all([getHighlighter('ts', 'github-light'), getHighlighter('python', 'github-light')]);
    await getHighlighter('python', 'github-light');

    expect(shiki.instance.loadTheme.mock.calls).toEqual([['github-light']]);
    expect(shiki.instance.loadLanguage.mock.calls).toEqual([['typescript'], ['python']]);
    expect(shiki.createHighlighter).toHaveBeenCalledTimes(1);
  });

  it('never loads a grammar for plain text', async () => {
    const { getHighlighter } = await freshModule();

    await getHighlighter(undefined, 'nord');

    expect(shiki.instance.loadLanguage).not.toHaveBeenCalled();
  });

  it('loads a grammar once when two blocks ask for it before it arrives', async () => {
    const { getHighlighter } = await freshModule();
    await getHighlighter(undefined, 'github-dark');
    const grammar = deferred<undefined>();
    shiki.instance.loadLanguage.mockImplementationOnce(() => grammar.promise);

    const both = Promise.all([getHighlighter('python', 'github-dark'), getHighlighter('py', 'github-dark')]);
    grammar.resolve(undefined);
    await both;

    expect(shiki.instance.loadLanguage.mock.calls).toEqual([['python']]);
  });

  it('retries a grammar whose load failed', async () => {
    const { getHighlighter, isHighlighterReady } = await freshModule();
    shiki.instance.loadLanguage.mockRejectedValueOnce(new Error('chunk fetch failed'));

    await expect(getHighlighter('python', 'github-dark')).rejects.toThrow('chunk fetch failed');
    expect(isHighlighterReady('python', 'github-dark')).toBe(false);

    await getHighlighter('python', 'github-dark');

    expect(shiki.instance.loadLanguage.mock.calls).toEqual([['python'], ['python']]);
    expect(isHighlighterReady('python', 'github-dark')).toBe(true);
  });

  it('creates the highlighter again after startup failed', async () => {
    const { getHighlighter, isHighlighterReady } = await freshModule();
    shiki.createHighlighter.mockRejectedValueOnce(new Error('chunk fetch failed'));

    await expect(getHighlighter('ts', 'github-dark')).rejects.toThrow('chunk fetch failed');
    expect(isHighlighterReady('txt', 'github-dark')).toBe(false);

    await getHighlighter('ts', 'github-dark');

    expect(shiki.createHighlighter).toHaveBeenCalledTimes(2);
    expect(isHighlighterReady('ts', 'github-dark')).toBe(true);
  });
});

describe('isHighlighterReady', () => {
  it('is false until the highlighter exists with both the grammar and the theme', async () => {
    const { getHighlighter, isHighlighterReady } = await freshModule();
    const created = deferred<typeof shiki.instance>();
    shiki.createHighlighter.mockImplementationOnce(() => created.promise);

    const first = getHighlighter('ts', 'github-dark');
    expect(isHighlighterReady('txt', 'github-dark')).toBe(false);
    created.resolve(shiki.instance);
    await first;

    expect(isHighlighterReady('txt', 'github-dark')).toBe(true);
    expect(isHighlighterReady('ts', 'github-dark')).toBe(true);
    expect(isHighlighterReady('ts', 'github-light')).toBe(false);
    expect(isHighlighterReady('python', 'github-dark')).toBe(false);
  });
});

describe('shiki.firstHighlight span', () => {
  it('ends once, on the first highlight', async () => {
    const { getHighlighter } = await freshModule();

    await getHighlighter('ts', 'github-dark');
    await getHighlighter('python', 'github-dark');

    expect(spans).toEqual([{
      label: 'shiki.firstHighlight', lang: 'typescript', theme: 'github-dark',
      init: expect.any(Number), 'typescript.js': 'fetched', 'github-dark.js': 'fetched',
    }]);
  });

  it('ends as failed when the first highlight fails', async () => {
    const { getHighlighter } = await freshModule();
    shiki.instance.loadLanguage.mockRejectedValueOnce(new Error('chunk fetch failed'));

    await expect(getHighlighter('python', 'github-dark')).rejects.toThrow();

    expect(spans).toEqual([{ label: 'shiki.firstHighlight', lang: 'python', theme: 'github-dark', failed: true }]);
  });
});
