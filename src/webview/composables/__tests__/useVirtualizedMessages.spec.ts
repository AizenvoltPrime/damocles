import { describe, it, expect } from 'vitest';
import { ref } from 'vue';
import type { ChatMessage, CompactMarker, CacheMissNotice, CompactionAbortedNotice, ThinkingDroppedNotice } from '@shared/types/session';
import { useVirtualizedMessages } from '../useVirtualizedMessages';
import { at } from '@/__tests__/helpers';

interface BuildExtras {
  compactMarkers?: CompactMarker[];
  compactionAbortedNotices?: CompactionAbortedNotice[];
  thinkingDroppedNotices?: ThinkingDroppedNotice[];
}

function build(messages: ChatMessage[], cacheMissNotices: CacheMissNotice[] = [], extras: BuildExtras = {}) {
  return useVirtualizedMessages({
    messages: ref(messages),
    compactMarkers: ref<CompactMarker[]>(extras.compactMarkers ?? []),
    cacheMissNotices: ref<CacheMissNotice[]>(cacheMissNotices),
    compactionAbortedNotices: ref<CompactionAbortedNotice[]>(extras.compactionAbortedNotices ?? []),
    thinkingDroppedNotices: ref<ThinkingDroppedNotice[]>(extras.thinkingDroppedNotices ?? []),
    streamingMessageId: ref<string | null>(null),
  });
}

describe('useVirtualizedMessages refusal handling', () => {
  it('emits a single refusal-message item for a role:refusal message', () => {
    const refusal: ChatMessage = {
      id: 'r1',
      role: 'refusal',
      content: 'declined for safety',
      refusalExplanation: 'declined for safety',
      refusalCategory: 'cyber',
      timestamp: 1,
    };
    const { items } = build([refusal]);

    expect(items.value).toHaveLength(1);
    const item = at(items.value, 0);
    expect(item.type).toBe('refusal-message');
    expect(item.id).toBe('refusal-r1');
    expect(item.text).toBe('declined for safety');
    expect(item.message.refusalCategory).toBe('cyber');
  });

  it('does not emit a stray text bubble for an empty-content assistant turn preceding a refusal', () => {
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 1,
    };
    const refusal: ChatMessage = {
      id: 'r1',
      role: 'refusal',
      content: '',
      refusalExplanation: null,
      refusalCategory: null,
      timestamp: 2,
    };
    const { items } = build([assistant, refusal]);

    expect(items.value).toHaveLength(1);
    expect(at(items.value, 0).type).toBe('refusal-message');
  });
});

describe('useVirtualizedMessages cache-miss notice interleaving', () => {
  it('places a cache-miss-notice at the correct position between two messages', () => {
    const first: ChatMessage = { id: 'u1', role: 'user', content: 'first', timestamp: 100 };
    const second: ChatMessage = { id: 'u2', role: 'user', content: 'second', timestamp: 300 };
    // Store ids are prefix-free (`<timestamp>-<seq>`); the virtualizer namespaces with `cache-miss-`.
    const notice: CacheMissNotice = {
      id: '200-0',
      missedTokens: 12000,
      missedCost: 0.42,
      idleMs: 6 * 60 * 1000,
      modelChanged: false,
      timestamp: 200,
    };

    const { items } = build([first, second], [notice]);

    const types = items.value.map(i => i.type);
    expect(types).toEqual(['user-message', 'cache-miss-notice', 'user-message']);

    const noticeItem = at(items.value, 1);
    expect(noticeItem.type).toBe('cache-miss-notice');
    // Namespaced once — no `cache-miss-cache-miss-` double prefix.
    expect(noticeItem.id).toBe('cache-miss-200-0');
    expect(noticeItem.notice).toEqual(notice);
  });

  it('emits a trailing cache-miss-notice when its timestamp is after the last message', () => {
    const only: ChatMessage = { id: 'u1', role: 'user', content: 'hello', timestamp: 100 };
    const notice: CacheMissNotice = {
      id: '500-0',
      missedTokens: 2048,
      missedCost: 0,
      idleMs: 1000,
      modelChanged: true,
      timestamp: 500,
    };

    const { items } = build([only], [notice]);

    const types = items.value.map(i => i.type);
    expect(types).toEqual(['user-message', 'cache-miss-notice']);
    expect(at(items.value, 1).notice).toEqual(notice);
  });
});

describe('useVirtualizedMessages compaction-aborted interleaving', () => {
  it('places a compaction-aborted-notice between the two messages it fell between', () => {
    const first: ChatMessage = { id: 'u1', role: 'user', content: 'first', timestamp: 100 };
    const second: ChatMessage = { id: 'u2', role: 'user', content: 'second', timestamp: 300 };
    const aborted: CompactionAbortedNotice = {
      id: '200-0',
      trigger: 'overflow',
      willRetry: true,
      timestamp: 200,
    };

    const { items } = build([first, second], [], { compactionAbortedNotices: [aborted] });

    expect(items.value.map(i => i.type)).toEqual(['user-message', 'compaction-aborted-notice', 'user-message']);
    const item = at(items.value, 1);
    expect(item.id).toBe('compaction-aborted-200-0');
    expect(item.compactionAborted).toEqual(aborted);
  });

  it('emits a trailing compaction-aborted-notice when the abort outlives the last message', () => {
    const only: ChatMessage = { id: 'u1', role: 'user', content: 'hello', timestamp: 100 };
    const aborted: CompactionAbortedNotice = {
      id: '500-0',
      trigger: 'threshold',
      willRetry: false,
      errorMessage: 'summary model refused',
      timestamp: 500,
    };

    const { items } = build([only], [], { compactionAbortedNotices: [aborted] });

    expect(items.value.map(i => i.type)).toEqual(['user-message', 'compaction-aborted-notice']);
    expect(at(items.value, 1).compactionAborted).toEqual(aborted);
  });
});

describe('useVirtualizedMessages thinking-dropped interleaving', () => {
  it('places a thinking-dropped-notice at its timestamp and namespaces the id once', () => {
    const first: ChatMessage = { id: 'u1', role: 'user', content: 'first', timestamp: 100 };
    const second: ChatMessage = { id: 'a1', role: 'assistant', content: 'reply', timestamp: 300 };
    const dropped: ThinkingDroppedNotice = {
      id: '200-0',
      count: 2,
      reasons: ['signature mismatch at content[0]', 'unknown reason'],
      timestamp: 200,
    };

    const { items } = build([first, second], [], { thinkingDroppedNotices: [dropped] });

    expect(items.value.map(i => i.type)).toEqual(['user-message', 'thinking-dropped-notice', 'text-block']);
    const item = at(items.value, 1);
    expect(item.id).toBe('thinking-dropped-200-0');
    expect(item.thinkingDropped).toEqual(dropped);
  });

  it('emits a trailing thinking-dropped-notice when it lands after the last message', () => {
    const only: ChatMessage = { id: 'u1', role: 'user', content: 'hello', timestamp: 100 };
    const dropped: ThinkingDroppedNotice = { id: '500-0', count: 1, reasons: ['unknown reason'], timestamp: 500 };

    const { items } = build([only], [], { thinkingDroppedNotices: [dropped] });

    expect(items.value.map(i => i.type)).toEqual(['user-message', 'thinking-dropped-notice']);
    expect(at(items.value, 1).thinkingDropped).toEqual(dropped);
  });
});

describe('useVirtualizedMessages compaction trigger', () => {
  it('carries threshold and overflow through as distinct marker triggers', () => {
    const first: ChatMessage = { id: 'u1', role: 'user', content: 'first', timestamp: 100 };
    const second: ChatMessage = { id: 'u2', role: 'user', content: 'second', timestamp: 500 };
    const thresholdMarker: CompactMarker = { id: 'c1', timestamp: 200, trigger: 'threshold', preTokens: 90_000 };
    const overflowMarker: CompactMarker = { id: 'c2', timestamp: 300, trigger: 'overflow', preTokens: 95_000 };

    const { items } = build([first, second], [], { compactMarkers: [thresholdMarker, overflowMarker] });

    const markers = items.value.filter(i => i.type === 'compact-marker');
    expect(markers.map(m => m.marker?.trigger)).toEqual(['threshold', 'overflow']);
  });
});

describe('useVirtualizedMessages with a message list that is not sorted by timestamp', () => {
  // markQueueProcessed moves a processed queued bubble to the end of the array keeping its older
  // timestamp, so the message before the last one can hold a higher timestamp than the last one.
  const outOfOrder: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'first', timestamp: 100 },
    { id: 'q2', role: 'user', content: 'second queued', timestamp: 250 },
    { id: 'q1', role: 'user', content: 'first queued', timestamp: 200 },
  ];

  it('emits one compaction-aborted item for an abort that falls inside the highest gap', () => {
    const aborted: CompactionAbortedNotice = { id: 'compaction-aborted-230-0', trigger: 'threshold', willRetry: true, timestamp: 230 };

    const { items } = build(outOfOrder, [], { compactionAbortedNotices: [aborted] });

    const emitted = items.value.filter(i => i.type === 'compaction-aborted-notice');
    expect(emitted).toHaveLength(1);
    expect(new Set(items.value.map(i => i.id)).size).toBe(items.value.length);
  });

  it('emits one cache-miss item for a notice that falls inside the highest gap', () => {
    const notice: CacheMissNotice = { id: '230-0', missedTokens: 900, missedCost: 0.01, idleMs: 1000, modelChanged: false, timestamp: 230 };

    const { items } = build(outOfOrder, [notice]);

    expect(items.value.filter(i => i.type === 'cache-miss-notice')).toHaveLength(1);
    expect(new Set(items.value.map(i => i.id)).size).toBe(items.value.length);
  });

  it('emits one compact marker for a boundary that falls inside the highest gap', () => {
    const marker: CompactMarker = { id: 'c1', timestamp: 230, trigger: 'threshold', preTokens: 90_000 };

    const { items } = build(outOfOrder, [], { compactMarkers: [marker] });

    expect(items.value.filter(i => i.type === 'compact-marker')).toHaveLength(1);
    expect(new Set(items.value.map(i => i.id)).size).toBe(items.value.length);
  });

  it('still emits a trailing notice that outlives every message', () => {
    const aborted: CompactionAbortedNotice = { id: '900-0', trigger: 'overflow', willRetry: false, timestamp: 900 };

    const { items } = build(outOfOrder, [], { compactionAbortedNotices: [aborted] });

    const types = items.value.map(i => i.type);
    expect(types).toEqual(['user-message', 'user-message', 'user-message', 'compaction-aborted-notice']);
  });
});

describe('useVirtualizedMessages ordering inside one message gap', () => {
  it('orders two notices of different types by timestamp', () => {
    const first: ChatMessage = { id: 'u1', role: 'user', content: 'first', timestamp: 100 };
    const second: ChatMessage = { id: 'u2', role: 'user', content: 'second', timestamp: 300 };
    const dropped: ThinkingDroppedNotice = { id: '110-0', count: 1, reasons: ['unknown reason'], timestamp: 110 };
    const aborted: CompactionAbortedNotice = { id: '290-0', trigger: 'threshold', willRetry: true, timestamp: 290 };

    const { items } = build([first, second], [], { compactionAbortedNotices: [aborted], thinkingDroppedNotices: [dropped] });

    expect(items.value.map(i => i.type)).toEqual([
      'user-message',
      'thinking-dropped-notice',
      'compaction-aborted-notice',
      'user-message',
    ]);
  });
});

describe('useVirtualizedMessages team management calls', () => {
  it('keeps a resume_team call, which renders its team card, and drops cancel_team', () => {
    const message = {
      id: 'm1', role: 'assistant', content: '', timestamp: 1,
      toolCalls: [
        { id: 'tc-resume', name: 'resume_team', input: { team_id: 't' }, status: 'running' },
        { id: 'tc-cancel', name: 'cancel_team', input: { team_id: 't' }, status: 'completed' },
      ],
    } as unknown as ChatMessage;

    const items = build([message]).items.value.filter((i) => i.type === 'tool-call');

    expect(items.map((i) => i.toolCall?.id)).toEqual(['tc-resume']);
  });
});
