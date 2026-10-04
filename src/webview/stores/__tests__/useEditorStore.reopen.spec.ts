import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useEditorStore } from '../useEditorStore';

/** The agent raises a proposal diff, so it never opens by itself: the permission card opens it, as often as asked, until the host closes it. */

const doc = (content: string) => ({ name: 'a.ts', body: { kind: 'text' as const, content, languageId: 'typescript' } });
const proposal = { type: 'editorShowDiff' as const, viewId: 'v1', title: 'a.ts', purpose: 'proposal' as const, approvalId: 'p-1', original: doc('a'), modified: doc('b') };

beforeEach(() => setActivePinia(createPinia()));

describe('proposal diffs', () => {
  it('holds a proposal without opening it, so nothing takes focus from the user', () => {
    const store = useEditorStore();
    store.showDiff(proposal);

    expect(store.view).toBeNull();
    expect(store.hasOpenOverlay).toBe(false);
  });

  it('leaves an open view in place when a proposal arrives', () => {
    const store = useEditorStore();
    store.openFile({ type: 'editorOpenFile', viewId: 'f1', title: 'b.ts', document: doc('c') });
    store.showDiff(proposal);

    expect(store.view).toMatchObject({ kind: 'file', viewId: 'f1' });
  });

  it('opens the proposal for its approval, and again after the user closed it', () => {
    const store = useEditorStore();
    store.showDiff(proposal);

    expect(store.openProposal('p-1')).toBe(true);
    expect(store.view).toMatchObject({ viewId: 'v1', approvalId: 'p-1' });
    store.dismissView();
    expect(store.openProposal('p-1')).toBe(true);
    expect(store.view).toMatchObject({ viewId: 'v1', approvalId: 'p-1' });
  });

  it('holds each pending proposal for its own card', () => {
    const store = useEditorStore();
    store.showDiff(proposal);
    store.showDiff({ ...proposal, viewId: 'v2', approvalId: 'p-2' });

    expect(store.openProposal('p-1')).toBe(true);
    expect(store.view?.viewId).toBe('v1');
    expect(store.openProposal('p-2')).toBe(true);
    expect(store.view?.viewId).toBe('v2');
  });

  it('opens nothing for an approval it holds no proposal for', () => {
    const store = useEditorStore();
    store.showDiff(proposal);

    expect(store.openProposal('p-2')).toBe(false);
    expect(store.view).toBeNull();
  });

  it('forgets the proposal, and closes it if open, once the host closes it after the decision', () => {
    const store = useEditorStore();
    store.showDiff(proposal);
    store.openProposal('p-1');
    store.closeView('v1');

    expect(store.view).toBeNull();
    expect(store.openProposal('p-1')).toBe(false);
  });

  it('opens a checkpoint diff at once and holds nothing for it', () => {
    const store = useEditorStore();
    store.showDiff({ ...proposal, purpose: 'checkpoint' });

    expect(store.view).toMatchObject({ viewId: 'v1', purpose: 'checkpoint' });
    store.dismissView();
    expect(store.openProposal('p-1')).toBe(false);
  });
});
