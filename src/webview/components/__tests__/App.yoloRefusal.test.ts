// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import App from '@/App.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import { i18n } from '@/i18n';

// happy-dom has no font loading API; VirtualizedMessageList awaits `document.fonts.ready` on mount.
if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve() }, configurable: true });
}

let app: VueWrapper | null = null;
let posted: { type: string }[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const notice = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="yolo-refused"]');

describe('YOLO on a host whose policy refuses it', () => {
  it('says so in a live region that was already in the page, and sends nothing, when the host already refuses it', async () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, bypassPermissions: false });
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    await flushPromises();
    expect(notice()).toBeNull();
    const live = [...document.querySelectorAll('[role="status"]')];
    document.querySelector<HTMLElement>('[data-testid="composer-yolo"]')!.click();
    await flushPromises();
    expect(notice()).not.toBeNull();
    expect(live).toContain(notice()!.parentElement);
    expect(posted.some((m) => m.type === 'setDangerouslySkipPermissions')).toBe(false);
  });

  it('turns the toggle back off and says why when core refuses a change it sent', async () => {
    app = mount(App, { global: { plugins: [i18n] }, attachTo: document.body });
    await flushPromises();
    useSettingsStore().setDangerouslySkipPermissions(true);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'permissionModeRefused', mode: 'plan', reason: 'unknown-mode' } }));
    await flushPromises();
    expect(useSettingsStore().currentSettings.dangerouslySkipPermissions).toBe(true);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'permissionModeRefused', mode: 'dangerouslySkipPermissions', reason: 'remote-host' } }));
    await flushPromises();
    expect(useSettingsStore().currentSettings.dangerouslySkipPermissions).toBe(false);
    expect(notice()!.textContent).toContain('YOLO is off for your turns on this host.');
  });
});
