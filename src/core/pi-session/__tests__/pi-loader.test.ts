import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const logLines: string[] = [];

/** A fresh loader module each time, so its module-level cache starts empty; the fresh logger gets the sink. */
async function freshLoader(): Promise<typeof import('../pi-loader')> {
  vi.resetModules();
  const { installLogSink } = await import('../../logger');
  installLogSink({ appendLine: (line: string) => void logLines.push(line), show: () => {}, dispose: () => {} });
  return import('../pi-loader');
}

describe('loadPiAi', () => {
  beforeEach(() => {
    logLines.length = 0;
  });
  afterEach(() => {
    vi.doUnmock('@earendil-works/pi-ai');
    vi.unstubAllGlobals();
  });

  it('loads pi-ai once and shares it', async () => {
    const loader = await freshLoader();
    const first = await loader.loadPiAi();
    expect(first?.clampThinkingLevel).toBeTypeOf('function');
    expect(await loader.loadPiAi()).toBe(first);
    expect(loader.loadedPiAi()).toBe(first);
  });

  it('is loaded once pi is, so a synchronous clamp after pi starts always has it', async () => {
    vi.doMock('@earendil-works/pi-coding-agent', () => ({ VERSION: 'test' }));
    const loader = await freshLoader();
    expect(await loader.initPiLoader()).not.toBeNull();
    expect(loader.loadedPiAi()?.clampThinkingLevel).toBeTypeOf('function');
    vi.doUnmock('@earendil-works/pi-coding-agent');
  });

  // Node keeps a module whose evaluation threw in its errored state, so a second import only throws again.
  it('remembers a failed import, so later calls neither import again nor log again', async () => {
    let imports = 0;
    vi.doMock('@earendil-works/pi-ai', () => {
      imports++;
      throw new Error('pi-ai failed to evaluate');
    });
    const loader = await freshLoader();

    expect(await loader.loadPiAi()).toBeNull();
    expect(await loader.loadPiAi()).toBeNull();
    expect(await loader.loadPiAi()).toBeNull();

    expect(imports).toBe(1);
    expect(logLines.filter((line) => line.includes('Failed to load pi-ai'))).toHaveLength(1);
  });

  it('never imports pi-ai on a Node older than pi supports, and logs that once', async () => {
    let imports = 0;
    vi.doMock('@earendil-works/pi-ai', () => {
      imports++;
      return {};
    });
    const loader = await freshLoader();
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, node: '20.11.0' } });

    const results = [await loader.loadPiAi(), await loader.loadPiAi()];

    expect(imports).toBe(0);
    expect(results.every((result) => result === null)).toBe(true);
    expect(logLines.filter((line) => line.includes('pi-ai unavailable'))).toHaveLength(1);
  });
});
