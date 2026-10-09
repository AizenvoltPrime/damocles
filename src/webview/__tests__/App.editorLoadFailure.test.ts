// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// A thenable module namespace makes `import()` reject, as a Monaco chunk that fails to load does.
vi.mock('@/components/editor/EditorOverlayHost.vue', () => ({
  then: (_resolve: unknown, reject: (err: Error) => void) => reject(new Error('chunk failed')),
}));
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import { useEditorStore } from '@/stores/useEditorStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

const mounted: VueWrapper[] = [];

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
});

describe('App when the editor chunk fails to load', () => {
  it('closes what asked for an editor, so the next request loads the chunk again', async () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, hostSettingsEditor: false, settingsSources: true, monaco: true });
    const editorStore = useEditorStore();
    // Vue reports the failed load to the app error handler after onError fails it.
    const errors: unknown[] = [];
    mounted.push(mount(App, { global: { plugins: [i18n], config: { errorHandler: (err) => { errors.push(err); } } } }) as VueWrapper);

    const doc = { name: 'a.ts', path: '/w/a.ts', body: { kind: 'text' as const, content: 'x', languageId: 'typescript' } };
    editorStore.showDiff({ type: 'editorShowDiff', viewId: 'v1', title: 'a.ts', purpose: 'proposal', approvalId: 'tool-1', original: doc, modified: doc });
    editorStore.openProposal('tool-1');

    await vi.waitFor(() => {
      expect(editorStore.hasOpenOverlay).toBe(false);
    });
    expect(editorStore.view).toBeNull();
    expect(errors).toHaveLength(1);
  });
});
