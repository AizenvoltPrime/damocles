// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import { useSettingsStore } from '@/stores/useSettingsStore';
import ExtensionUiDialog from '@/components/ExtensionUiDialog.vue';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import type { OverlayPrefs, OverlayPrefWrite } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// One overlay page per file, as in the app: the bridge is installed before anything uses it.
const api = fakeOverlayApi();
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

const mounted: VueWrapper[] = [];
let pinia: Pinia;

function mountOverlay(): VueWrapper {
  const wrapper = mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, pinia], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

async function openSettings(generation = 1, section?: 'application' | 'appearance' | 'accounts'): Promise<VueWrapper> {
  const wrapper = mountOverlay();
  await flushPromises();
  api.request('s1', { kind: 'settings', generation, ...(section ? { section } : {}) });
  await flushPromises();
  return wrapper;
}

const sent = (): unknown[][] => vi.mocked(api.settingsSend).mock.calls;
const modal = (): HTMLElement | null => document.querySelector('[data-testid="settings-modal"]');
const press = (key: string, target: EventTarget = document.activeElement ?? document.body): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};

// happy-dom has no Web Animations; the modal's exit awaits Element.animate().finished.
function stubAnimate(animate: (...args: unknown[]) => Animation): void {
  Object.defineProperty(HTMLElement.prototype, 'animate', { value: animate, configurable: true, writable: true });
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.mocked(api.settingsSend).mockClear();
  vi.mocked(api.answer).mockClear();
  vi.mocked(api.ack).mockClear();
  vi.mocked(api.setPref).mockClear();
  vi.mocked(api.relaunch).mockClear();
  document.documentElement.removeAttribute('data-reduced-motion');
});

afterEach(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('overlay settings', () => {
  it('renders the modal for a settings request, acknowledges it and asks the attached chat for its state', async () => {
    await openSettings(3);
    expect(modal()).not.toBeNull();
    expect(api.ack).toHaveBeenCalledWith('s1');
    expect(sent()).toContainEqual([3, { type: 'requestSettingsState' }]);
    expect(document.querySelector('.sm-scrim')!.classList.contains('sm-scrim-blur')).toBe(false);
  });

  it('on its first open asks only for the state, and the footer menu offers the files that answer names', async () => {
    await openSettings(1);
    expect(sent()).toEqual([[1, { type: 'requestSettingsState' }]]);
    api.settingsMessage({ type: 'hostCapabilities', capabilities: { ...VSCODE_HOST_CAPABILITIES, settingsInPanel: false, settingsSources: true, monaco: true } });
    api.settingsMessage({ type: 'settingsFileAvailability', files: { user: { available: true }, project: { available: false, reason: 'noProject' }, local: { available: false, reason: 'noProject' } } });
    await flushPromises();
    const footer = document.querySelector<HTMLElement>('[data-testid="settings-footer"]')!;
    footer.focus();
    press('Enter', footer);
    await flushPromises();
    const item = (scope: string): HTMLElement => document.querySelector<HTMLElement>(`[data-testid="settings-edit-json-${scope}"]`)!;
    expect(item('user').hasAttribute('data-disabled')).toBe(false);
    expect(item('project').hasAttribute('data-disabled')).toBe(true);
    expect(item('local').hasAttribute('data-disabled')).toBe(true);
  });

  it('shows none of the previous session\'s values when it opens again', async () => {
    document.documentElement.setAttribute('data-reduced-motion', '');
    await openSettings(1);
    const store = useSettingsStore();
    api.settingsMessage({ type: 'settingsUpdate', settings: { ...store.currentSettings, permissionMode: 'plan' }, workspaceWritable: true });
    await flushPromises();
    document.querySelector<HTMLElement>('[aria-label="Close (Esc)"]')!.click();
    await flushPromises();
    expect(api.answer).toHaveBeenCalledWith('s1', { kind: 'settings', closed: true });

    api.request('s2', { kind: 'settings', generation: 2 });
    await flushPromises();
    const checked = document.querySelector('[data-overlay-id="s2"] [data-testid="settings-row-permission-mode"] button[aria-pressed="true"]')!;
    expect(checked.textContent).not.toContain('Plan mode');
  });

  it('goes to the section and account row main forwards while it shows', async () => {
    await openSettings(1, 'application');
    api.settingsTarget({ section: 'accounts', account: 'openai' });
    await flushPromises();
    expect(document.querySelector('[data-testid="settings-nav-accounts"]')!.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('[data-testid="settings-row-account-openai"] button[aria-expanded]')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the host prompt dialog mounted, so a withdrawn prompt can play its exit', async () => {
    const wrapper = await openSettings(1);
    expect(wrapper.findComponent(ExtensionUiDialog).exists()).toBe(true);
  });

  it('shows what the chat sends back', async () => {
    await openSettings(1);
    const store = useSettingsStore();
    api.settingsMessage({ type: 'settingsUpdate', settings: { ...store.currentSettings, permissionMode: 'plan' }, workspaceWritable: true });
    await flushPromises();
    const plan = [...document.querySelectorAll('[data-testid="settings-row-permission-mode"] button[aria-pressed]')].find((el) => el.textContent?.includes('Plan mode'))!;
    expect(plan.getAttribute('aria-pressed')).toBe('true');
  });

  it('answers main only after the exit, and its own Escape does not dismiss the modal around a search', async () => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    stubAnimate(() => ({ finished }) as unknown as Animation);
    await openSettings();
    const search = document.querySelector<HTMLInputElement>('[data-testid="settings-search"]')!;
    search.value = 'budget';
    search.dispatchEvent(new Event('input'));
    await flushPromises();
    press('Escape', search);
    await flushPromises();
    expect(search.value).toBe('');
    expect(api.answer).not.toHaveBeenCalled();

    press('Escape', search);
    await flushPromises();
    expect(modal()!.hasAttribute('data-leaving')).toBe(true);
    expect(api.answer).not.toHaveBeenCalled();
    finish();
    await flushPromises();
    expect(api.answer).toHaveBeenCalledWith('s1', { kind: 'settings', closed: true });
  });

  it('answers at once under reduced motion', async () => {
    document.documentElement.setAttribute('data-reduced-motion', '');
    await openSettings();
    document.querySelector<HTMLElement>('[aria-label="Close (Esc)"]')!.click();
    await flushPromises();
    expect(api.answer).toHaveBeenCalledWith('s1', { kind: 'settings', closed: true });
  });

  it('drops a host prompt and its typed text, and sends with the new generation, when main re-attaches', async () => {
    await openSettings(1);
    api.settingsMessage({ type: 'extensionUiRequest', requestId: 'host-prompt:1', kind: 'input', title: 'API key', password: true });
    await flushPromises();
    const field = document.querySelector<HTMLInputElement>('[data-testid="extension-ui-dialog"] input')!;
    expect(field.type).toBe('password');
    field.value = 'sk-typed-secret';
    field.dispatchEvent(new Event('input'));
    expect(field.getAttribute('value')).toBeNull();

    api.settingsAttached(2);
    await flushPromises();
    expect(document.querySelector('[data-testid="extension-ui-dialog"]')).toBeNull();
    expect(document.body.innerHTML).not.toContain('sk-typed-secret');
    expect(sent()).toContainEqual([2, { type: 'requestSettingsState' }]);
  });

  it('writes desktop preferences through main and reverts one main refuses', async () => {
    await openSettings(1, 'appearance');
    await flushPromises();
    const light = [...document.querySelectorAll<HTMLElement>('[data-testid="settings-row-damocles.desktop.theme"] button[aria-pressed]')].find((el) => el.textContent?.includes('Light'))!;
    light.click();
    expect(api.setPref).toHaveBeenCalledWith('damocles.desktop.theme', 'light');
    await flushPromises();
    expect(document.querySelector('[data-testid="settings-row-damocles.desktop.theme"] [data-testid="setting-saved"]')!.getAttribute('title')).toBe('/home/u/.damocles/settings.json');

    vi.mocked(api.setPref).mockResolvedValueOnce({ ok: false, error: 'not allowed' });
    const motion = document.querySelector<HTMLElement>('[data-testid="settings-row-damocles.desktop.reduceMotion"] [role="switch"]')!;
    motion.click();
    await flushPromises();
    expect(motion.getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('[data-testid="settings-row-damocles.desktop.reduceMotion"] [data-testid="setting-error"]')!.textContent).toContain('not allowed');
  });

  it('never lets a late first read overwrite a value set since, and follows a change main pushes', async () => {
    let answer!: (prefs: OverlayPrefs) => void;
    vi.mocked(api.getPrefs).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await openSettings(1, 'appearance');
    const theme = (label: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('[data-testid="settings-row-damocles.desktop.theme"] button[aria-pressed]')].find((el) => el.textContent?.includes(label))!;
    theme('Light').click();
    await flushPromises();
    answer({ values: { 'damocles.desktop.theme': 'dark', 'damocles.desktop.reduceMotion': true }, languageAtLaunch: 'system' });
    await flushPromises();
    expect(theme('Light').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-testid="settings-row-damocles.desktop.reduceMotion"] [role="switch"]')!.getAttribute('aria-checked')).toBe('true');

    api.prefsChanged({ values: { 'damocles.desktop.theme': 'dark' }, languageAtLaunch: 'system' });
    await flushPromises();
    expect(theme('Dark').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps a value whose write main has not answered when main pushes a change', async () => {
    let written!: (result: OverlayPrefWrite) => void;
    vi.mocked(api.setPref).mockReturnValueOnce(new Promise((resolve) => (written = resolve)));
    await openSettings(1, 'appearance');
    await flushPromises();
    const theme = (label: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('[data-testid="settings-row-damocles.desktop.theme"] button[aria-pressed]')].find((el) => el.textContent?.includes(label))!;
    theme('Light').click();
    api.prefsChanged({ values: { 'damocles.desktop.theme': 'system' }, languageAtLaunch: 'system' });
    await flushPromises();
    expect(theme('Light').getAttribute('aria-pressed')).toBe('true');
    written({ ok: true, file: '/home/u/.damocles/settings.json' });
    await flushPromises();
    expect(theme('Light').getAttribute('aria-pressed')).toBe('true');
  });

  it('offers no restart for the language this run started with', async () => {
    await openSettings(1, 'application');
    await flushPromises();
    const language = (label: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('[data-testid="settings-row-damocles.desktop.language"] button[aria-pressed]')].find((el) => el.textContent?.trim() === label)!;
    language('Ελληνικά').click();
    await flushPromises();
    expect(document.querySelector('[data-testid="settings-restart-banner"]')).not.toBeNull();
    language('System').click();
    await flushPromises();
    expect(document.querySelector('[data-testid="settings-restart-banner"]')).toBeNull();
  });

  it('offers Restart now once the language is saved', async () => {
    await openSettings(1, 'application');
    await flushPromises();
    const greek = [...document.querySelectorAll<HTMLElement>('[data-testid="settings-row-damocles.desktop.language"] button[aria-pressed]')].find((el) => el.textContent?.trim() === 'Ελληνικά')!;
    greek.click();
    await flushPromises();
    const banner = document.querySelector<HTMLElement>('[data-testid="settings-restart-banner"]')!;
    const restart = [...banner.querySelectorAll('button')].find((el) => el.textContent?.includes('Restart now'))!;
    restart.click();
    expect(api.relaunch).toHaveBeenCalled();
  });
});
