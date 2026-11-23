// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import type { LookColors, ThemeFile } from '@shared/themes/schema';
import type { OverlayStoreEntry, OverlayStoreResult, OverlayStoreView, OverlayThemes } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { shellI18n } from '../i18n';
import { installVisibilityObserver } from '../../../webview/__tests__/visibility-observer';
import { installPreview } from '../../../webview/components/theme/__tests__/install-preview';
import { FakeResizeObserver, fakeOverlayApi, opened } from './fakes';

// Settings › Appearance › Browse: the community store's states (loading, ok, cached, unreachable, refused, off, empty), entry
// texts as plain text, Install… and Update… through the install dialog with its toast, which answer or push shows when several
// arrive, and the gallery cards' store marks.
const api = fakeOverlayApi();
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

const STORE_SETTING = 'damocles.desktop.themes.store';
const FETCHED = Date.UTC(2026, 5, 3, 9, 12);
const DARK: LookColors = { background: '#1a1033', panel: '#24154a', text: '#f4e9ff', accent: '#ff7a59', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const LIGHT: LookColors = { background: '#fbf3e4', panel: '#f1e4cc', text: '#2a1d12', accent: '#b4532a', success: '#2f6b3a', warning: '#8a5a00', danger: '#a12a2a', info: '#2d5a99' };
const OCEAN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function entry(overrides: Partial<OverlayStoreEntry>): OverlayStoreEntry {
  return {
    id: 'synthwave-sunset', name: 'Synthwave Sunset', author: 'retroline', description: 'Orange and sand on deep teal, with a window arrangement for wide screens.',
    kinds: ['dark', 'light'], version: '1.0.0', colors: { dark: DARK, light: LIGHT }, fonts: [], licenses: ['Apache-2.0'],
    hasCss: true, hasLayout: true, hasCharacters: false, hasMoving: false, minAppVersion: '3.0.0', thumbnails: {}, status: 'available',
    ...overrides,
  };
}

const ENTRIES: OverlayStoreEntry[] = [
  entry({}),
  entry({ id: 'ocean-depths', name: 'Ocean Depths', author: 'tidal', description: 'Deep navy with seafoam accents.', kinds: ['dark'], colors: { dark: DARK }, version: '1.3', licenses: ['MIT'], hasCss: false, hasLayout: false, status: 'update', installedThemeId: OCEAN_ID, installedVersion: '1.2' }),
  entry({ id: 'golden-hour', name: 'Golden Hour', author: 'lumen', description: 'A light theme in warm beige and terracotta.', kinds: ['light'], colors: { light: LIGHT }, hasCss: false, hasLayout: false, status: 'installed', installedThemeId: 'golden-id' }),
  entry({ id: 'neon-grid', name: 'Neon Grid', author: 'cyberdesk', description: 'Cyan on near-black, for late nights.', kinds: ['dark'], colors: { dark: DARK }, hasCss: false, hasLayout: false, hasMoving: true, minAppVersion: '9.0.0', status: 'needsNewerApp' }),
  entry({ id: 'pixel-pals', name: '<img src=x onerror=alert(1)>Pixel Pals', author: '8bitdesk', description: '<b>Six</b> characters', hasCss: false, hasLayout: false, hasCharacters: true, thumbnails: { dark: [{ panel: 'chat', url: `app://damocles/store-thumb/${'a'.repeat(64)}` }] } }),
];
const view = (overrides: Partial<OverlayStoreView> = {}): OverlayStoreView => ({ state: 'ok', fetchedAt: FETCHED, entries: ENTRIES, ...overrides });

const ocean: ThemeFile = { schemaVersion: 1, id: OCEAN_ID, name: 'Ocean Depths', looks: { dark: { colors: DARK } }, origin: { kind: 'store', store: { entryId: 'ocean-depths', version: '1.2', sha256: 'b'.repeat(64) }, installedAt: 0 } };
const sunset: ThemeFile = { schemaVersion: 1, id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', name: 'Sunset Boulevard', looks: { dark: { colors: DARK } }, origin: { kind: 'store', store: { entryId: 'sunset-boulevard', version: '2.0', sha256: 'c'.repeat(64) }, installedAt: 0 } };
const THEMES: OverlayThemes = {
  themes: [
    { status: 'ok', id: BUILTIN_THEME.id, name: BUILTIN_THEME.name, builtin: true, theme: BUILTIN_THEME },
    { status: 'ok', id: OCEAN_ID, name: 'Ocean Depths', builtin: false, theme: ocean, storeUpdate: { version: '1.3' } },
    { status: 'ok', id: sunset.id, name: 'Sunset Boulevard', builtin: false, theme: sunset, removedFromStore: { reason: 'the <b>wallpaper</b> was used without the artist\'s permission.<img src=x onerror=alert(1)>' } },
  ],
  shown: { themeId: 'damocles', kind: 'dark', decidedBy: 'system' },
  preferred: { dark: 'damocles', light: 'damocles' },
  mode: 'system',
  schedule: { schedule: { enabled: false, rules: [] }, now: 0, zone: 'UTC', osKind: 'dark', systemLocale: 'en-GB' },
  history: [],
};

const mounted: VueWrapper[] = [];

async function openAppearance(): Promise<void> {
  vi.mocked(api.getThemes).mockResolvedValue(opened({ ok: true as const, ...THEMES }));
  const wrapper = mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  api.request('s1', { kind: 'settings', generation: 1, section: 'appearance' });
  await flushPromises();
  await flushPromises();
}

async function openBrowse(listed: OverlayStoreView | Promise<never> = view()): Promise<void> {
  if (listed instanceof Promise) vi.mocked(api.storeList).mockReturnValueOnce(listed);
  else vi.mocked(api.storeList).mockResolvedValueOnce(opened<OverlayStoreResult>({ ok: true, view: listed }));
  await openAppearance();
  // reka's tab triggers select on a left mousedown
  byTestId('theme-tab-browse')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  await flushPromises();
}

const byTestId = (id: string, root: ParentNode = document): HTMLElement | null => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const browse = (): HTMLElement => byTestId('theme-browse')!;
const buttonNamed = (name: string, root: ParentNode = document): HTMLButtonElement | undefined =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name);
const headings = (): string[] => [...browse().querySelectorAll('h3')].map((heading) => heading.textContent?.trim() ?? '');

async function click(element: HTMLElement | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  element!.click();
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  installVisibilityObserver(true);
  for (const fn of [api.storeList, api.storeInstall, api.cancelPrepare, api.installCommit, api.setPref]) vi.mocked(fn).mockClear();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Browse states', () => {
  it('shows skeleton cards while the list loads, then the entries, and lists with the day-old cache on open', async () => {
    let answer: (value: Awaited<ReturnType<typeof api.storeList>>) => void = () => undefined;
    vi.mocked(api.storeList).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await openAppearance();
    byTestId('theme-tab-browse')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    await flushPromises();
    expect(api.storeList).toHaveBeenCalledWith(false);
    const loading = byTestId('theme-browse-loading')!;
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.getAttribute('aria-label')).toBe('Loading community themes');
    expect(loading.querySelector('[role="status"]')!.textContent?.trim()).toBe('Loading the community list…');
    answer(opened<OverlayStoreResult>({ ok: true, view: view() }));
    await flushPromises();
    expect(byTestId('theme-browse-loading')).toBeNull();
    expect(browse().querySelectorAll('[data-testid="theme-browse-entry"]')).toHaveLength(ENTRIES.length);
  });

  it('names when the signed list was checked, and Check for updates forces a fetch', async () => {
    await openBrowse();
    const time = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(FETCHED);
    expect(byTestId('theme-browse-checked')!.textContent).toContain(`Signed community list, checked ${time}.`);
    expect(byTestId('theme-browse-cached')).toBeNull();
    vi.mocked(api.storeList).mockResolvedValueOnce(opened<OverlayStoreResult>({ ok: true, view: view() }));
    await click(buttonNamed('Check for updates'));
    expect(api.storeList).toHaveBeenLastCalledWith(true);
  });

  it('cached: says the check failed and why core said it did, never that you are offline, and Install still works', async () => {
    await openBrowse(view({ state: 'cached', refusedReason: 'Damocles could not fetch the community store list: GitHub answered HTTP 503.' }));
    const time = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(FETCHED);
    const banner = byTestId('theme-browse-cached')!;
    expect(banner.textContent?.replace(/\s+/g, ' ').trim()).toContain(`Couldn't check for updates. Damocles could not fetch the community store list: GitHub answered HTTP 503. Showing the list saved on ${time}. You can still install from it.`);
    expect(banner.textContent).not.toMatch(/offline/i);
    expect(byTestId('theme-browse-checked')).toBeNull();
    const install = buttonNamed('Install Synthwave Sunset')!;
    expect(install.hasAttribute('aria-disabled')).toBe(false);
    await click(install);
    expect(api.storeInstall).toHaveBeenCalledWith('synthwave-sunset');
  });

  it('cached with no entries: says the list holds no themes, not that none match the filters', async () => {
    await openBrowse(view({ state: 'cached', refusedReason: 'GitHub answered HTTP 503.', entries: [] }));
    expect(byTestId('theme-browse-cached')).not.toBeNull();
    expect(byTestId('theme-browse-empty')!.textContent).toContain('No community themes yet');
    expect(byTestId('theme-browse-none')).toBeNull();
    expect(buttonNamed('Clear search and filters')).toBeUndefined();
  });

  it('refused: shows the reason core gave and nothing of the list, and Try again fetches', async () => {
    await openBrowse({ state: 'refused', refusedReason: 'The list expired on 1 June 2026.', entries: [] });
    const refused = byTestId('theme-browse-refused')!;
    expect(refused.getAttribute('role')).toBe('alert');
    expect(refused.textContent).toContain('The community list didn\'t pass its checks');
    expect(byTestId('theme-browse-refused-reason')!.textContent?.trim()).toBe('The list expired on 1 June 2026.');
    expect(browse().querySelectorAll('[data-testid="theme-browse-entry"]')).toHaveLength(0);
    vi.mocked(api.storeList).mockResolvedValueOnce(opened<OverlayStoreResult>({ ok: true, view: view() }));
    await click(buttonNamed('Try again', refused));
    expect(api.storeList).toHaveBeenLastCalledWith(true);
    expect(browse().querySelectorAll('[data-testid="theme-browse-entry"]')).toHaveLength(ENTRIES.length);
  });

  it('unreachable with no cache: says so with the reason and offers Try again', async () => {
    await openBrowse({ state: 'unreachable', refusedReason: 'GitHub could not be reached.', entries: [] });
    const unreachable = byTestId('theme-browse-unreachable')!;
    expect(unreachable.textContent).toContain('Damocles couldn\'t get the community list');
    expect(byTestId('theme-browse-unreachable-reason')!.textContent?.trim()).toBe('GitHub could not be reached.');
    expect(buttonNamed('Try again', unreachable)).toBeDefined();
  });

  it('off: Turn on the store writes the setting and lists again once main wrote it', async () => {
    await openBrowse({ state: 'off', entries: [] });
    expect(byTestId('theme-browse-off')!.textContent).toContain('The community store is off');
    expect(buttonNamed('Install from link…', byTestId('theme-browse-off')!)).toBeDefined();
    let answer: (value: Awaited<ReturnType<typeof api.storeList>>) => void = () => undefined;
    vi.mocked(api.storeList).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await click(buttonNamed('Turn on the store'));
    expect(api.setPref).toHaveBeenCalledWith(STORE_SETTING, true);
    expect(api.storeList).toHaveBeenLastCalledWith(false);
    // the list is on its way: the skeleton shows, not the off panel
    expect(byTestId('theme-browse-off')).toBeNull();
    expect(byTestId('theme-browse-loading')).not.toBeNull();
    answer(opened<OverlayStoreResult>({ ok: true, view: view() }));
    await flushPromises();
    expect(byTestId('theme-browse-loading')).toBeNull();
    expect(byTestId('theme-browse-off')).toBeNull();
    expect(browse().querySelectorAll('[data-testid="theme-browse-entry"]')).toHaveLength(ENTRIES.length);
  });

  it('empty: a verified list with no entries says so and offers Check for updates', async () => {
    await openBrowse(view({ entries: [], state: 'empty' }));
    expect(byTestId('theme-browse-empty')!.textContent).toContain('No community themes yet');
    expect(buttonNamed('Check for updates', byTestId('theme-browse-empty')!)).toBeDefined();
  });

  it('a failed call shows main\'s error, never an empty Browse', async () => {
    vi.mocked(api.storeList).mockResolvedValueOnce(opened<OverlayStoreResult>({ ok: false, error: 'Damocles\' core is not running.' }));
    await openAppearance();
    byTestId('theme-tab-browse')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    await flushPromises();
    expect(byTestId('theme-browse-error')!.textContent?.trim()).toBe('Damocles\' core is not running.');
  });

  it('a failed check keeps the list it showed and says what failed above it', async () => {
    await openBrowse();
    vi.mocked(api.storeList).mockResolvedValueOnce(opened<OverlayStoreResult>({ ok: false, error: 'Damocles\' core is not running.' }));
    await click(buttonNamed('Check for updates'));
    expect(byTestId('theme-browse-error')!.textContent?.trim()).toBe('Damocles\' core is not running.');
    expect(browse().querySelectorAll('[data-testid="theme-browse-entry"]')).toHaveLength(ENTRIES.length);
  });

  it('ignores a view pushed while a request is in flight; the request\'s answer shows', async () => {
    await openBrowse();
    let answer: (value: Awaited<ReturnType<typeof api.storeList>>) => void = () => undefined;
    vi.mocked(api.storeList).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await click(buttonNamed('Check for updates'));
    api.storeUpdated(view({ state: 'empty', entries: [] }));
    await flushPromises();
    expect(browse().querySelectorAll('[data-testid="theme-browse-entry"]')).toHaveLength(ENTRIES.length);
    answer(opened<OverlayStoreResult>({ ok: true, view: view({ entries: ENTRIES.slice(0, 2) }) }));
    await flushPromises();
    expect(browse().querySelectorAll('[data-testid="theme-browse-entry"]')).toHaveLength(2);
    // with no request in flight a push shows
    api.storeUpdated(view({ entries: ENTRIES.slice(0, 1) }));
    await flushPromises();
    expect(browse().querySelectorAll('[data-testid="theme-browse-entry"]')).toHaveLength(1);
  });

  it('a slower answer to an older request never replaces the newer request\'s answer', async () => {
    await openBrowse();
    let older: (value: Awaited<ReturnType<typeof api.storeList>>) => void = () => undefined;
    vi.mocked(api.storeList).mockReturnValueOnce(new Promise((resolve) => (older = resolve)));
    await click(buttonNamed('Check for updates'));
    // the setting's switch lists again while that check is still out
    vi.mocked(api.storeList).mockResolvedValueOnce(opened<OverlayStoreResult>({ ok: true, view: view({ entries: ENTRIES.slice(0, 2) }) }));
    await click(document.querySelector<HTMLElement>('[role="switch"][aria-label="Community store"]'));
    expect(api.storeList).toHaveBeenCalledTimes(3);
    expect(browse().querySelectorAll('[data-testid="theme-browse-entry"]')).toHaveLength(2);
    older(opened<OverlayStoreResult>({ ok: true, view: view() }));
    await flushPromises();
    expect(browse().querySelectorAll('[data-testid="theme-browse-entry"]')).toHaveLength(2);
  });
});

describe('Browse entries', () => {
  it('renders entry texts as plain text and draws each miniature from its own colors and verified thumbnails', async () => {
    await openBrowse();
    expect(browse().querySelector('img')).toBeNull();
    expect(browse().querySelector('b')).toBeNull();
    expect(headings()).toContain('<img src=x onerror=alert(1)>Pixel Pals');
    expect(browse().textContent).toContain('<b>Six</b> characters');
    const minis = [...browse().querySelectorAll('[data-testid="theme-miniature"]')].map((element) => element.getAttribute('aria-label'));
    expect(minis).toEqual(['Synthwave Sunset, dark and light looks', 'Ocean Depths, dark look', 'Golden Hour, light look', 'Neon Grid, dark look', '<img src=x onerror=alert(1)>Pixel Pals, dark and light looks']);
    const sunset = browse().querySelectorAll('[data-testid="theme-miniature"]')[0]!;
    expect(sunset.querySelector('g')!.getAttribute('style')).toContain(`--m-bg: ${DARK.background};`);
    expect(sunset.querySelector('image')).toBeNull();
    const pals = browse().querySelectorAll('[data-testid="theme-miniature"]')[4]!;
    expect([...pals.querySelectorAll('image')].map((image) => image.getAttribute('href'))).toEqual([`app://damocles/store-thumb/${'a'.repeat(64)}`]);
  });

  it('offers Install, Update, an Installed badge or a disabled Needs a newer Damocles by status', async () => {
    await openBrowse();
    expect(buttonNamed('Install Synthwave Sunset')!.textContent?.trim()).toBe('Install…');
    expect(buttonNamed('Update Ocean Depths')!.textContent?.trim()).toBe('Update…');
    expect(browse().textContent).toContain('Update 1.3');
    const golden = [...browse().querySelectorAll('[data-testid="theme-browse-entry"]')].find((card) => card.textContent?.includes('Golden Hour'))!;
    expect(byTestId('theme-browse-installed', golden)!.textContent?.trim()).toBe('Installed');
    expect(golden.querySelector('button')).toBeNull();
    const newer = byTestId('theme-browse-needs-newer')!;
    expect(newer.textContent?.trim()).toBe('Needs a newer Damocles');
    expect(newer.getAttribute('aria-disabled')).toBe('true');
    expect(newer.title).toBe('Made for Damocles 9.0.0 or newer. Update Damocles to install it.');
    // the reason is also a description a keyboard and a screen reader reach
    expect(document.getElementById(newer.getAttribute('aria-describedby')!)!.textContent?.trim()).toBe('Made for Damocles 9.0.0 or newer. Update Damocles to install it.');
    await click(newer);
    expect(api.storeInstall).not.toHaveBeenCalled();
  });

  it('searches names, authors, descriptions and colors, and clears search and filters', async () => {
    await openBrowse();
    const search = browse().querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(document.querySelector(`label[for="${search.id}"]`)!.textContent?.trim()).toBe('Search community themes');
    const searchFor = async (text: string): Promise<void> => {
      search.value = text;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await flushPromises();
    };
    await searchFor('zzz');
    expect(headings()).toEqual(['No themes matched “zzz”']);
    await click(buttonNamed('Clear search and filters'));
    expect(search.value).toBe('');
    expect(headings()).toContain('Synthwave Sunset');
    await searchFor('TIDAL');
    expect(headings()).toEqual(['Ocean Depths']);
    await searchFor(LIGHT.accent);
    expect(headings()).toEqual(['Synthwave Sunset', 'Golden Hour', '<img src=x onerror=alert(1)>Pixel Pals']);
    await searchFor('');
    const filter = (name: string): HTMLButtonElement | undefined => buttonNamed(name, browse().querySelector('[role="group"]')!);
    await click(filter('Characters'));
    expect(filter('Characters')!.getAttribute('aria-pressed')).toBe('true');
    expect(headings()).toEqual(['<img src=x onerror=alert(1)>Pixel Pals']);
    await click(filter('Characters'));
    await click(filter('Moving wallpaper'));
    expect(headings()).toEqual(['Neon Grid']);
    await click(filter('Light'));
    expect(headings()).toEqual(['No themes match these filters']);
    await click(buttonNamed('Clear search and filters'));
    expect(headings()).toHaveLength(ENTRIES.length);
    expect(filter('Moving wallpaper')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('Install… opens the install dialog; after Install the toast confirms and the entry shows Installed', async () => {
    await openBrowse();
    vi.mocked(api.storeInstall).mockResolvedValueOnce(opened({ ok: true as const, preview: installPreview({
      source: { kind: 'store', host: 'e2e.test', fileName: 'synthwave-sunset.damocles-theme' },
      about: { name: 'Synthwave Sunset', author: 'retroline', license: 'Apache-2.0' },
      store: { entryId: 'synthwave-sunset', version: '1.0.0' },
    }) }));
    await click(buttonNamed('Install Synthwave Sunset'));
    expect(api.storeInstall).toHaveBeenCalledWith('synthwave-sunset');
    const dialog = byTestId('theme-install-dialog')!;
    expect(dialog.textContent).toContain('Install “Synthwave Sunset”?');
    expect(byTestId('theme-install-source', dialog)!.textContent?.trim()).toBe('From the community store, by retroline. The file matched the signed list.');
    expect(byTestId('theme-install-host', dialog)).toBeNull();
    expect(byTestId('theme-install-your-edits', dialog)).toBeNull();
    vi.mocked(api.installCommit).mockResolvedValueOnce(opened({ ok: true as const, installed: { themeId: 'new-id', name: 'Synthwave Sunset', replaced: false } }));
    await click(byTestId('theme-install-go'));
    expect(api.installCommit).toHaveBeenCalledWith({ installId: 'install-1', useArrangement: false });
    expect(byTestId('theme-toast')!.textContent).toContain('Installed Synthwave Sunset. Pick it as your dark or light look on Installed.');
    // core recomputes the view after the theme write and main pushes it
    api.storeUpdated(view({ entries: ENTRIES.map((candidate) => (candidate.id === 'synthwave-sunset' ? { ...candidate, status: 'installed' as const, installedThemeId: 'new-id' } : candidate)) }));
    await flushPromises();
    expect(buttonNamed('Install Synthwave Sunset')).toBeUndefined();
    const card = [...browse().querySelectorAll('[data-testid="theme-browse-entry"]')].find((candidate) => candidate.textContent?.includes('Synthwave Sunset'))!;
    expect(byTestId('theme-browse-installed', card)!.textContent?.trim()).toBe('Installed');
  });

  it('Update… notes the your-edits copy, and the toast names the update and the copy', async () => {
    await openBrowse();
    vi.mocked(api.storeInstall).mockResolvedValueOnce(opened({ ok: true as const, preview: installPreview({
      source: { kind: 'store', host: 'e2e.test', fileName: 'ocean-depths.damocles-theme' },
      about: { name: 'Ocean Depths', author: 'tidal', license: 'MIT' },
      arrangement: false,
      store: { entryId: 'ocean-depths', version: '1.3', update: { themeId: OCEAN_ID, fromVersion: '1.2', yourEditsName: 'Ocean Depths (your edits)' } },
    }) }));
    await click(buttonNamed('Update Ocean Depths'));
    expect(api.storeInstall).toHaveBeenCalledWith('ocean-depths');
    const dialog = byTestId('theme-install-dialog')!;
    expect(dialog.textContent).toContain('Update “Ocean Depths” to 1.3?');
    expect(byTestId('theme-install-your-edits', dialog)!.textContent?.trim()).toBe('Your own edits to this theme are kept as a copy named “Ocean Depths (your edits)”.');
    expect(byTestId('theme-install-go')!.textContent?.trim()).toBe('Update');
    vi.mocked(api.installCommit).mockResolvedValueOnce(opened({ ok: true as const, installed: { themeId: OCEAN_ID, name: 'Ocean Depths', replaced: true, keptCopy: { themeId: 'copy-id', name: 'Ocean Depths (your edits)' } } }));
    await click(byTestId('theme-install-go'));
    expect(byTestId('theme-toast')!.textContent).toContain('Updated Ocean Depths. Pick it as your dark or light look on Installed. Your edited version is kept as “Ocean Depths (your edits)”.');
  });

  it('an update with no edits to keep has no your-edits note', async () => {
    await openBrowse();
    vi.mocked(api.storeInstall).mockResolvedValueOnce(opened({ ok: true as const, preview: installPreview({
      source: { kind: 'store', host: 'e2e.test', fileName: 'ocean-depths.damocles-theme' },
      about: { name: 'Ocean Depths', author: 'tidal' },
      store: { entryId: 'ocean-depths', version: '1.3', update: { themeId: OCEAN_ID, fromVersion: '1.2' } },
    }) }));
    await click(buttonNamed('Update Ocean Depths'));
    expect(byTestId('theme-install-dialog')!.textContent).toContain('Update “Ocean Depths” to 1.3?');
    expect(byTestId('theme-install-your-edits')).toBeNull();
  });

  it('while one entry downloads, offers its Cancel, holds the other buttons with the reason, and a cancelled download says nothing', async () => {
    await openBrowse();
    let answer: (value: Awaited<ReturnType<typeof api.storeInstall>>) => void = () => undefined;
    vi.mocked(api.storeInstall).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    await click(buttonNamed('Install Synthwave Sunset'));
    expect(buttonNamed('Install Synthwave Sunset')).toBeUndefined();
    const update = buttonNamed('Update Ocean Depths')!;
    expect(update.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(update.getAttribute('aria-describedby')!)!.textContent?.trim()).toBe('Another theme is downloading. Wait for it to finish, or cancel it.');
    await click(update);
    expect(api.storeInstall).toHaveBeenCalledTimes(1);
    const cancel = buttonNamed('Cancel the download of Synthwave Sunset')!;
    expect(cancel.textContent?.trim()).toBe('Cancel');
    await click(cancel);
    expect(api.cancelPrepare).toHaveBeenCalledTimes(1);
    answer(opened({ ok: false as const, cancelled: true as const }));
    await flushPromises();
    expect(buttonNamed('Install Synthwave Sunset')!.hasAttribute('aria-disabled')).toBe(false);
    expect(buttonNamed('Update Ocean Depths')!.hasAttribute('aria-describedby')).toBe(false);
    expect(byTestId('theme-error')).toBeNull();
    expect(byTestId('theme-install-dialog')).toBeNull();
  });

  it('a refused download shows main\'s reason and opens no dialog', async () => {
    await openBrowse();
    vi.mocked(api.storeInstall).mockResolvedValueOnce(opened({ ok: false as const, error: 'The downloaded file does not match the signed list.' }));
    await click(buttonNamed('Install Synthwave Sunset'));
    expect(byTestId('theme-error')!.textContent?.trim()).toBe('The downloaded file does not match the signed list.');
    expect(byTestId('theme-install-dialog')).toBeNull();
  });
});

describe('gallery cards from the store', () => {
  it('offers Update… on a theme whose entry has another version, through the same dialog', async () => {
    await openAppearance();
    const card = byTestId(`theme-card-${OCEAN_ID}`)!;
    expect(card.textContent).toContain('From the store · 1.2');
    expect(byTestId('theme-card-update', card)!.textContent).toContain('Update 1.3 is available. Your own edits are kept as a copy.');
    vi.mocked(api.storeInstall).mockResolvedValueOnce(opened({ ok: false as const, error: 'Offline.' }));
    await click(buttonNamed('Update Ocean Depths to 1.3', card));
    expect(api.storeInstall).toHaveBeenCalledWith('ocean-depths');
  });

  it('marks a theme removed from the store with the reason as plain text and offers Delete', async () => {
    await openAppearance();
    const card = byTestId(`theme-card-${sunset.id}`)!;
    const removed = byTestId('theme-card-removed', card)!;
    expect(removed.textContent).toContain('Removed from the store: the <b>wallpaper</b> was used without the artist\'s permission.<img src=x onerror=alert(1)>');
    expect(removed.querySelector('b, img')).toBeNull();
    await click(buttonNamed('Delete Sunset Boulevard', byTestId('theme-card-removed', card)!));
    expect(byTestId('theme-delete')!.textContent).toContain('Delete “Sunset Boulevard”?');
  });
});
