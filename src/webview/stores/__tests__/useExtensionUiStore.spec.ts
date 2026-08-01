import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useExtensionUiStore, type ExtensionUiRequest } from '../useExtensionUiStore';

/**
 * Slice 2 §5 — the dialog store is a FIFO QUEUE, not a single slot.
 *
 * Before this slice only the panel elicited, so a second request could only ever overwrite the first
 * and nobody noticed. Nested agents (subagents, team specialists) elicit on the parent panel, so N
 * requests are open at once and each one has a server blocked on it until it is answered. Every
 * property below exists because breaking it LOSES a request silently: the modal disappears, the agent
 * stalls until the MCP call times out, and nothing anywhere reports an error.
 *
 * The removal-by-id tests deliberately target a NON-HEAD entry. `queue.shift()` passes every
 * head-only test and drops the wrong dialog the first time two agents elicit at once — that is the
 * mutation these tests exist to catch (brief §7, "resolving a queued request by assuming it is the head").
 */

const req = (requestId: string, extra: Partial<ExtensionUiRequest> = {}): ExtensionUiRequest => ({
  requestId,
  kind: 'select',
  title: `Title ${requestId}`,
  options: ['Continue', 'Decline'],
  ...extra,
});

describe('useExtensionUiStore — FIFO queue', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('starts empty with no current request', () => {
    const store = useExtensionUiStore();
    expect(store.queue).toEqual([]);
    expect(store.current).toBeNull();
  });

  it('enqueues concurrent requests in arrival order and renders only the head', () => {
    // Two agents elicit before either is answered. Both must survive; exactly one is `current`.
    const store = useExtensionUiStore();
    store.setRequest(req('a', { agentId: 'ag-1', agentName: 'Scout' }));
    store.setRequest(req('b', { agentId: 'ag-2', agentName: 'Builder' }));

    expect(store.queue.map((r) => r.requestId)).toEqual(['a', 'b']);
    expect(store.current?.requestId).toBe('a');
    expect(store.current?.agentName).toBe('Scout');
  });

  it('answering the head surfaces the next request (no dialog is stranded)', () => {
    const store = useExtensionUiStore();
    store.setRequest(req('a'));
    store.setRequest(req('b'));
    store.setRequest(req('c'));

    store.resolve('a');

    expect(store.current?.requestId).toBe('b');
    expect(store.queue.map((r) => r.requestId)).toEqual(['b', 'c']);
  });

  it('resolve removes a NON-HEAD entry and leaves the head rendered', () => {
    // The head is what the user is looking at; a webview-side answer for a background id must not
    // yank the visible modal out from under them. `queue.shift()` would do exactly that.
    const store = useExtensionUiStore();
    store.setRequest(req('a'));
    store.setRequest(req('b'));
    store.setRequest(req('c'));

    store.resolve('b');

    expect(store.queue.map((r) => r.requestId)).toEqual(['a', 'c']);
    expect(store.current?.requestId).toBe('a');
  });

  it('cancel removes a NON-HEAD entry and leaves the head rendered', () => {
    // The extension withdrawing agent #2's dialog (that agent aborted) must not cancel agent #1's.
    const store = useExtensionUiStore();
    store.setRequest(req('a', { agentId: 'ag-1' }));
    store.setRequest(req('b', { agentId: 'ag-2' }));
    store.setRequest(req('c', { agentId: 'ag-3' }));

    store.cancel('c');

    expect(store.queue.map((r) => r.requestId)).toEqual(['a', 'b']);
    expect(store.current?.requestId).toBe('a');
  });

  it('cancelling the head promotes the next request rather than clearing the queue', () => {
    const store = useExtensionUiStore();
    store.setRequest(req('a'));
    store.setRequest(req('b'));

    store.cancel('a');

    expect(store.current?.requestId).toBe('b');
    expect(store.queue).toHaveLength(1);
  });

  it('a duplicate requestId does not double-enqueue', () => {
    // The extension emits one message per request, but a re-delivered/replayed message must not create
    // a second entry that can never be removed (removal is by id and would delete both at once).
    const store = useExtensionUiStore();
    store.setRequest(req('a', { title: 'first' }));
    store.setRequest(req('a', { title: 'second' }));

    expect(store.queue).toHaveLength(1);
    expect(store.queue[0]!.title).toBe('first');
  });

  it('removing an unknown requestId is a no-op, not a drop of the head', () => {
    // A late `extensionUiCancel` for something already answered must not consume the next dialog.
    const store = useExtensionUiStore();
    store.setRequest(req('a'));
    store.setRequest(req('b'));

    store.resolve('nope');
    store.cancel('also-nope');

    expect(store.queue.map((r) => r.requestId)).toEqual(['a', 'b']);
    expect(store.current?.requestId).toBe('a');
  });

  it('interleaved enqueue and out-of-order removal keeps every surviving request', () => {
    // Three agents, answered/withdrawn in an order that has nothing to do with arrival — the realistic
    // case, and the one a head-assuming implementation corrupts.
    const store = useExtensionUiStore();
    store.setRequest(req('a'));
    store.setRequest(req('b'));
    store.cancel('a');
    store.setRequest(req('c'));
    store.resolve('c');
    store.setRequest(req('d'));

    expect(store.queue.map((r) => r.requestId)).toEqual(['b', 'd']);
    expect(store.current?.requestId).toBe('b');

    store.resolve('b');
    expect(store.current?.requestId).toBe('d');
    store.resolve('d');
    expect(store.current).toBeNull();
    expect(store.queue).toEqual([]);
  });

  it('carries attribution fields through untouched (the webview never re-derives them)', () => {
    // Sanitization is extension-side at capture; the store is a transport. If it started massaging
    // `agentName` there would be two sanitizers to keep in agreement, and they would drift.
    const store = useExtensionUiStore();
    store.setRequest(req('a', { agentId: 'ag-7', agentName: 'Reviewer 2', teamId: 'team-1' }));

    expect(store.current).toMatchObject({ agentId: 'ag-7', agentName: 'Reviewer 2', teamId: 'team-1' });
  });

  it('a panel-owned request carries no attribution keys at all', () => {
    const store = useExtensionUiStore();
    store.setRequest(req('a'));

    expect('agentId' in store.current!).toBe(false);
    expect('agentName' in store.current!).toBe(false);
  });
});
