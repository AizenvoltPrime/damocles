import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { CANCELLED_TOOL_DETAIL_KEY } from '@shared/types/session';
import type { ContentBlock } from '@shared/types/content';
import { useStreamingStore } from '../useStreamingStore';
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
