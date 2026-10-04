// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { effectScope, ref, nextTick, watch } from 'vue';
import type { ChatMessage } from '@shared/types/session';
import { useScrollEngine } from '../useScrollEngine';
import { useStickToBottom } from '../useStickToBottom';
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
  const column = document.createElement('div');
  Object.defineProperty(column, 'clientWidth', { value: 400 });

  const engine = useScrollEngine(ref(items), ref(null), ref(container), ref(canvas), ref(column));
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

describe('a row resizing while the reader is scrolled into the transcript', () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * Three 32px rows of three messages at tops 0, 48 and 96 (144px of canvas) in a 50px view, with each row's
   * ResizeObserver callback kept for the test to call. The canvas takes its height from the frame on
   * the next flush, as the list's render does, and `scrollTop` clamps to it as a browser's does.
   */
  async function transcriptAt(scrollTop: number, streamingMessage?: string) {
    const reports = new Map<Element, ResizeObserverCallback>();
    vi.stubGlobal('ResizeObserver', class {
      readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) { this.callback = callback; }
      observe(el: Element): void { reports.set(el, this.callback); }
      disconnect(): void {}
    });
    const canvas = document.createElement('div');
    const container = document.createElement('div');
    container.append(canvas);
    const canvasHeight = () => parseFloat(canvas.style.minHeight) || 0;
    const maxScroll = () => Math.max(0, canvasHeight() - 50);
    let top = 0;
    Object.defineProperties(container, {
      scrollHeight: { get: canvasHeight },
      clientHeight: { value: 50 },
      scrollTop: {
        get: () => Math.min(top, maxScroll()),
        set: (value: number) => { top = Math.max(0, Math.min(value, maxScroll())); },
      },
    });
    const column = document.createElement('div');
    Object.defineProperty(column, 'clientWidth', { value: 400 });
    const items = ref(['r0', 'r1', 'r2'].map((id): VirtualItem => ({ ...baseItem(id, 'error-message'), sourceMessageId: `m-${id}` })));
    const engine = useScrollEngine(items, ref(streamingMessage), ref(container), ref(canvas), ref(column));
    watch(engine.frame, (frame) => { canvas.style.minHeight = `${frame.totalHeight}px`; }, { immediate: true });
    engine.measureContainerWidth();
    await nextTick();
    container.scrollTop = scrollTop;

    const rows = new Map<string, HTMLElement>();
    const resize = (id: string, height: number): void => {
      let row = rows.get(id);
      if (!row) {
        row = document.createElement('div');
        rows.set(id, row);
        engine.onItemMounted(id, row);
      }
      const entry = { target: row, borderBoxSize: [{ blockSize: height, inlineSize: 400 }] } as unknown as ResizeObserverEntry;
      reports.get(row)?.([entry], {} as ResizeObserver);
    };
    return { container, items, resize };
  }

  it('shifts the view by the growth of a row wholly above it, so what the reader sees stays put', async () => {
    const { container, resize } = await transcriptAt(60);

    resize('r0', 132);
    await nextTick();

    expect(container.scrollTop).toBe(160);
  });

  it('leaves the view alone when a row of the streaming message it starts inside grows at its end', async () => {
    // A committed text block of the reply still streaming grows as the reply does, though it is no streaming-text row.
    const { container, resize } = await transcriptAt(60, 'm-r1');
    resize('r1', 32);

    resize('r1', 1032);
    await nextTick();

    expect(container.scrollTop).toBe(60);
  });

  it('shifts the view by the growth of a finished row it starts inside, whose content above the fold changed', async () => {
    const { container, resize } = await transcriptAt(60);
    resize('r1', 32);

    resize('r1', 1032);
    await nextTick();

    expect(container.scrollTop).toBe(1060);
  });

  it.each([
    ['text appended to it', { type: 'text-block', text: 'first chunk' }, { type: 'text-block', text: 'first chunk, last chunk' }],
    ['the rest of its streamed text revealed as it becomes a text block', { type: 'streaming-text', text: 'reply' }, { type: 'text-block', text: 'reply' }],
  ] as const)('leaves the view alone when a row it starts inside grows from %s since it was measured', async (_name, before, after) => {
    // A reply's last growth can be measured after its stream has ended.
    const { container, items, resize } = await transcriptAt(60);
    const showRow = async (content: Pick<VirtualItem, 'type' | 'text'>) => {
      items.value = items.value.map((item) => (item.id === 'r1' ? { ...item, ...content } : item));
      await nextTick();
    };
    await showRow(before);
    resize('r1', 32);
    await showRow(after);

    resize('r1', 1032);
    await nextTick();

    expect(container.scrollTop).toBe(60);
  });

  it('leaves the view alone when the first measurement of a row it starts inside corrects its estimate', async () => {
    // A finished reply mounts as a new row whose content is already on screen at its true height.
    const { container, resize } = await transcriptAt(60);

    resize('r1', 1032);
    await nextTick();

    expect(container.scrollTop).toBe(60);
  });

  it('shifts once the taller canvas is committed, by the sum of every row resized in that flush', async () => {
    // At the bottom: a shift written before the canvas grows is clamped to the old bottom.
    const { container, resize } = await transcriptAt(94);

    resize('r0', 132);
    resize('r1', 82);
    expect(container.scrollTop).toBe(94);
    await nextTick();

    expect(container.scrollTop).toBe(244);
  });

  it('shifts by a shrink above it once, though the shorter canvas already clamped the view', async () => {
    const { container, resize } = await transcriptAt(94);

    resize('r0', 12);
    await nextTick();

    expect(container.scrollTop).toBe(74);
  });

  it('keeps a following view at the bottom when a row above and the streaming row grow in one flush', async () => {
    const { container, resize } = await transcriptAt(94, 'm-r2');
    const scope = effectScope();
    const view = scope.run(() => useStickToBottom(ref(container)));
    await nextTick();

    resize('r0', 132);
    resize('r2', 82);
    await nextTick();
    await nextTick();

    expect(container.scrollTop).toBe(244);
    expect(view?.isFollowing.value).toBe(true);
    scope.stop();
  });
});
