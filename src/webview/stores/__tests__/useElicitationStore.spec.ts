import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useElicitationStore } from '../useElicitationStore';
import type { ElicitationRequest } from '@shared/types/elicitation';

const request = (id: string, message = 'sign in'): ElicitationRequest => ({
  elicitationId: id,
  serverName: 'github',
  message,
  mode: 'url',
  url: 'https://example.invalid/auth',
});

describe('useElicitationStore against a re-posted elicitation', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('queues two distinct elicitations in arrival order', () => {
    const store = useElicitationStore();
    store.addElicitation(request('e1'));
    store.addElicitation(request('e2'));

    expect(store.pendingElicitations.map((e) => e.elicitationId)).toEqual(['e1', 'e2']);
  });

  it('ignores an id the queue already holds, because removal by id would drop both at once', () => {
    // The extension re-posts every pending prompt on webview ready, keeping the original elicitationId.
    const store = useElicitationStore();
    store.addElicitation(request('e1', 'first'));
    store.addElicitation(request('e1', 'second'));

    expect(store.pendingElicitations).toHaveLength(1);
    expect(store.pendingElicitations[0]!.message).toBe('first');
  });

  it('keeps the request behind a duplicate in its own place', () => {
    const store = useElicitationStore();
    store.addElicitation(request('e1'));
    store.addElicitation(request('e2'));
    store.addElicitation(request('e1'));
    store.removeElicitation('e1');

    expect(store.pendingElicitations.map((e) => e.elicitationId)).toEqual(['e2']);
  });
});
