import { describe, it, expect } from 'vitest';
import { extractNodeTurnRefs } from '../../session/reading';
import { stampReplayMessage, type ReplayStampInput } from '../replay-stamp';
import type { ClaudeSessionEntry } from '../../session/types';

interface UserReplay {
  type: 'userReplay';
  isInjected?: boolean;
  sdkMessageId?: string;
  promptIndex: number;
  nodeId: string | null;
}

function stampReplays(
  messages: ReplayStampInput[],
  refs: Map<string, { promptIndex: number; nodeId: string }>,
): UserReplay[] {
  let synthetic = 0;
  const out: UserReplay[] = [];
  for (const msg of messages) {
    const { stamp, advance } = stampReplayMessage(msg, synthetic, refs);
    if (advance) synthetic++;
    out.push({
      type: 'userReplay',
      ...(msg.isInjected !== undefined ? { isInjected: msg.isInjected } : {}),
      ...(msg.sdkMessageId !== undefined ? { sdkMessageId: msg.sdkMessageId } : {}),
      promptIndex: stamp.promptIndex,
      nodeId: stamp.nodeId,
    });
  }
  return out;
}

describe('extractNodeTurnRefs', () => {
  it('extracts uuid → {promptIndex, nodeId} from node-turn-ref entries', () => {
    const entries: ClaudeSessionEntry[] = [
      { type: 'user', uuid: 'u-1', timestamp: '2024-01-01T00:00:00Z' } as unknown as ClaudeSessionEntry,
      { type: 'node-turn-ref', uuid: 'u-1', nodeId: 'node-A', promptIndex: 0 } as unknown as ClaudeSessionEntry,
      { type: 'user', uuid: 'u-2', timestamp: '2024-01-01T00:01:00Z' } as unknown as ClaudeSessionEntry,
      { type: 'node-turn-ref', uuid: 'u-2', nodeId: 'node-B', promptIndex: 1 } as unknown as ClaudeSessionEntry,
    ];
    const refs = extractNodeTurnRefs(entries);
    expect(refs.size).toBe(2);
    expect(refs.get('u-1')).toEqual({ promptIndex: 0, nodeId: 'node-A' });
    expect(refs.get('u-2')).toEqual({ promptIndex: 1, nodeId: 'node-B' });
  });

  it('skips malformed node-turn-ref entries', () => {
    const entries: ClaudeSessionEntry[] = [
      { type: 'node-turn-ref', uuid: 'u-1', nodeId: 'node-A' } as unknown as ClaudeSessionEntry,
      { type: 'node-turn-ref', uuid: 'u-2', promptIndex: 1 } as unknown as ClaudeSessionEntry,
      { type: 'node-turn-ref', nodeId: 'node-A', promptIndex: 2 } as unknown as ClaudeSessionEntry,
    ];
    const refs = extractNodeTurnRefs(entries);
    expect(refs.size).toBe(0);
  });

  it('rejects negative or non-integer promptIndex', () => {
    const entries: ClaudeSessionEntry[] = [
      { type: 'node-turn-ref', uuid: 'u-1', nodeId: 'node-A', promptIndex: -1 } as unknown as ClaudeSessionEntry,
      { type: 'node-turn-ref', uuid: 'u-2', nodeId: 'node-B', promptIndex: NaN } as unknown as ClaudeSessionEntry,
      { type: 'node-turn-ref', uuid: 'u-3', nodeId: 'node-C', promptIndex: 1.5 } as unknown as ClaudeSessionEntry,
    ];
    expect(extractNodeTurnRefs(entries).size).toBe(0);
  });

  it('returns empty map when no node-turn-ref entries', () => {
    const entries: ClaudeSessionEntry[] = [
      { type: 'user', uuid: 'u-1' } as unknown as ClaudeSessionEntry,
      { type: 'assistant', uuid: 'a-1' } as unknown as ClaudeSessionEntry,
    ];
    expect(extractNodeTurnRefs(entries).size).toBe(0);
  });
});

describe('history-manager stamping', () => {
  it('uses node-turn-ref values when uuid matches', () => {
    const refs = new Map([
      ['u-1', { promptIndex: 0, nodeId: 'node-A' }],
      ['u-2', { promptIndex: 1, nodeId: 'node-A' }],
    ]);
    const messages = [
      { sdkMessageId: 'u-1' },
      { sdkMessageId: 'u-2' },
    ];
    const stamped = stampReplays(messages, refs);
    expect(stamped[0].promptIndex).toBe(0);
    expect(stamped[0].nodeId).toBe('node-A');
    expect(stamped[1].promptIndex).toBe(1);
    expect(stamped[1].nodeId).toBe('node-A');
  });

  it('increments synthetic counter for non-injected pre-recall messages with no ref', () => {
    const refs = new Map<string, { promptIndex: number; nodeId: string }>();
    const messages = [
      { sdkMessageId: 'u-1' },
      { sdkMessageId: 'u-2' },
      { sdkMessageId: 'u-3' },
    ];
    const stamped = stampReplays(messages, refs);
    expect(stamped.map(s => s.promptIndex)).toEqual([0, 1, 2]);
    expect(stamped.every(s => s.nodeId === null)).toBe(true);
  });

  it('does not advance synthetic counter for injected messages', () => {
    const refs = new Map<string, { promptIndex: number; nodeId: string }>();
    const messages: ReplayStampInput[] = [
      { sdkMessageId: 'u-1' },
      { sdkMessageId: 'i-1', isInjected: true },
      { sdkMessageId: 'u-2' },
    ];
    const stamped = stampReplays(messages, refs);
    expect(stamped[0].promptIndex).toBe(0);
    expect(stamped[1].promptIndex).toBe(0);
    expect(stamped[1].nodeId).toBeNull();
    expect(stamped[2].promptIndex).toBe(1);
  });

  it('handles mixed pre-recall and recall entries', () => {
    const refs = new Map([
      ['u-3', { promptIndex: 2, nodeId: 'node-A' }],
      ['u-4', { promptIndex: 3, nodeId: 'node-A' }],
    ]);
    const messages = [
      { sdkMessageId: 'u-1' },
      { sdkMessageId: 'u-2' },
      { sdkMessageId: 'u-3' },
      { sdkMessageId: 'u-4' },
    ];
    const stamped = stampReplays(messages, refs);
    expect(stamped[0]).toMatchObject({ promptIndex: 0, nodeId: null });
    expect(stamped[1]).toMatchObject({ promptIndex: 1, nodeId: null });
    expect(stamped[2]).toMatchObject({ promptIndex: 2, nodeId: 'node-A' });
    expect(stamped[3]).toMatchObject({ promptIndex: 3, nodeId: 'node-A' });
  });
});
