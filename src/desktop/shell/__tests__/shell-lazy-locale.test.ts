// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { App } from 'vue';
import type { OverlayRequest, OverlayToast } from '../../preload/overlay-channels';
import en from '../locales/en.json' with { type: 'json' };
import { LOCALE_HOLD_BOUND_MS } from '../../../shared/locale-hold';
import { FakeResizeObserver, STATE, fakeOverlayApi, fakeShellApi } from './fakes';

// The paths i18n.ts and the webview's i18n/index.ts import the Greek catalogs from, resolved from this file.
const SHELL_EL = '../locales/el.json';
const VIEW_EL = '../../../webview/i18n/locales/el.json';
const CORE_EL = '../../../../l10n/bundle.l10n.el.json';
const EMPTY_MENU: OverlayRequest = { kind: 'menu', label: 'Actions', anchor: { x: 0, y: 0, width: 0, height: 0 }, items: [] };
const TOAST: OverlayToast = { id: 't1', at: Date.now(), lifeMs: 8000, remainingMs: 8000, body: { kind: 'notice', severity: 'info', message: 'Saved', actions: [] } };

const loads = { count: 0 };
const mounted: VueWrapper[] = [];

/** A gate that holds the Greek catalog's load until released. */
function gated(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { gate, release };
}

/** Fresh shell i18n whose Greek catalog counts its loads, waits for `gate`, and fails while `fail` is set. */
async function freshShellI18n(options: { gate?: Promise<void>; fail?: boolean } = {}) {
  loads.count = 0;
  vi.resetModules();
  vi.doMock(SHELL_EL, async (importOriginal: () => Promise<unknown>) => {
    loads.count += 1;
    await options.gate;
    if (options.fail) throw new Error('Failed to fetch dynamically imported module');
    return importOriginal();
  });
  return import('../i18n');
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.doUnmock(SHELL_EL);
  vi.doUnmock(VIEW_EL);
  vi.doUnmock(CORE_EL);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.lang = '';
});

describe('the shell\'s Greek catalog', () => {
  it('is not in the initial messages, and an English page never loads it', async () => {
    const { applyShellLocale, shellI18n } = await freshShellI18n();

    expect(shellI18n.global.availableLocales).toEqual(['en']);
    await applyShellLocale('en');

    expect(shellI18n.global.t('overlay.noMatches')).toBe('No matches');
    expect(loads.count).toBe(0);
  });

  it('shows a switch to Greek once it has loaded, and a switch back and forth after that loads nothing more', async () => {
    const { gate, release } = gated();
    const { applyShellLocale, shellI18n } = await freshShellI18n({ gate });

    const switching = applyShellLocale('el');
    await flushPromises();
    expect(shellI18n.global.locale.value).toBe('en');
    expect(document.documentElement.lang).not.toBe('el');

    release();
    await switching;
    expect(shellI18n.global.locale.value).toBe('el');
    expect(document.documentElement.lang).toBe('el');
    expect(shellI18n.global.t('overlay.noMatches')).toBe('Δεν υπάρχουν αποτελέσματα');

    await applyShellLocale('en');
    expect(shellI18n.global.t('overlay.noMatches')).toBe('No matches');
    await applyShellLocale('el');
    expect(shellI18n.global.t('overlay.noMatches')).toBe('Δεν υπάρχουν αποτελέσματα');
    expect(loads.count).toBe(1);
  });

  it('shows only the language asked for last when two switches overlap', async () => {
    const { gate, release } = gated();
    const { applyShellLocale, shellI18n } = await freshShellI18n({ gate });

    const greek = applyShellLocale('el');
    const english = applyShellLocale('en');
    release();
    await Promise.all([greek, english]);

    expect(shellI18n.global.locale.value).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('keeps and names the current language when it fails to load, logged once, and tries it again only after another was asked for', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const options = { fail: true };
    const { applyShellLocale, loadShellLocale, shellI18n } = await freshShellI18n(options);
    // main built the page in Greek
    document.documentElement.lang = 'el';

    await applyShellLocale('el');
    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0]![0])).toContain('el');
    expect(shellI18n.global.locale.value).toBe('en');
    // a screen reader voices the English text in an English voice, and uppercase keeps English rules
    expect(document.documentElement.lang).toBe('en');

    // the shell's state pushes name the same language again
    options.fail = false;
    await applyShellLocale('el');
    await expect(loadShellLocale('el')).resolves.toBe(false);
    expect(loads.count).toBe(1);
    expect(logged).toHaveBeenCalledOnce();
    expect(document.documentElement.lang).toBe('en');

    await applyShellLocale('en');
    await applyShellLocale('el');
    expect(shellI18n.global.locale.value).toBe('el');
    expect(document.documentElement.lang).toBe('el');
    expect(loads.count).toBe(2);
  });

  it('keeps the settings namespaces the overlay merged before it loaded', async () => {
    const { applyShellLocale, shellI18n } = await freshShellI18n();
    const webview = await import('@/i18n');
    const { addSettingsMessages } = await import('../overlay/settings/settings-messages');
    await webview.loadLocale('el');
    addSettingsMessages();

    await applyShellLocale('el');

    expect(shellI18n.global.t('settingsModal.title')).toBe('Ρυθμίσεις');
    expect(shellI18n.global.t('overlay.noMatches')).toBe('Δεν υπάρχουν αποτελέσματα');
  });
});

// The overlay already acknowledged what it holds, so main covers the window with it: a hung load must not leave it inert.
describe('a hold on a language load that hangs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers in the language shown once LOCALE_HOLD_BOUND_MS passed, logged once, and the switch still applies when it loads', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { gate, release } = gated();
    const { applyShellLocale, createLocaleHold, shellI18n } = await freshShellI18n({ gate });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const switching = applyShellLocale('el');
    const hold = createLocaleHold();
    const delivered: string[] = [];
    hold(() => delivered.push(`request in ${shellI18n.global.locale.value}`));
    hold(() => delivered.push('cancel'));

    await vi.advanceTimersByTimeAsync(LOCALE_HOLD_BOUND_MS - 1);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual(['request in en', 'cancel']);
    expect(logged).toHaveBeenCalledOnce();

    // the same load is not waited for again
    hold(() => delivered.push('toast'));
    expect(delivered).toEqual(['request in en', 'cancel', 'toast']);

    release();
    await switching;
    expect(shellI18n.global.locale.value).toBe('el');
    expect(logged).toHaveBeenCalledOnce();
  });

  it('bounds the load a delivery\'s gate names the same way', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { createLocaleHold } = await freshShellI18n();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hung = new Promise<void>(() => {});
    const hold = createLocaleHold();
    const delivered: string[] = [];
    hold(() => delivered.push('settings'), () => hung);
    hold(() => delivered.push('menu'));

    await vi.advanceTimersByTimeAsync(LOCALE_HOLD_BOUND_MS - 1);
    expect(delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual(['settings', 'menu']);
    hold(() => delivered.push('settings again'), () => hung);
    expect(delivered).toEqual(['settings', 'menu', 'settings again']);
  });
});

// Each test imports the overlay's components afresh, which takes seconds on a cold transform.
describe('a page that mounts before the Greek catalog loads', { timeout: 30_000 }, () => {
  it('acknowledges a request at once and renders it, and a cancel behind it, only once the catalog has loaded', async () => {
    const { gate, release } = gated();
    const { applyShellLocale, shellI18n } = await freshShellI18n({ gate });
    const { default: OverlayApp } = await import('../overlay/OverlayApp.vue');
    const { createOverlaySettingsBridge } = await import('../overlay/settings/overlay-bridge');
    const api = fakeOverlayApi();
    vi.mocked(api.getState).mockResolvedValue({ locale: 'el', platform: 'win32' });
    // The entry's load, from the <html lang> main wrote.
    const entry = applyShellLocale('el');
    const wrapper = mount(OverlayApp, {
      props: { api, settingsBridge: createOverlaySettingsBridge(api) },
      global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();

    api.request('r1', EMPTY_MENU);
    api.request('r2', EMPTY_MENU);
    api.cancel('r2');
    await flushPromises();
    expect(api.ack).toHaveBeenCalledWith('r1');
    expect(api.ack).toHaveBeenCalledWith('r2');
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(api.shown).not.toHaveBeenCalled();

    release();
    await entry;
    await flushPromises();
    expect(wrapper.findAll('[role="menu"]')).toHaveLength(1);
    expect(wrapper.text()).toContain('Δεν υπάρχουν αποτελέσματα');
    expect(api.shown).toHaveBeenCalledExactlyOnceWith('r1');
  });

  it('adds a toast to the stack only once the catalog has loaded', async () => {
    const { gate, release } = gated();
    const { applyShellLocale, shellI18n } = await freshShellI18n({ gate });
    const { default: NotifierApp } = await import('../overlay/NotifierApp.vue');
    const api = fakeOverlayApi();
    vi.mocked(api.getState).mockResolvedValue({ locale: 'el', platform: 'win32' });
    const entry = applyShellLocale('el');
    const wrapper = mount(NotifierApp, {
      props: { api },
      global: { plugins: [shellI18n], stubs: { transition: false, 'transition-group': false } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();

    api.toast(TOAST);
    await flushPromises();
    expect(wrapper.find('[data-toast-id="t1"]').exists()).toBe(false);

    release();
    await entry;
    await flushPromises();
    expect(wrapper.find('[data-toast-id="t1"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="overlay-toasts"]').attributes('aria-label')).toBe('Ειδοποιήσεις');
  });

  it('renders a settings request only once the settings\' catalogs have loaded too, so its first frame is in that language', async () => {
    const { gate, release } = gated();
    const { applyShellLocale, shellI18n } = await freshShellI18n();
    for (const catalog of [VIEW_EL, CORE_EL]) {
      vi.doMock(catalog, async (importOriginal: () => Promise<unknown>) => {
        await gate;
        return importOriginal();
      });
    }
    const { createPinia: freshPinia } = await import('pinia');
    const { installPlatformBridge } = await import('@/composables/usePlatformBridge');
    const { default: OverlayApp } = await import('../overlay/OverlayApp.vue');
    const { createOverlaySettingsBridge } = await import('../overlay/settings/overlay-bridge');
    const { addSettingsMessages, applySettingsLocale } = await import('../overlay/settings/settings-messages');
    const api = fakeOverlayApi();
    vi.mocked(api.getState).mockResolvedValue({ locale: 'el', platform: 'win32' });
    const settingsBridge = createOverlaySettingsBridge(api);
    installPlatformBridge(settingsBridge);
    addSettingsMessages();
    // The entry's loads, from the <html lang> main wrote.
    const shell = applyShellLocale('el');
    const settings = applySettingsLocale('el');
    const wrapper = mount(OverlayApp, {
      props: { api, settingsBridge },
      global: { plugins: [shellI18n, freshPinia()], stubs: { transition: false, 'transition-group': false } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await shell;
    await flushPromises();

    api.request('s1', { kind: 'settings', generation: 1, section: 'appearance' });
    await flushPromises();
    expect(api.ack).toHaveBeenCalledWith('s1');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.shown).not.toHaveBeenCalled();

    release();
    await settings;
    await flushPromises();
    expect(api.shown).toHaveBeenCalledExactlyOnceWith('s1');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Ρυθμίσεις');
  });
});

describe('the shell entry', { timeout: 30_000 }, () => {
  afterEach(() => {
    const host = document.querySelector<HTMLElement & { __vue_app__?: App }>('#app');
    host?.__vue_app__?.unmount();
    host?.remove();
    delete (window as { damoclesShell?: unknown }).damoclesShell;
  });

  it('mounts only once the language main built the page in has loaded, so its first frame is in it', async () => {
    const { gate, release } = gated();
    const { shellI18n } = await freshShellI18n({ gate });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const api = fakeShellApi();
    vi.mocked(api.getState).mockResolvedValue({ ...STATE, locale: 'el' });
    (window as { damoclesShell?: unknown }).damoclesShell = api;
    document.documentElement.lang = 'el';
    const host = document.createElement('div');
    host.id = 'app';
    document.body.append(host);

    await import('../main');
    await flushPromises();
    expect(host.innerHTML).toBe('');

    release();
    await vi.waitFor(() => expect(host.innerHTML).not.toBe(''));
    const label = shellI18n.global.t('sidebar.label');
    expect(label).not.toBe(en.sidebar.label);
    expect(host.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
  });
});
