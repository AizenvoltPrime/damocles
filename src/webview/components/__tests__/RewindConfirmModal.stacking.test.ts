// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import { useEditorStore } from '@/stores/useEditorStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';
import { VSCODE_HOST_CAPABILITIES, type ExtensionToWebviewMessage } from '@shared/types/messages';

// Monaco needs a real layout engine and workers; the proposal diff only needs to mount.
vi.mock('@/components/editor/useMonaco', () => ({
  useMonaco: () => ({
    editor: {
      createModel: () => ({ dispose: () => {} }),
      createDiffEditor: () => ({ dispose: () => {}, setModel: () => {} }),
    },
  }),
  baseEditorOptions: () => ({}),
}));

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

const mounted: VueWrapper[] = [];
const fromHost = (data: ExtensionToWebviewMessage) => window.dispatchEvent(new MessageEvent('message', { data }));
const press = (key: string) => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const query = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const zIndex = (element: HTMLElement | null) => Number(element?.style.zIndex);

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
});

// WAI-ARIA APG stacked dialogs: a dialog opened over another paints and takes focus above it, and closing it reveals the one beneath.
describe('the rewind confirmation over a proposal diff', () => {
  it('stacks above the diff and takes focus; Escape closes only it, and focus comes back to the diff', async () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, monaco: true });
    mounted.push(mount(App, { attachTo: document.body, global: { plugins: [i18n] } }) as VueWrapper);
    const editorStore = useEditorStore();
    const side = { name: 'a.ts', path: '/w/a.ts', body: { kind: 'text' as const, content: 'a', languageId: 'typescript' } };
    editorStore.showDiff({ type: 'editorShowDiff', viewId: 'v1', title: 'a.ts', purpose: 'proposal', approvalId: 'tool-1', original: side, modified: side });
    editorStore.openProposal('tool-1');
    await vi.waitFor(() => expect(query('[data-testid="editor-overlay"]')).not.toBeNull());
    const diff = query('[data-testid="editor-overlay"]')!;

    // Rewind from the desktop command palette, then pick the turn.
    fromHost({ type: 'runChatCommand', command: 'rewind' });
    await vi.waitFor(() => expect(query('[data-testid="rewind-browser"]')).not.toBeNull());
    fromHost({ type: 'rewindHistory', prompts: [{ messageId: 'm1', content: 'first prompt', timestamp: 1, filesAffected: 1, files: [{ path: '/w/a.ts', displayName: 'a.ts' }] }], restorePoints: [], canFork: true });
    await vi.waitFor(() => expect(query('[data-testid="rewind-browser"] [role="option"]')).not.toBeNull());
    query('[data-testid="rewind-browser"] [role="option"]')!.click();

    await vi.waitFor(() => expect(query('[role="alertdialog"]')).not.toBeNull());
    const modal = query('[role="alertdialog"]')!;
    expect(zIndex(modal)).toBeGreaterThan(zIndex(diff));
    await vi.waitFor(() => expect(modal.contains(document.activeElement)).toBe(true));

    press('Escape');
    await vi.waitFor(() => expect(query('[role="alertdialog"]')).toBeNull());
    expect(editorStore.view?.viewId).toBe('v1');
    expect(diff.isConnected).toBe(true);

    // Cancelling the confirmation goes back to the turn picker, which closes in turn onto the diff.
    await vi.waitFor(() => expect(query('[data-testid="rewind-browser"]')).not.toBeNull());
    await flushPromises();
    press('Escape');
    await vi.waitFor(() => expect(query('[data-testid="rewind-browser"]')).toBeNull());
    expect(editorStore.view?.viewId).toBe('v1');
    expect(diff.contains(document.activeElement)).toBe(true);
  });
});
