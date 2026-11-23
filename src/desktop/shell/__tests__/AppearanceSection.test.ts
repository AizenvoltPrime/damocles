// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import type { SettingsSectionId } from '@shared/settings-sections';
import { KEEP_CHANGES_MS } from '@shared/themes/agent';
import { SHOW_WALLPAPERS_SETTING, THEMES_APPLY_MODE_SETTING, THEMES_STORE_SETTING } from '../../local-services/desktop-configuration';
import type { OverlaySettingsScopes } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// Settings › Appearance's schedule sub-page: it is part of the modal's navigation, so the button reaches it from a search and
// from any section, and a search, another section or Back ends it.
const api = fakeOverlayApi();
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

const mounted: VueWrapper[] = [];

async function open(section: SettingsSectionId, scopes?: OverlaySettingsScopes): Promise<void> {
  mounted.push(mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  }));
  await flushPromises();
  api.request('s1', { kind: 'settings', generation: 1, section, ...(scopes ? { scopes } : {}) });
  await flushPromises();
  await flushPromises();
}

const byTestId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const search = (): HTMLInputElement => byTestId('settings-search') as HTMLInputElement;

async function click(element: HTMLElement | null): Promise<void> {
  expect(element).toBeTruthy();
  element!.click();
  await flushPromises();
}

async function type(value: string): Promise<void> {
  search().value = value;
  search().dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the theme schedule page', () => {
  it.each(['appearance', 'editor'] as const)('opens from a search for its row, with focus on its heading, when %s was the section shown', async (section) => {
    await open(section);
    await type('schedule');
    expect(byTestId('schedule-page')).toBeNull();
    await click(byTestId('theme-schedule-edit'));
    expect(byTestId('schedule-page') !== null).toBe(true);
    const page = byTestId('schedule-page')!;
    expect(search().value).toBe('');
    expect(document.activeElement?.tagName).toBe('H2');
    expect(page.contains(document.activeElement)).toBe(true);
    expect(byTestId('settings-nav-appearance')!.getAttribute('aria-selected')).toBe('true');
  });

  it('goes back to the rows with focus on the button that opened it, and is named whole for a screen reader', async () => {
    await open('appearance');
    await click(byTestId('theme-schedule-edit'));
    const back = byTestId('schedule-back')!;
    expect(back.getAttribute('aria-label')).toBe('Back to Appearance');
    expect(back.textContent?.trim()).toBe('Appearance');
    await click(back);
    expect(byTestId('schedule-page')).toBeNull();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('theme-schedule-edit');
  });

  it('ends when a search starts and stays ended once the search is cleared', async () => {
    await open('appearance');
    await click(byTestId('theme-schedule-edit'));
    await type('schedule');
    expect(byTestId('schedule-page')).toBeNull();
    expect(byTestId('theme-schedule-edit')).not.toBeNull();
    await type('');
    expect(byTestId('schedule-page')).toBeNull();
    expect(byTestId('theme-gallery')).not.toBeNull();
  });

  it('ends when another section is chosen', async () => {
    await open('appearance');
    await click(byTestId('theme-schedule-edit'));
    await click(byTestId('settings-nav-editor'));
    await click(byTestId('settings-nav-appearance'));
    expect(byTestId('schedule-page')).toBeNull();
    expect(byTestId('theme-gallery')).not.toBeNull();
  });

  it("does not say the scope holds nothing under it on a remote chat's User tab", async () => {
    await open('appearance', { host: { name: 'Build box' }, active: 'user' });
    expect(byTestId('settings-scope-user')).not.toBeNull();
    await click(byTestId('theme-schedule-edit'));
    expect(byTestId('schedule-page')).not.toBeNull();
    expect(byTestId('settings-scope-empty')).toBeNull();
  });
});

describe('the Appearance rows whose description names a shortcut or a time', () => {
  const row = (id: string): string => byTestId(`settings-row-${id}`)?.textContent ?? '';

  it("names Toggle Wallpapers' shortcut as Windows writes it, and a search for the shortcut finds the row", async () => {
    await open('appearance');
    expect(row(SHOW_WALLPAPERS_SETTING)).toContain('Ctrl+Alt+Shift+W turns them off or on from anywhere.');
    await type('ctrl+alt+shift+w');
    expect(byTestId(`settings-row-${SHOW_WALLPAPERS_SETTING}`)).not.toBeNull();
    expect(byTestId(`settings-row-${THEMES_STORE_SETTING}`)).toBeNull();
  });

  it('names the shortcut as macOS writes it', async () => {
    vi.mocked(api.getState).mockResolvedValue({ locale: 'en', platform: 'darwin' });
    try {
      await open('appearance');
      expect(row(SHOW_WALLPAPERS_SETTING)).toContain('⌥⇧⌘W turns them off or on from anywhere.');
    } finally {
      vi.mocked(api.getState).mockResolvedValue({ locale: 'en', platform: 'win32' });
    }
  });

  it('says how long an on-the-fly change waits, from the countdown itself, in English and Greek', async () => {
    const seconds = KEEP_CHANGES_MS / 1000;
    await open('appearance');
    expect(row(THEMES_APPLY_MODE_SETTING)).toContain(`reverts after ${seconds} seconds unless you keep it.`);
    shellI18n.global.locale.value = 'el';
    await flushPromises();
    expect(row(THEMES_APPLY_MODE_SETTING)).toContain(`επανέρχεται μετά από ${seconds} δευτερόλεπτα, εκτός αν την κρατήσετε.`);
  });
});
