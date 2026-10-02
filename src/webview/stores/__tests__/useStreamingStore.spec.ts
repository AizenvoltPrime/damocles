import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { watch } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { CANCELLED_TOOL_DETAIL_KEY } from '@shared/types/session';
import type { ContentBlock } from '@shared/types/content';
import { buildMessage, buildUserMessage, useStreamingStore } from '../useStreamingStore';
import { at, defined } from '@/__tests__/helpers';

/**
 * The two caches hold frames that arrived before the call they describe. Each entry holds a whole tool
 * result, so an entry left behind after the call exists in the transcript is a leak the size of that
 * output, and it survives until `$reset`.
 */

beforeEach(() => setActivePinia(createPinia()));

function toolIds(store: ReturnType<typeof useStreamingStore>): string[] {
  return store.messages.flatMap((m) => m.toolCalls ?? []).map((t) => t.id);
}

describe('useStreamingStore.addSteerChip', () => {
  const PNG = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } };

  it('carries the images as contentBlocks so the chip renders them', () => {
    const chip = useStreamingStore().addSteerChip('look', { agentId: 'a1' }, { images: [PNG] });
    expect(chip).toMatchObject({ content: 'look', isInjected: true, contentBlocks: [PNG], steerTarget: { agentId: 'a1' } });
  });

  it('sets no contentBlocks without images', () => {
    expect(useStreamingStore().addSteerChip('look', { agentId: 'a1' }, { images: [] }).contentBlocks).toBeUndefined();
    expect(useStreamingStore().addSteerChip('look', { agentId: 'a1' }).contentBlocks).toBeUndefined();
  });
});

describe('useStreamingStore.updateToolStatus after a final status', () => {
  it('keeps a finished card finished when a live status arrives late', () => {
    const store = useStreamingStore();
    store.addToolCall({ id: 't-1', name: 'Read', input: {} });
    store.updateToolStatus('t-1', 'abandoned');

    store.updateToolStatus('t-1', 'approved');

    expect(defined(defined(at(store.messages, 0).toolCalls, 'toolCalls')[0], 't-1').status).toBe('abandoned');
  });

  it('keeps a cached final status when a live status arrives before the call', () => {
    const store = useStreamingStore();
    store.updateToolStatus('t-1', 'failed', { errorMessage: 'Operation aborted' });

    store.updateToolStatus('t-1', 'running');
    store.addToolCall({ id: 't-1', name: 'Read', input: {} });

    expect(defined(defined(at(store.messages, 0).toolCalls, 'toolCalls')[0], 't-1').status).toBe('failed');
  });
});

describe('useStreamingStore cache pruning', () => {
  it('caches nothing for a call that is already in the transcript', () => {
    const store = useStreamingStore();
    store.addToolCall({ id: 't-1', name: 'Bash', input: { command: 'npm test' } });

    store.updateToolStatus('t-1', 'running');
    store.updateToolStatus('t-1', 'completed', { result: 'a very long tool result' });

    expect(toolIds(store)).toEqual(['t-1']);
    expect(store.toolStatusCache.size).toBe(0);
  });

  it('keeps the cache empty across many completed lifecycles', () => {
    const store = useStreamingStore();
    for (let i = 0; i < 50; i++) {
      store.addToolCall({ id: `t-${i}`, name: 'Bash', input: {} });
      store.updateToolStatus(`t-${i}`, 'running');
      store.updateToolStatus(`t-${i}`, 'completed', { result: 'output'.repeat(100) });
    }

    expect(store.toolStatusCache.size).toBe(0);
  });

  it('still caches a status whose call has not arrived, and hands it over when it does', () => {
    const store = useStreamingStore();

    store.updateToolStatus('t-1', 'completed', { result: 'landed early' });
    expect(store.toolStatusCache.size).toBe(1);

    store.addToolCall({ id: 't-1', name: 'Bash', input: {} });

    const tool = defined(defined(at(store.messages, 0).toolCalls, 'toolCalls')[0], 't-1');
    expect(tool.status).toBe('completed');
    expect(tool.result).toBe('landed early');
    expect(store.toolStatusCache.size).toBe(0);
  });

  it('drops the metadata cache entry once the call is built from a content block', () => {
    const store = useStreamingStore();
    store.updateToolMetadata('t-1', { fullOutputPath: 'c:/tmp/out.txt' });
    expect(store.toolMetadataCache.size).toBe(1);

    store.getOrCreateStreamingMessage('sdk-1');
    const blocks: ContentBlock[] = [{ type: 'tool_use', id: 't-1', name: 'Bash', input: {} }];
    store.updateStreamingMessage({ toolCalls: store.extractToolCalls(blocks) }, 'sdk-1');

    const tool = defined(defined(at(store.messages, 0).toolCalls, 'toolCalls')[0], 't-1');
    expect(defined(tool.metadata, 'metadata')['fullOutputPath']).toBe('c:/tmp/out.txt');
    expect(store.toolMetadataCache.size).toBe(0);
    expect(store.toolStatusCache.size).toBe(0);
  });

  it('drops the metadata cache entry once the call is built by addToolCall', () => {
    const store = useStreamingStore();
    store.updateToolMetadata('t-1', { [CANCELLED_TOOL_DETAIL_KEY]: true });

    store.addToolCall({ id: 't-1', name: 'Bash', input: {} });

    expect(store.toolMetadataCache.size).toBe(0);
  });
});

describe('useStreamingStore imageCount', () => {
  const firstTool = (store: ReturnType<typeof useStreamingStore>) =>
    defined(defined(at(store.messages, 0).toolCalls, 'toolCalls')[0], 'tool');

  it('writes the count with the completed status', () => {
    const store = useStreamingStore();
    store.addToolCall({ id: 't-1', name: 'Read', input: {} });
    store.updateToolStatus('t-1', 'completed', { result: 'Read image file [image/png]', imageCount: 2 });

    expect(firstTool(store).imageCount).toBe(2);
  });

  it('hands a cached count over when addToolCall builds the call', () => {
    const store = useStreamingStore();
    store.updateToolStatus('t-1', 'completed', { result: 'shot', imageCount: 1 });
    store.addToolCall({ id: 't-1', name: 'BrowserScreenshot', input: {} });

    expect(firstTool(store).imageCount).toBe(1);
  });

  it('hands a cached count over when a content block builds the call', () => {
    const store = useStreamingStore();
    store.updateToolStatus('t-1', 'completed', { result: 'shot', imageCount: 1 });
    store.getOrCreateStreamingMessage('sdk-1');
    store.updateStreamingMessage({ toolCalls: store.extractToolCalls([{ type: 'tool_use', id: 't-1', name: 'Read', input: {} }]) }, 'sdk-1');

    expect(firstTool(store).imageCount).toBe(1);
  });

  it('keeps the count when the final assistant message merges a call rebuilt from its content block', () => {
    const store = useStreamingStore();
    store.getOrCreateStreamingMessage('sdk-1');
    store.addToolCall({ id: 't-1', name: 'Read', input: {} }, undefined, 'sdk-1');
    store.updateToolStatus('t-1', 'completed', { result: 'shot', imageCount: 3 });
    store.updateStreamingMessage({ toolCalls: [{ id: 't-1', name: 'Read', input: {}, status: 'completed' }] }, 'sdk-1');

    expect(firstTool(store).imageCount).toBe(3);
  });

  it('adds no imageCount key to a text-only result', () => {
    const store = useStreamingStore();
    store.addToolCall({ id: 't-1', name: 'Read', input: {} });
    store.updateToolStatus('t-1', 'completed', { result: 'text' });

    expect(firstTool(store)).not.toHaveProperty('imageCount');
  });
});

/** A replay posts one message per transcript item; they land in one assignment per animation frame. */
describe('useStreamingStore replay queue', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    frames = new Map();
    nextFrame = 1;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.set(nextFrame, cb);
      return nextFrame++;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => void frames.delete(id));
  });
  afterEach(() => vi.unstubAllGlobals());

  function runFrames(): void {
    const pending = [...frames.values()];
    frames.clear();
    for (const cb of pending) cb(0);
  }

  function countAssignments(store: ReturnType<typeof useStreamingStore>): { count: number } {
    const seen = { count: 0 };
    watch(() => store.messages, () => { seen.count++; }, { flush: 'sync' });
    return seen;
  }

  it('lands N queued items in one assignment, in queue order, on the next frame', () => {
    const store = useStreamingStore();
    store.addMessage({ role: 'user', content: 'already here', timestamp: 1 });
    const assignments = countAssignments(store);
    const queued = Array.from({ length: 5 }, (_, i) => buildMessage({ role: 'assistant', content: `item ${i}`, timestamp: 2 + i, isReplay: true }));

    for (const msg of queued) store.queueReplayMessage(msg);

    expect(store.messages.map((m) => m.content)).toEqual(['already here']);
    expect(frames.size).toBe(1);

    runFrames();

    expect(assignments.count).toBe(1);
    expect(store.messages.map((m) => m.content)).toEqual(['already here', ...queued.map((m) => m.content)]);
    expect(store.messages.slice(1).map((m) => m.id)).toEqual(queued.map((m) => m.id));
  });

  it('flushes on demand, cancelling the pending frame', () => {
    const store = useStreamingStore();
    store.queueReplayMessage(buildUserMessage('hi', true));

    store.flushReplayQueue();

    expect(store.messages.map((m) => m.content)).toEqual(['hi']);
    expect(frames.size).toBe(0);
  });

  it('lands queued items ahead of a message added directly', () => {
    const store = useStreamingStore();
    store.queueReplayMessage(buildUserMessage('replayed', true));

    store.addErrorMessage('Unknown steer command');

    expect(store.messages.map((m) => m.content)).toEqual(['replayed', 'Unknown steer command']);
    expect(frames.size).toBe(0);
  });

  it('patches a tool call that is still queued', () => {
    const store = useStreamingStore();
    store.queueReplayMessage(buildMessage({
      role: 'assistant',
      content: '',
      timestamp: 1,
      isReplay: true,
      toolCalls: [{ id: 't-1', name: 'Bash', input: {}, status: 'completed' }],
    }));

    store.updateToolSummary(['t-1'], 'listed files');

    expect(store.messages[0]?.toolCalls?.[0]?.summary).toBe('listed files');
  });

  it('$reset discards the queue and its frame', () => {
    const store = useStreamingStore();
    store.queueReplayMessage(buildUserMessage('from the previous conversation', true));

    store.$reset();
    runFrames();
    store.flushReplayQueue();

    expect(store.messages).toEqual([]);
  });
});
