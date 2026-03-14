import { describe, it, expect } from 'vitest';
import { createRecallGraphAnnotation } from '../recall-graph-state';
import type { RecallGraphState, SessionTrace } from '../recall-graph-state';

describe('createRecallGraphAnnotation', () => {
  it('returns an AnnotationSpec with defaults function', () => {
    const annotation = createRecallGraphAnnotation();
    expect(annotation.defaults).toBeInstanceOf(Function);
  });

  it('produces correct default values', () => {
    const defaults = createRecallGraphAnnotation().defaults();

    expect(defaults.userPrompt).toBe('');
    expect(defaults.history).toEqual([]);
    expect(defaults.promptIndex).toBe(-1);
    expect(defaults.intent).toBe('general');
    expect(defaults.secondaryIntent).toBeNull();
    expect(defaults.keyEntities).toEqual([]);
    expect(defaults.recallContext).toBeNull();
    expect(defaults.recallTrajectory).toBeNull();
    expect(defaults.sessionTrace).toEqual({
      entries: [],
      lastIntent: '',
      recentEntities: [],
    });
  });

  it('produces independent default objects on each call', () => {
    const annotation = createRecallGraphAnnotation();
    const d1 = annotation.defaults();
    const d2 = annotation.defaults();

    d1.keyEntities.push('modified');
    expect(d2.keyEntities).toEqual([]);
  });

  it('does not define reducers', () => {
    const annotation = createRecallGraphAnnotation();
    expect(annotation.reducers).toBeUndefined();
  });
});

describe('RecallGraphState type shape', () => {
  it('supports all required fields', () => {
    const state: RecallGraphState = {
      userPrompt: 'test query',
      history: [],
      promptIndex: 5,
      intent: 'debug',
      secondaryIntent: null,
      keyEntities: ['auth', 'login'],
      recallContext: 'some context',
      recallTrajectory: {
        promptIndex: 5,
        userPrompt: 'test query',
        iterations: [],
        finalContext: 'some context',
        totalDurationMs: 100,
        shortCircuited: false,
        forcedAnswer: false,
        timedOut: false,
        turnCount: 10,
        historyChars: 5000,
      },
      sessionTrace: {
        entries: [{
          promptIndex: 4,
          intent: 'feature',
          secondaryIntent: null,
          keyEntities: ['button'],
          recallSucceeded: true,
          timestamp: '2025-01-01T00:00:00.000Z',
        }],
        lastIntent: 'feature',
        recentEntities: ['button'],
      },
    };

    expect(state.intent).toBe('debug');
    expect(state.sessionTrace.entries).toHaveLength(1);
  });
});

describe('SessionTrace structure', () => {
  it('supports empty trace', () => {
    const trace: SessionTrace = {
      entries: [],
      lastIntent: '',
      recentEntities: [],
    };
    expect(trace.entries).toHaveLength(0);
  });

  it('supports multiple entries', () => {
    const trace: SessionTrace = {
      entries: [
        { promptIndex: 0, intent: 'feature', secondaryIntent: null, keyEntities: ['a'], recallSucceeded: true, timestamp: '' },
        { promptIndex: 1, intent: 'debug', secondaryIntent: null, keyEntities: ['b'], recallSucceeded: false, timestamp: '' },
        { promptIndex: 2, intent: 'recall', secondaryIntent: null, keyEntities: ['a', 'c'], recallSucceeded: true, timestamp: '' },
      ],
      lastIntent: 'recall',
      recentEntities: ['a', 'b', 'c'],
    };
    expect(trace.entries).toHaveLength(3);
    expect(trace.lastIntent).toBe('recall');
  });
});
