// @vitest-environment happy-dom
// The overlay's settings messages are not held while the language main's state names loads: their handlers keep core's
// LocalizedText, which the view renders reactively, so one that arrives during the load still shows in that language.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { englishText } from '@shared/localized-text';
import { inGreek } from '../../../__mocks__/greek-locale';

// The paths the webview's i18n/index.ts imports the Greek catalogs from, resolved from this file.
const CORE_EL = '../../../../l10n/bundle.l10n.el.json';
const VIEW_EL = '../../../webview/i18n/locales/el.json';

let release!: () => void;
const catalogs = new Promise<void>((resolve) => (release = resolve));
let page: Awaited<ReturnType<typeof freshOverlay>>;
let wrapper: VueWrapper | undefined;

/** One overlay page over fresh modules, so the Greek catalogs (which the webview test setup preloads) load only after `catalogs`. */
async function freshOverlay() {
  vi.resetModules();
  vi.doMock(CORE_EL, async (importOriginal: () => Promise<unknown>) => {
    await catalogs;
    return importOriginal();
  });
  vi.doMock(VIEW_EL, async (importOriginal: () => Promise<unknown>) => {
    await catalogs;
    return importOriginal();
  });
  const { createPinia } = await import('pinia');
  const { installPlatformBridge } = await import('@/composables/usePlatformBridge');
  const { loadLocale, localeReady } = await import('@/i18n');
  const { useSettingWritesStore } = await import('@/components/settings/settings-writes');
  const { default: OverlayApp } = await import('../overlay/OverlayApp.vue');
  const { createOverlaySettingsBridge } = await import('../overlay/settings/overlay-bridge');
  const { addSettingsMessages } = await import('../overlay/settings/settings-messages');
  const { shellI18n } = await import('../i18n');
  const { FakeResizeObserver, fakeOverlayApi } = await import('./fakes');
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const api = fakeOverlayApi();
  const settingsBridge = createOverlaySettingsBridge(api);
  installPlatformBridge(settingsBridge);
  addSettingsMessages();
  const pinia = createPinia();
  wrapper = mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, pinia], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  return { api, loadLocale, localeReady, writes: () => useSettingWritesStore(pinia) };
}

// importing the overlay's module graph afresh outlasts the default hook timeout
beforeAll(async () => {
  page = await freshOverlay();
}, 60_000);

afterAll(() => {
  wrapper?.unmount();
  vi.doUnmock(CORE_EL);
  vi.doUnmock(VIEW_EL);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('overlay settings during a language load', () => {
  it("renders a chat's message that arrives while the language main's state switches to loads in that language", async () => {
    const { api, loadLocale, localeReady, writes } = page;
    const coreText = { message: 'Could not open file: {0}', args: ['settings.json'] };
    const error = (): string | undefined => document.querySelector('[data-testid="settings-row-damocles.desktop.theme"] [data-testid="setting-error"]')?.textContent?.trim();
    await flushPromises();
    api.request('s1', { kind: 'settings', generation: 1, section: 'appearance' });
    await flushPromises();
    expect(api.ack).toHaveBeenCalledWith('s1');

    api.pushState({ locale: 'el', platform: 'win32', remoteEnabled: true });
    api.settingsMessage({ type: 'settingWriteResult', key: 'damocles.desktop.theme', ok: false, error: coreText });
    // handled on arrival, and stored as core's text rather than as a rendered string
    expect(writes().latest(['damocles.desktop.theme'])).toMatchObject({ kind: 'error', error: coreText });
    await flushPromises();
    expect(localeReady('el')).toBe(false);
    expect(error()).toBe(englishText(coreText));

    release();
    await loadLocale('el');
    await flushPromises();
    expect(localeReady('el')).toBe(true);
    expect(error()).toBe(inGreek(coreText));
  });
});
