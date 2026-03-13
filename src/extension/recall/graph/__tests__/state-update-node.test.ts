import { describe, it, expect } from 'vitest';
import { stateUpdateNode } from '../nodes/state-update';
import type { RecallGraphState, SessionTrace } from '../recall-graph-state';

function makeState(overrides: Partial<RecallGraphState> = {}): RecallGraphState {
  return {
    userPrompt: 'test',
    history: [],
    promptIndex: 0,
    intent: 'general',
    keyEntities: [],
    recallContext: null,
    recallTrajectory: null,
    sessionTrace: { entries: [], lastIntent: '', recentEntities: [] },
    ...overrides,
  };
}

const dummyContext = { nodeName: 'state-update' };

describe('stateUpdateNode', () => {
  it('appends a new trace entry', async () => {
    const state = makeState({
      promptIndex: 5,
      intent: 'debug',
      keyEntities: ['auth', 'login'],
      recallContext: 'some context',
    });

    const result = await stateUpdateNode(state, dummyContext);

    expect(result.sessionTrace).toBeDefined();
    const trace = result.sessionTrace!;
    expect(trace.entries).toHaveLength(1);
    expect(trace.entries[0]!.promptIndex).toBe(5);
    expect(trace.entries[0]!.intent).toBe('debug');
    expect(trace.entries[0]!.keyEntities).toEqual(['auth', 'login']);
    expect(trace.entries[0]!.recallSucceeded).toBe(true);
    expect(trace.entries[0]!.timestamp).toBeTruthy();
  });

  it('marks recall as failed when context is null', async () => {
    const state = makeState({ recallContext: null });
    const result = await stateUpdateNode(state, dummyContext);
    expect(result.sessionTrace!.entries[0]!.recallSucceeded).toBe(false);
  });

  it('marks recall as failed when trajectory shows forcedAnswer', async () => {
    const state = makeState({
      recallContext: 'some context',
      recallTrajectory: {
        promptIndex: 0,
        userPrompt: 'test',
        iterations: [],
        finalContext: 'some context',
        totalDurationMs: 100,
        shortCircuited: false,
        forcedAnswer: true,
        timedOut: false,
        turnCount: 5,
        historyChars: 1000,
      },
    });
    const result = await stateUpdateNode(state, dummyContext);
    expect(result.sessionTrace!.entries[0]!.recallSucceeded).toBe(false);
  });

  it('marks recall as failed when trajectory shows timedOut', async () => {
    const state = makeState({
      recallContext: 'some context',
      recallTrajectory: {
        promptIndex: 0,
        userPrompt: 'test',
        iterations: [],
        finalContext: 'some context',
        totalDurationMs: 120000,
        shortCircuited: false,
        forcedAnswer: false,
        timedOut: true,
        turnCount: 5,
        historyChars: 1000,
      },
    });
    const result = await stateUpdateNode(state, dummyContext);
    expect(result.sessionTrace!.entries[0]!.recallSucceeded).toBe(false);
  });

  it('marks recall as succeeded when context exists and no failures', async () => {
    const state = makeState({
      recallContext: 'good context',
      recallTrajectory: {
        promptIndex: 0,
        userPrompt: 'test',
        iterations: [],
        finalContext: 'good context',
        totalDurationMs: 50,
        shortCircuited: true,
        forcedAnswer: false,
        timedOut: false,
        turnCount: 5,
        historyChars: 1000,
      },
    });
    const result = await stateUpdateNode(state, dummyContext);
    expect(result.sessionTrace!.entries[0]!.recallSucceeded).toBe(true);
  });

  it('preserves existing trace entries', async () => {
    const existingTrace: SessionTrace = {
      entries: [
        { promptIndex: 0, intent: 'feature', keyEntities: ['a'], recallSucceeded: true, timestamp: '2025-01-01' },
        { promptIndex: 1, intent: 'debug', keyEntities: ['b'], recallSucceeded: false, timestamp: '2025-01-02' },
      ],
      lastIntent: 'debug',
      recentEntities: ['a', 'b'],
    };

    const state = makeState({
      promptIndex: 2,
      intent: 'explain',
      keyEntities: ['c'],
      recallContext: 'context',
      sessionTrace: existingTrace,
    });

    const result = await stateUpdateNode(state, dummyContext);
    expect(result.sessionTrace!.entries).toHaveLength(3);
    expect(result.sessionTrace!.entries[0]!.intent).toBe('feature');
    expect(result.sessionTrace!.entries[1]!.intent).toBe('debug');
    expect(result.sessionTrace!.entries[2]!.intent).toBe('explain');
  });

  it('updates lastIntent to current intent', async () => {
    const state = makeState({ intent: 'recall' });
    const result = await stateUpdateNode(state, dummyContext);
    expect(result.sessionTrace!.lastIntent).toBe('recall');
  });

  it('merges and deduplicates recentEntities', async () => {
    const state = makeState({
      keyEntities: ['c', 'a'],
      sessionTrace: {
        entries: [],
        lastIntent: '',
        recentEntities: ['a', 'b'],
      },
    });

    const result = await stateUpdateNode(state, dummyContext);
    const entities = result.sessionTrace!.recentEntities;
    expect(entities).toContain('a');
    expect(entities).toContain('b');
    expect(entities).toContain('c');
    expect(new Set(entities).size).toBe(entities.length);
  });

  it('limits recentEntities to 20', async () => {
    const state = makeState({
      keyEntities: Array.from({ length: 15 }, (_, i) => `new_${i}`),
      sessionTrace: {
        entries: [],
        lastIntent: '',
        recentEntities: Array.from({ length: 15 }, (_, i) => `old_${i}`),
      },
    });

    const result = await stateUpdateNode(state, dummyContext);
    expect(result.sessionTrace!.recentEntities.length).toBeLessThanOrEqual(20);
  });

  it('produces a valid timestamp', async () => {
    const state = makeState();
    const result = await stateUpdateNode(state, dummyContext);
    const ts = result.sessionTrace!.entries[0]!.timestamp;
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).getTime()).not.toBeNaN();
  });
});
