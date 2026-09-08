// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { ref, nextTick } from 'vue';
import type { ChatMessage } from '@shared/types/session';
import { useScrollEngine } from '../useScrollEngine';
import type { VirtualItem } from '../useVirtualizedMessages';
import { at } from '@/__tests__/helpers';

/**
 * The engine measures an item only once it mounts, so a notice that never scrolls into view keeps
 * whatever the estimate reserved. These pin the two notice cards against the generic fallback.
 */

const anchor: ChatMessage = { id: 'a1', role: 'assistant', content: 'reply', timestamp: 100 };

function baseItem(id: string, type: VirtualItem['type']): VirtualItem {
  return { id, type, message: anchor, originalMessageIndex: 0, sourceMessageId: anchor.id, spacingLevel: 0 };
}

async function heightsFor(items: VirtualItem[]): Promise<number[]> {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 400 });
  Object.defineProperty(container, 'clientHeight', { value: 600 });
  const canvas = document.createElement('div');

  const engine = useScrollEngine(ref(items), ref(container), ref(canvas));
  engine.measureContainerWidth();
  await nextTick();

  return engine.frame.value.items.map((item) => item.height);
}

describe('the height the engine reserves for a compaction-aborted notice', () => {
  it('reserves two text lines when the adapter sent no reason', async () => {
    const item = baseItem('compaction-aborted-1', 'compaction-aborted-notice');
    item.compactionAborted = { id: '1', trigger: 'threshold', willRetry: true, timestamp: 100 };

    expect(at(await heightsFor([item]), 0)).toBe(68);
  });

  it('reserves a third text line when the notice carries a reason', async () => {
    const item = baseItem('compaction-aborted-2', 'compaction-aborted-notice');
    item.compactionAborted = { id: '2', trigger: 'overflow', willRetry: false, timestamp: 100, errorMessage: 'the summary model refused' };

    expect(at(await heightsFor([item]), 0)).toBe(86);
  });
});

describe('the height the engine reserves for a thinking-dropped notice', () => {
  it('reserves two text lines when the notice lists no reason', async () => {
    const item = baseItem('thinking-dropped-1', 'thinking-dropped-notice');
    item.thinkingDropped = { id: '1', count: 1, reasons: [], timestamp: 100 };

    expect(at(await heightsFor([item]), 0)).toBe(68);
  });

  it('reserves a third text line when the notice lists a reason', async () => {
    const item = baseItem('thinking-dropped-2', 'thinking-dropped-notice');
    item.thinkingDropped = { id: '2', count: 2, reasons: ['the model rejected the thinking signature'], timestamp: 100 };

    expect(at(await heightsFor([item]), 0)).toBe(86);
  });
});
