import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useSessionStore } from '../useSessionStore';

describe('useSessionStore.addCompactMarker — entryId (rewind-to-before-compaction)', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('stores the compaction entry id on the marker so the card can branch the tree', () => {
    const store = useSessionStore();
    store.addCompactMarker('manual', 43000, 5000, 'the summary', 111, 222, 'comp-7');

    expect(store.compactMarkers).toHaveLength(1);
    expect(store.compactMarkers[0]).toMatchObject({
      trigger: 'manual',
      preTokens: 43000,
      postTokens: 5000,
      summary: 'the summary',
      entryId: 'comp-7',
    });
  });

  it('leaves entryId undefined when none is provided (never fabricated)', () => {
    const store = useSessionStore();
    store.addCompactMarker('threshold', 1000);

    expect(store.compactMarkers[0]!.entryId).toBeUndefined();
  });

  it('accumulates one marker per compaction, each carrying its own entry id', () => {
    const store = useSessionStore();
    store.addCompactMarker('manual', 1000, undefined, undefined, 1, undefined, 'comp-1');
    store.addCompactMarker('overflow', 2000, undefined, undefined, 2, undefined, 'comp-2');

    expect(store.compactMarkers.map((m) => m.entryId)).toEqual(['comp-1', 'comp-2']);
  });
});

describe('useSessionStore.addCompactMarker: billed usage', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('carries billedTokens and billedCost through to the marker', () => {
    const store = useSessionStore();
    store.addCompactMarker('manual', 43000, 5000, undefined, 111, undefined, undefined, 12400, 0.031);

    expect(store.compactMarkers[0]).toMatchObject({ billedTokens: 12400, billedCost: 0.031 });
  });

  it('keeps a zero cost, because zero billed is a fact and not a missing field', () => {
    const store = useSessionStore();
    store.addCompactMarker('manual', 43000, 5000, undefined, 111, undefined, undefined, 0, 0);

    expect(store.compactMarkers[0]!.billedTokens).toBe(0);
    expect(store.compactMarkers[0]!.billedCost).toBe(0);
  });

  it('omits both fields when a replayed historical boundary carries neither', () => {
    const store = useSessionStore();
    store.addCompactMarker('manual', 43000);

    expect(store.compactMarkers[0]!.billedTokens).toBeUndefined();
    expect(store.compactMarkers[0]!.billedCost).toBeUndefined();
  });
});

describe('useSessionStore transcript notices', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('gives two aborts on the same millisecond distinct ids', () => {
    const store = useSessionStore();
    store.addCompactionAbortedNotice('threshold', true, 500);
    store.addCompactionAbortedNotice('threshold', false, 500);

    const ids = store.compactionAbortedNotices.map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('leaves errorMessage undefined when the adapter sent none', () => {
    const store = useSessionStore();
    store.addCompactionAbortedNotice('overflow', false, 500);

    expect(store.compactionAbortedNotices[0]!.errorMessage).toBeUndefined();
    expect(store.compactionAbortedNotices[0]!.willRetry).toBe(false);
  });

  it('stores the dropped-thinking reasons untouched', () => {
    const store = useSessionStore();
    store.addThinkingDroppedNotice(2, ['signature mismatch at content[0]', 'unknown reason'], 900);

    expect(store.thinkingDroppedNotices[0]).toMatchObject({
      count: 2,
      reasons: ['signature mismatch at content[0]', 'unknown reason'],
      timestamp: 900,
    });
  });

  it('clears both new notice lists with the rest of the session data', () => {
    const store = useSessionStore();
    store.addCompactionAbortedNotice('manual', true, 1);
    store.addThinkingDroppedNotice(1, ['unknown reason'], 2);
    store.clearSessionData();

    expect(store.compactionAbortedNotices).toHaveLength(0);
    expect(store.thinkingDroppedNotices).toHaveLength(0);
  });
});


describe('useSessionStore.setSessionState', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('starts idle before the extension has published anything', () => {
    const store = useSessionStore();

    expect(store.sessionState).toBe('idle');
    expect(store.isAwaitingUserAction).toBe(false);
  });

  it.each([
    ['idle', false],
    ['running', false],
    ['requires_action', true],
  ] as const)('keeps %s exactly as sent', (state, awaiting) => {
    const store = useSessionStore();
    store.setSessionState(state);

    expect(store.sessionState).toBe(state);
    expect(store.isAwaitingUserAction).toBe(awaiting);
  });

  it('follows the falsification sequence without sticking on a parked state', () => {
    const store = useSessionStore();
    const seen: string[] = [];
    for (const state of ['running', 'requires_action', 'running', 'requires_action', 'running', 'idle'] as const) {
      store.setSessionState(state);
      seen.push(store.sessionState);
    }

    expect(seen).toEqual(['running', 'requires_action', 'running', 'requires_action', 'running', 'idle']);
    expect(store.isAwaitingUserAction).toBe(false);
  });

  it('clears a parked state when the turn is cancelled with the dialog still open', () => {
    // Cancelling withdraws the prompt, so idle arrives with no running in between.
    const store = useSessionStore();
    store.setSessionState('running');
    store.setSessionState('requires_action');
    store.setSessionState('idle');

    expect(store.sessionState).toBe('idle');
    expect(store.isAwaitingUserAction).toBe(false);
  });

  it('accepts a parked state that arrives with no running before it', () => {
    // The derivation lets a pending prompt outrank the turn lifecycle, so this order is reachable.
    const store = useSessionStore();
    store.setSessionState('requires_action');

    expect(store.isAwaitingUserAction).toBe(true);

    store.setSessionState('idle');

    expect(store.isAwaitingUserAction).toBe(false);
  });

  it('stays correct if the same state ever lands twice', () => {
    // The extension suppresses byte-identical repeats, so the store must not depend on that guard.
    const store = useSessionStore();
    store.setSessionState('requires_action');
    store.setSessionState('requires_action');
    store.setSessionState('running');

    expect(store.sessionState).toBe('running');
  });

  it('keeps the state the extension published when the user switches session', () => {
    // The extension owns the value and republishes on every path, so inferring idle here would race that message.
    const store = useSessionStore();
    store.setSessionState('requires_action');
    store.clearSessionData();

    expect(store.sessionState).toBe('requires_action');
  });

  it('keeps the state the extension published through a full store reset', () => {
    const store = useSessionStore();
    store.setSessionState('requires_action');
    store.$reset();

    expect(store.sessionState).toBe('requires_action');
  });
});
