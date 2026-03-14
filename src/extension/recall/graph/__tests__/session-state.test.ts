import { describe, it, expect, beforeEach } from 'vitest';
import { GraphSessionState } from '../session-state';
import type { SessionTrace } from '../recall-graph-state';

function makeTrace(entryCount: number): SessionTrace {
  return {
    entries: Array.from({ length: entryCount }, (_, i) => ({
      promptIndex: i,
      intent: 'general',
      secondaryIntent: null,
      keyEntities: [`entity_${i}`],
      recallSucceeded: true,
      timestamp: `2025-01-0${(i % 9) + 1}T00:00:00.000Z`,
    })),
    lastIntent: 'general',
    recentEntities: ['entity_0'],
  };
}

describe('GraphSessionState', () => {
  let sessionState: GraphSessionState;

  beforeEach(() => {
    sessionState = new GraphSessionState();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getSessionTrace
  // ─────────────────────────────────────────────────────────────────────────

  describe('getSessionTrace', () => {
    it('returns empty trace initially', () => {
      const trace = sessionState.getSessionTrace();
      expect(trace.entries).toEqual([]);
      expect(trace.lastIntent).toBe('');
      expect(trace.recentEntities).toEqual([]);
    });

    it('returns a new object on each call (shallow copy)', () => {
      sessionState.updateSessionTrace(makeTrace(3));
      const trace1 = sessionState.getSessionTrace();
      const trace2 = sessionState.getSessionTrace();
      expect(trace1).not.toBe(trace2);
      expect(trace1).toEqual(trace2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // updateSessionTrace
  // ─────────────────────────────────────────────────────────────────────────

  describe('updateSessionTrace', () => {
    it('updates the session trace', () => {
      const trace = makeTrace(5);
      trace.lastIntent = 'debug';
      trace.recentEntities = ['auth', 'login'];
      sessionState.updateSessionTrace(trace);

      const result = sessionState.getSessionTrace();
      expect(result.entries).toHaveLength(5);
      expect(result.lastIntent).toBe('debug');
      expect(result.recentEntities).toEqual(['auth', 'login']);
    });

    it('truncates entries to MAX_TRACE_ENTRIES (50)', () => {
      const trace = makeTrace(60);
      sessionState.updateSessionTrace(trace);

      const result = sessionState.getSessionTrace();
      expect(result.entries).toHaveLength(50);
      expect(result.entries[0]!.promptIndex).toBe(10);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // serialize / deserialize
  // ─────────────────────────────────────────────────────────────────────────

  describe('serialize / deserialize', () => {
    it('round-trips correctly', () => {
      const trace = makeTrace(5);
      trace.lastIntent = 'feature';
      trace.recentEntities = ['x', 'y'];
      sessionState.updateSessionTrace(trace);

      const serialized = sessionState.serialize();
      const restored = GraphSessionState.deserialize(serialized);

      const result = restored.getSessionTrace();
      expect(result.entries).toHaveLength(5);
      expect(result.lastIntent).toBe('feature');
      expect(result.recentEntities).toEqual(['x', 'y']);
    });

    it('produces valid JSON', () => {
      sessionState.updateSessionTrace(makeTrace(3));
      const serialized = sessionState.serialize();
      expect(() => JSON.parse(serialized)).not.toThrow();
    });

    it('deserializes corrupt data gracefully', () => {
      const restored = GraphSessionState.deserialize('not json');
      expect(restored.getSessionTrace().entries).toEqual([]);
    });

    it('deserializes empty object gracefully', () => {
      const restored = GraphSessionState.deserialize('{}');
      expect(restored.getSessionTrace().entries).toEqual([]);
    });

    it('deserializes partial data gracefully', () => {
      const restored = GraphSessionState.deserialize('{"entries":[{"promptIndex":1}],"lastIntent":"test"}');
      const trace = restored.getSessionTrace();
      expect(trace.entries).toHaveLength(1);
      expect(trace.lastIntent).toBe('test');
      expect(trace.recentEntities).toEqual([]);
    });

    it('defaults missing secondaryIntent to null on deserialization', () => {
      const oldData = JSON.stringify({
        entries: [
          { promptIndex: 0, intent: 'feature', keyEntities: ['auth'], recallSucceeded: true, timestamp: '2025-01-01' },
          { promptIndex: 1, intent: 'debug', keyEntities: ['login'], recallSucceeded: false, timestamp: '2025-01-02' },
        ],
        lastIntent: 'debug',
        recentEntities: ['auth', 'login'],
      });
      const restored = GraphSessionState.deserialize(oldData);
      const trace = restored.getSessionTrace();
      expect(trace.entries).toHaveLength(2);
      expect(trace.entries[0]!.secondaryIntent).toBeNull();
      expect(trace.entries[1]!.secondaryIntent).toBeNull();
    });

    it('truncates entries on deserialization', () => {
      const trace = makeTrace(60);
      const serialized = JSON.stringify(trace);
      const restored = GraphSessionState.deserialize(serialized);
      expect(restored.getSessionTrace().entries).toHaveLength(50);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // reset
  // ─────────────────────────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all state', () => {
      sessionState.updateSessionTrace(makeTrace(10));
      sessionState.reset();

      const trace = sessionState.getSessionTrace();
      expect(trace.entries).toEqual([]);
      expect(trace.lastIntent).toBe('');
      expect(trace.recentEntities).toEqual([]);
    });
  });
});
