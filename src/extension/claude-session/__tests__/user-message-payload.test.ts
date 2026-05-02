import { describe, it, expect } from 'vitest';
import { buildUserMessagePayload } from '../user-message-payload';
import type { RecallService } from '../../recall';

function makeRecallStub(promptIndex: number, activeNodeId: string | null): RecallService {
  return {
    currentPromptIndex: promptIndex,
    activeNodeId,
  } as unknown as RecallService;
}

describe('buildUserMessagePayload', () => {
  it('stamps recall promptIndex/activeNodeId when recall is enabled with active node', () => {
    const recall = makeRecallStub(3, 'node-abc');
    const payload = buildUserMessagePayload(
      { recallService: recall },
      'hello',
      { correlationId: 'corr-1' },
    );
    expect(payload.type).toBe('userMessage');
    expect(payload.content).toBe('hello');
    expect(payload.correlationId).toBe('corr-1');
    expect(payload.promptIndex).toBe(3);
    expect(payload.nodeId).toBe('node-abc');
  });

  it('stamps recall promptIndex with null nodeId when no active node', () => {
    const recall = makeRecallStub(2, null);
    const payload = buildUserMessagePayload(
      { recallService: recall },
      'hi',
      { correlationId: 'corr-2' },
    );
    expect(payload.promptIndex).toBe(2);
    expect(payload.nodeId).toBeNull();
  });

  it('falls back to memoryPromptIndex when recall is absent', () => {
    const payload = buildUserMessagePayload(
      { memoryPromptIndex: 5 },
      'hi',
      { correlationId: 'corr-3' },
    );
    expect(payload.promptIndex).toBe(5);
    expect(payload.nodeId).toBeNull();
  });

  it('clamps negative promptIndex to 0', () => {
    const payload = buildUserMessagePayload(
      { memoryPromptIndex: -1 },
      'hi',
      { correlationId: 'corr-4' },
    );
    expect(payload.promptIndex).toBe(0);
  });

  it('preserves contentBlocks when provided', () => {
    const blocks = [
      { type: 'text' as const, text: 'see image' },
      {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' },
      },
    ];
    const payload = buildUserMessagePayload(
      { memoryPromptIndex: 0 },
      'see image',
      { correlationId: 'corr-5', contentBlocks: blocks },
    );
    expect(payload.contentBlocks).toEqual(blocks);
  });

  it('omits contentBlocks when undefined', () => {
    const payload = buildUserMessagePayload(
      { memoryPromptIndex: 0 },
      'plain',
      { correlationId: 'corr-6' },
    );
    expect('contentBlocks' in payload).toBe(false);
  });

  it('returns nodeId as null when both recall and memory absent', () => {
    const payload = buildUserMessagePayload({}, 'hi', { correlationId: 'corr-7' });
    expect(payload.nodeId).toBeNull();
    expect(payload.promptIndex).toBe(0);
  });
});
