// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import type { ThemeHistoryChange, ThemeHistoryEntry } from '@shared/themes/changes';
import type { LookColors, ThemeFile } from '@shared/themes/schema';
import type { OverlayThemeEntry, OverlayThemes, OverlayThemesResult } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { PICK_REST_MS } from '../overlay/settings/themes/ThemeGallery.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi, opened } from './fakes';

// Settings › Appearance's gallery: one card per theme, whose Dark and Light picks form the "Dark look" and "Light look" radio
// groups across cards (aria-owns), named by theme, kind and state, moved through with the arrow keys.
const api = fakeOverlayApi();
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

const NIGHT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BLEACH = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BROKEN = 'a1b2c3d4-0000-4000-8000-000000000001';
const MISSING = 'a1b2c3d4-0000-4000-8000-000000000009';
const COLORS: LookColors = { background: '#141413', panel: '#262624', text: '#f0eee6', accent: '#d97757', success: '#788c5d', warning: '#f0b429', danger: '#f2555a', info: '#6a9bcc' };
const theme = (id: string, name: string, kinds: ReadonlyArray<'dark' | 'light'>): ThemeFile => ({ schemaVersion: 1, id, name, looks: Object.fromEntries(kinds.map((kind) => [kind, { colors: COLORS }])) });
const ok = (file: ThemeFile, builtin = false): OverlayThemeEntry => ({ status: 'ok', id: file.id, name: file.name, builtin, theme: file });
const manyId = (i: number): string => `0f8fad5b-d9cb-469f-a165-${String(i).padStart(12, '0')}`;
const many = (): OverlayThemeEntry[] => Array.from({ length: 40 }, (_, i) => ok(theme(manyId(i), `Theme ${String(i).padStart(2, '0')}`, ['dark'])));
const BROKEN_ENTRY: OverlayThemeEntry = { status: 'broken', id: BROKEN, name: 'Night shift', reason: 'theme.json could not be read' };
const entry = (id: string, change: ThemeHistoryChange, more: Partial<ThemeHistoryEntry> = {}): ThemeHistoryEntry => ({ id, at: 0, actor: { kind: 'user' }, change, ...more });
const PICKED_BLEACH: ThemeHistoryChange = { kind: 'pick', look: 'dark', theme: 'Bleach', was: 'Damocles' };

function themes(overrides: Partial<OverlayThemes> = {}): OverlayThemes {
  return {
    themes: [ok(BUILTIN_THEME, true), ok(theme(BLEACH, 'Bleach', ['dark', 'light'])), ok(theme(NIGHT, 'Night', ['dark'])), BROKEN_ENTRY],
    shown: { themeId: 'damocles', kind: 'dark', decidedBy: 'system' },
    preferred: { dark: 'damocles', light: 'damocles' },
    mode: 'system',
    schedule: { schedule: { enabled: false, rules: [] }, now: 0, zone: 'UTC', osKind: 'dark', systemLocale: 'en-GB' },
    history: [],
    ...overrides,
  };
}

const mounted: VueWrapper[] = [];
// main's push that the theme files changed
let themesChanged: () => void = () => undefined;
const listed = (data: OverlayThemes): void => {
  vi.mocked(api.getThemes).mockResolvedValue(opened({ ok: true as const, ...data }));
};

async function openSettings(): Promise<void> {
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

async function openAppearance(data: OverlayThemes): Promise<void> {
  listed(data);
  await openSettings();
}

const byTestId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const radio = (name: string): HTMLElement | undefined => [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((element) => element.getAttribute('aria-label') === name);
const group = (name: string): HTMLElement => document.querySelector<HTMLElement>(`[role="radiogroup"][aria-label="${name}"]`)!;
const cardIds = (): string[] => [...document.querySelectorAll('[data-testid="theme-grid"] article')].map((card) => card.getAttribute('data-testid')!.slice('theme-card-'.length));
const key = (element: Element, name: string, init: KeyboardEventInit = {}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  element.dispatchEvent(event);
  return event;
};
const picks = (): unknown[] => vi.mocked(api.themeAction).mock.calls.map(([action]) => action).filter((action) => action.action === 'pick');

async function click(element: Element | null | undefined): Promise<void> {
  expect(element).toBeTruthy();
  (element as HTMLElement).click();
  await flushPromises();
}

/** The More menu of the card named `name`, opened from its trigger with Enter. */
async function openMenu(name: string): Promise<HTMLElement[]> {
  key(document.querySelector<HTMLElement>(`[aria-label="More actions for ${name}"]`)!, 'Enter');
  await flushPromises();
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}
const menuItems = async (name: string): Promise<string[]> => (await openMenu(name)).map((item) => item.textContent?.trim() ?? '');

// The settings content as the gallery's scroller, `height` px tall, with the grid at its top edge; happy-dom lays nothing out.
function scrollerOf(height: number): HTMLElement {
  const scroller = document.querySelector<HTMLElement>('.sm-content')!;
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: height });
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 0 });
  byTestId('theme-grid')!.getBoundingClientRect = () => new DOMRect(0, -scroller.scrollTop, 0, 0);
  return scroller;
}

async function scrollTo(scroller: HTMLElement, top: number): Promise<void> {
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event('scroll'));
  await flushPromises();
}

// Reports each rendered row's height to whatever observes it, as layout passes would until nothing moves.
async function measureRows(heightOf: (row: Element) => number, passes = 1): Promise<void> {
  for (let pass = 0; pass < passes; pass++) {
    const grid = byTestId('theme-grid')!;
    for (const observer of FakeResizeObserver.instances) {
      const rows = observer.observed.filter((element) => element.parentElement === grid && element.isConnected);
      if (rows.length > 0) (observer.callback as unknown as (entries: unknown[]) => void)(rows.map((target) => ({ target, contentRect: { height: heightOf(target) } })));
    }
    await flushPromises();
  }
}

beforeEach(() => {
  setActivePinia(createPinia());
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  document.head.innerHTML = '<style>.sm-content { overflow-y: auto; }</style>';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.mocked(api.themeAction).mockReset();
  vi.mocked(api.themeAction).mockResolvedValue(opened({ ok: true as const }));
  vi.mocked(api.getThemes).mockReset();
  vi.mocked(api.onThemesChanged).mockImplementation((listener) => {
    themesChanged = listener;
    return () => undefined;
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('theme gallery', () => {
  it("owns every pick of a kind in that kind's radio group, across cards, and a theme that cannot be used as disabled radios", async () => {
    await openAppearance(themes());
    expect(group('Dark look').getAttribute('aria-owns')!.split(' ')).toEqual(['theme-pick-dark-damocles', `theme-pick-dark-${BLEACH}`, `theme-pick-dark-${NIGHT}`, 'theme-pick-dark-unusable-1']);
    expect(group('Light look').getAttribute('aria-owns')!.split(' ')).toEqual(['theme-pick-light-damocles', `theme-pick-light-${BLEACH}`, 'theme-pick-light-unusable-1']);
    for (const id of group('Dark look').getAttribute('aria-owns')!.split(' ')) expect(document.getElementById(id)?.getAttribute('role'), id).toBe('radio');
    expect(document.getElementById('theme-pick-dark-unusable-1')!.getAttribute('aria-disabled')).toBe('true');
    expect(byTestId(`theme-card-${NIGHT}`)!.textContent).toContain('No light look');
  });

  it('names each pick by theme, kind and state: active while it shows, selected while pressed but not shown', async () => {
    await openAppearance(themes({ preferred: { dark: 'damocles', light: BLEACH } }));
    expect(radio('Damocles, dark, active')!.getAttribute('aria-checked')).toBe('true');
    expect(radio('Bleach, light, selected')!.getAttribute('aria-checked')).toBe('true');
    expect(radio('Bleach, dark')!.getAttribute('aria-checked')).toBe('false');
    expect(radio('Damocles, light')!.getAttribute('aria-checked')).toBe('false');
    // one tab stop per group: its pressed pick
    expect(radio('Damocles, dark, active')!.tabIndex).toBe(0);
    expect(radio('Bleach, dark')!.tabIndex).toBe(-1);
    expect(radio(`Bleach, light, selected`)!.tabIndex).toBe(0);
    expect(document.querySelector('[data-testid="theme-card-damocles"] [data-testid="theme-showing"]')).not.toBeNull();
    expect(document.querySelector(`[data-testid="theme-card-${BLEACH}"] [data-testid="theme-showing"]`)).toBeNull();
    expect(byTestId('theme-mode-status')!.textContent).toContain('Showing Damocles, dark look. The computer is in dark mode. Your light look, Bleach, shows while the computer is in light mode.');
  });

  it("names the selected project's own look as what decides on the Mode row, and its touches on top of whatever decides", async () => {
    await openAppearance(themes({ shown: { themeId: BLEACH, kind: 'light', decidedBy: 'project' } }));
    expect(byTestId('theme-mode-status')!.textContent).toContain("Showing Bleach, light look: the selected project's own look.");
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    document.body.innerHTML = '';
    await openAppearance(themes({ shown: { themeId: 'damocles', kind: 'dark', decidedBy: 'system', touched: true } }));
    expect(byTestId('theme-mode-status')!.textContent).toContain("Showing Damocles, dark look. The computer is in dark mode. Your light look, Damocles, shows while the computer is in light mode. The selected project's own look adds touches on top.");
  });

  // a name written right to left would take the comma, the numbers and the words beside it into its own run
  it('isolates a right-to-left theme name on its card, in the Mode row and in the History dialog, and keeps the text free of direction marks', async () => {
    const name = 'ליל 2';
    await openAppearance(themes({
      themes: [ok(BUILTIN_THEME, true), ok(theme(NIGHT, name, ['dark']))],
      shown: { themeId: NIGHT, kind: 'dark', decidedBy: 'project' },
      history: [entry('e1', { kind: 'rename', theme: name, was: 'Night' })],
    }));
    const runs = (root: Element | null): string[] => [...(root?.querySelectorAll('bdi') ?? [])].map((run) => run.textContent ?? '');
    const status = byTestId('theme-mode-status')!;
    expect(runs(status)).toEqual([name]);
    expect(status.textContent).toContain(`Showing ${name}, dark look: the selected project's own look.`);
    expect(runs(document.querySelector(`[data-testid="theme-card-${NIGHT}"] h3`))).toEqual([name]);
    await click(byTestId('theme-history-open'));
    const row = byTestId('theme-history-e1')!;
    expect(runs(row)).toEqual(['Night', name]);
    expect(document.body.textContent).not.toMatch(/[\u2066-\u2069]/);
    // an accessible name is read, never laid out, so it carries no mark
    expect([...document.querySelectorAll('[aria-label]')].some((element) => /[\u2066-\u2069]/.test(element.getAttribute('aria-label')!))).toBe(false);
  });

  it('says on the Mode row that the theme is paused for the run, whatever started the run with the default theme', async () => {
    await openAppearance(themes({ shown: { themeId: 'damocles', kind: 'dark', decidedBy: 'safeStart' } }));
    expect(byTestId('theme-mode-status')!.textContent?.trim()).toBe('Showing Damocles, dark look: your theme is paused for this run.');
  });

  it('says on the Mode row that a Windows contrast theme decides the look, in the kind it shows', async () => {
    await openAppearance(themes({ shown: { themeId: 'damocles', kind: 'dark', decidedBy: 'forcedColors' } }));
    expect(byTestId('theme-mode-status')!.textContent?.trim()).toBe("Windows contrast themes are on, so Damocles' own dark look shows.");
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    document.body.innerHTML = '';
    await openAppearance(themes({ shown: { themeId: 'damocles', kind: 'light', decidedBy: 'forcedColors' } }));
    expect(byTestId('theme-mode-status')!.textContent?.trim()).toBe("Windows contrast themes are on, so Damocles' own light look shows.");
  });

  it('moves focus with each arrow key across cards and makes one pick once the keys rest', async () => {
    await openAppearance(themes());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    radio('Damocles, dark, active')!.focus();
    expect(key(document.activeElement!, 'ArrowRight').defaultPrevented).toBe(true);
    await flushPromises();
    expect(document.activeElement?.id).toBe(`theme-pick-dark-${BLEACH}`);
    vi.advanceTimersByTime(PICK_REST_MS - 1);
    key(document.activeElement!, 'ArrowRight');
    await flushPromises();
    expect(document.activeElement?.id).toBe(`theme-pick-dark-${NIGHT}`);
    vi.advanceTimersByTime(PICK_REST_MS - 1);
    expect(picks()).toEqual([]);
    vi.advanceTimersByTime(1);
    await flushPromises();
    // the card passed on the way was never picked
    expect(picks()).toEqual([{ action: 'pick', themeId: NIGHT, kind: 'dark' }]);
  });

  it('ignores a held arrow key, wraps from the first pick to the last, and makes no pick when the keys come back to the pressed one', async () => {
    await openAppearance(themes());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const damocles = radio('Damocles, dark, active')!;
    damocles.focus();
    expect(key(damocles, 'ArrowRight', { repeat: true }).defaultPrevented).toBe(true);
    await flushPromises();
    expect(document.activeElement?.id).toBe('theme-pick-dark-damocles');
    key(damocles, 'ArrowLeft');
    await flushPromises();
    expect(document.activeElement?.id).toBe(`theme-pick-dark-${NIGHT}`);
    key(document.activeElement!, 'ArrowRight');
    await flushPromises();
    expect(document.activeElement?.id).toBe('theme-pick-dark-damocles');
    vi.advanceTimersByTime(PICK_REST_MS);
    await flushPromises();
    expect(picks()).toEqual([]);
  });

  it('picks at once with Enter and with Space, in place of the pick the arrow keys were about to make', async () => {
    await openAppearance(themes());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    radio('Damocles, dark, active')!.focus();
    key(document.activeElement!, 'ArrowRight');
    await flushPromises();
    expect(key(document.activeElement!, 'Enter').defaultPrevented).toBe(true);
    await flushPromises();
    expect(picks()).toEqual([{ action: 'pick', themeId: BLEACH, kind: 'dark' }]);
    vi.advanceTimersByTime(PICK_REST_MS);
    await flushPromises();
    expect(picks()).toHaveLength(1);
    expect(key(radio('Bleach, light')!, ' ').defaultPrevented).toBe(true);
    await flushPromises();
    expect(picks()).toEqual([{ action: 'pick', themeId: BLEACH, kind: 'dark' }, { action: 'pick', themeId: BLEACH, kind: 'light' }]);
  });

  it('sends a look picked twice in a row to main once', async () => {
    await openAppearance(themes());
    let answer: (value: ReturnType<typeof opened<{ ok: true }>>) => void = () => undefined;
    vi.mocked(api.themeAction).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    radio('Bleach, dark')!.click();
    radio('Bleach, dark')!.click();
    await flushPromises();
    expect(picks()).toHaveLength(1);
    answer(opened({ ok: true as const }));
    await flushPromises();
    expect(byTestId('theme-toast')?.textContent).toContain('Dark look: Bleach');
  });

  it('keeps a broken theme out of the keys, with its reason, and names a missing pick above the grid', async () => {
    await openAppearance(themes({ preferred: { dark: 'damocles', light: MISSING } }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const broken = document.querySelector<HTMLElement>(`[data-testid="theme-card-${BROKEN}"] [role="radio"]`)!;
    expect(broken.getAttribute('aria-disabled')).toBe('true');
    broken.click();
    // no key picks or moves from a pick that cannot be used, Home and End included
    for (const name of ['Home', 'End', 'ArrowRight', 'Enter', ' ']) expect(key(broken, name).defaultPrevented, name).toBe(false);
    vi.advanceTimersByTime(PICK_REST_MS);
    await flushPromises();
    expect(api.themeAction).not.toHaveBeenCalled();
    expect(byTestId(`theme-card-placeholder-${BROKEN}`)!.textContent).toContain('theme.json could not be read');
    expect(byTestId('theme-missing-light')!.textContent).toContain('The theme of your light look is missing');
    expect(byTestId('theme-missing-dark')).toBeNull();
  });

  it('builds no element id from the name of a folder that is no theme', async () => {
    await openAppearance(themes({ themes: [ok(BUILTIN_THEME, true), { status: 'broken', id: 'two words', name: 'Stray', reason: 'theme.json could not be read' }] }));
    const card = byTestId('theme-card-two words')!;
    const labelledBy = card.getAttribute('aria-labelledby')!;
    expect(labelledBy).not.toContain(' ');
    expect(document.getElementById(labelledBy)!.textContent?.trim()).toBe('Stray');
    expect([...card.querySelectorAll('[id]')].map((element) => element.id).filter((id) => id.includes('two'))).toEqual([]);
  });

  it('renders only the rows in view once there are more themes than about two screens hold', async () => {
    await openAppearance(themes({ themes: [ok(BUILTIN_THEME, true), ...many()] }));
    expect(byTestId('theme-installed-count')!.textContent).toBe('41');
    const cards = cardIds().length;
    expect(cards).toBeGreaterThan(0);
    expect(cards).toBeLessThan(41);
    // the group still owns only the picks it renders, and the pressed one stays a tab stop
    expect(group('Dark look').getAttribute('aria-owns')!.split(' ')).toHaveLength(cards);
    expect(radio('Damocles, dark, active')!.tabIndex).toBe(0);
  });

  it('keeps the same rows in view when the first row rendered is taller than the others', async () => {
    const list = many();
    list[9] = BROKEN_ENTRY;
    await openAppearance(themes({ themes: [ok(BUILTIN_THEME, true), ...list] }));
    const scroller = scrollerOf(600);
    const heightOf = (row: Element): number => (row.querySelector(`[data-testid="theme-card-${BROKEN}"]`) ? 320 : 200);
    await measureRows(heightOf);
    await scrollTo(scroller, 12 * 212);
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      await measureRows(heightOf);
      seen.push(cardIds()[0]!);
    }
    expect(new Set(seen.slice(1)).size).toBe(1);
  });

  it('renders the rows in view as the grid scrolls, each placed under the measured heights of the rows above it', async () => {
    const list = many();
    // row 3 holds a broken card and row 6 a store update, both taller than a plain card
    list[2] = BROKEN_ENTRY;
    list[5] = { ...(list[5] as Extract<OverlayThemeEntry, { status: 'ok' }>), storeUpdate: { version: '2.0.0' } };
    const all = [ok(BUILTIN_THEME, true), ...list];
    await openAppearance(themes({ themes: all }));
    const scroller = scrollerOf(600);
    const heightOf = (row: Element): number => (row.querySelector(`[data-testid="theme-card-${BROKEN}"]`) ? 320 : row.querySelector('[data-testid="theme-card-update"]') ? 260 : 200);
    const rowTop = (id: string): string => document.querySelector<HTMLElement>(`[data-row="${id}"]`)!.style.top;
    const idsOf = (from: number, to: number): string[] => all.slice(from, to).map((item) => item.id);
    await scrollTo(scroller, 0);
    await measureRows(heightOf, 3);
    // 600 px hold rows 0 to 2, and two more are rendered past them
    expect(cardIds()).toEqual(idsOf(0, 5));
    expect(rowTop(all[3]!.id)).toBe('636px');
    // the row after the broken card starts below all 320 px of it
    expect(rowTop(all[4]!.id)).toBe('968px');

    await scrollTo(scroller, 1500);
    await measureRows(heightOf, 3);
    // row 6 (1392 to 1652) is the first in view and row 9 (from 2088) the last
    expect(cardIds()).toEqual(idsOf(4, 12));
    expect(rowTop(all[7]!.id)).toBe('1664px');
    expect(group('Dark look').getAttribute('aria-owns')!.split(' ')).toEqual(idsOf(4, 12).map((id) => `theme-pick-dark-${id}`));
    // the grid is as tall as every row: 39 plain ones, the two tall ones and the gaps between them
    expect(byTestId('theme-grid')!.style.height).toBe(`${39 * 200 + 320 + 260 + 40 * 12}px`);
  });

  it('keeps the card that holds keyboard focus rendered after it scrolls out of view', async () => {
    const all = [ok(BUILTIN_THEME, true), ...many()];
    await openAppearance(themes({ themes: all }));
    const scroller = scrollerOf(600);
    await scrollTo(scroller, 0);
    await measureRows(() => 200, 3);
    const focused = radio('Theme 00, dark')!;
    focused.focus();
    await scrollTo(scroller, 5000);
    await measureRows(() => 200, 3);
    expect(document.activeElement?.id).toBe(focused.id);
    expect(cardIds()[0]).toBe(all[1]!.id);
    expect(cardIds()).not.toContain('damocles');
    expect(group('Dark look').getAttribute('aria-owns')!.split(' ')[0]).toBe(focused.id);
    // once focus leaves the grid, the row goes with the others out of view
    focused.blur();
    await flushPromises();
    expect(cardIds()).not.toContain(all[1]!.id);
  });

  it("offers View first on a built-in card's menu, which opens the editor on it, and Edit on a theme of the user's own", async () => {
    await openAppearance(themes());
    expect(await menuItems('Damocles')).toEqual(['View', 'Duplicate to edit', 'Export…']);
    const view = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === 'View')!;
    view.click();
    await flushPromises();
    // main opens a built-in theme read-only
    expect(api.themeAction).toHaveBeenCalledWith({ action: 'edit', themeId: 'damocles' });
    expect(await menuItems('Bleach')).toEqual(['Edit', 'Duplicate', 'Rename…', 'Export…', 'Delete…']);
  });

  it('disables the menu items that write while a change is under way, and leaves View usable', async () => {
    await openAppearance(themes());
    vi.mocked(api.themeAction).mockImplementationOnce(() => new Promise(() => undefined));
    radio('Bleach, dark')!.click();
    await flushPromises();
    const disabled = (items: HTMLElement[]): Array<[string, boolean]> => items.map((item) => [item.textContent?.trim() ?? '', item.hasAttribute('data-disabled')]);
    expect(disabled(await openMenu('Bleach'))).toEqual([['Edit', true], ['Duplicate', true], ['Rename…', true], ['Export…', true], ['Delete…', true]]);
    key(document.activeElement!, 'Escape');
    await flushPromises();
    expect(disabled(await openMenu('Damocles'))).toEqual([['View', false], ['Duplicate to edit', true], ['Export…', true]]);
  });

  it('draws each card\'s miniature from its own look, named for its looks', async () => {
    await openAppearance(themes());
    const minis = [...document.querySelectorAll<HTMLElement>('[data-testid="theme-miniature"]')].map((element) => element.getAttribute('aria-label'));
    expect(minis).toEqual(['Damocles, dark and light looks', 'Bleach, dark and light looks', 'Night, dark look']);
    const night = document.querySelector(`[data-testid="theme-card-${NIGHT}"] [data-testid="theme-miniature"] g`)!;
    expect(night.getAttribute('style')).toContain(`--m-bg: ${COLORS.background};`);
    // painted only from its own properties, never the page's tokens
    expect(document.querySelector(`[data-testid="theme-card-${NIGHT}"] [data-testid="theme-miniature"]`)!.innerHTML).not.toContain('--d-');
  });
});

describe('theme gallery loading', () => {
  it('reads the list once more after a burst of changes, and shows the newest answer', async () => {
    await openAppearance(themes());
    vi.mocked(api.getThemes).mockClear();
    let answer: (value: ReturnType<typeof opened<OverlayThemesResult>>) => void = () => undefined;
    vi.mocked(api.getThemes).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    listed(themes({ themes: [ok(BUILTIN_THEME, true)] }));
    themesChanged();
    themesChanged();
    themesChanged();
    await flushPromises();
    expect(api.getThemes).toHaveBeenCalledTimes(1);
    // the read under way answers with what was true before the later changes
    answer(opened({ ok: true as const, ...themes() }));
    await flushPromises();
    expect(api.getThemes).toHaveBeenCalledTimes(2);
    expect(byTestId('theme-installed-count')!.textContent).toBe('1');
  });

  it('says in its own words that the list could not be read, never the call\'s error, and reads it again on Try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.getThemes).mockRejectedValue(new Error("Error invoking remote method 'damocles:overlay:themes:list': Error: boom"));
    await openSettings();
    const empty = byTestId('theme-load-failed')!;
    expect(empty.querySelector('[role="alert"]')!.textContent?.trim()).toBe('Damocles could not read the installed themes.');
    expect(document.body.textContent).not.toContain('Error invoking');
    expect(byTestId('theme-error')).toBeNull();
    // what needs the list waits for it
    expect((byTestId('theme-undo') as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId('theme-history-open') as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId('theme-reset') as HTMLButtonElement).disabled).toBe(false);
    listed(themes());
    await click(byTestId('theme-load-retry'));
    expect(byTestId('theme-load-failed')).toBeNull();
    expect(cardIds()).toHaveLength(4);
  });

  it("shows main's own sentence while the engine is down, and drops a failure once a later read succeeds", async () => {
    vi.mocked(api.getThemes).mockResolvedValue(opened({ ok: false as const, error: "This computer's Damocles engine is not running." }));
    await openSettings();
    expect(byTestId('theme-load-failed')!.textContent).toContain("This computer's Damocles engine is not running.");
    listed(themes());
    themesChanged();
    await flushPromises();
    expect(byTestId('theme-load-failed')).toBeNull();
    // a later read that fails keeps the list on screen and says so above it
    vi.mocked(api.getThemes).mockResolvedValue(opened({ ok: false as const, error: "This computer's Damocles engine is not running." }));
    themesChanged();
    await flushPromises();
    expect(cardIds()).toHaveLength(4);
    expect(byTestId('theme-error')!.textContent?.trim()).toBe("This computer's Damocles engine is not running.");
    listed(themes());
    themesChanged();
    await flushPromises();
    expect(byTestId('theme-error')).toBeNull();
  });

  it("says in its own words that an action failed when the call to main rejects, never the call's error", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await openAppearance(themes());
    vi.mocked(api.themeAction).mockRejectedValueOnce(new Error("Error invoking remote method 'damocles:overlay:themes:act': Error: boom"));
    await click(radio('Bleach, dark'));
    expect(byTestId('theme-error')!.textContent?.trim()).toBe('Damocles could not do that. Try again.');
  });
});

describe('theme gallery undo', () => {
  const picked = themes({ preferred: { dark: BLEACH, light: 'damocles' }, history: [entry('e1', PICKED_BLEACH)] });

  it('binds the toast\'s Undo to the entry the pick recorded, and sends that entry with it', async () => {
    await openAppearance(themes());
    listed(picked);
    await click(radio('Bleach, dark'));
    expect(byTestId('theme-toast')!.textContent).toContain('Dark look: Bleach');
    vi.mocked(api.themeAction).mockResolvedValueOnce(opened({ ok: true as const, undone: PICKED_BLEACH }));
    listed(themes());
    await click(byTestId('theme-toast-undo'));
    expect(api.themeAction).toHaveBeenLastCalledWith({ action: 'undo', entryId: 'e1' });
    expect(byTestId('theme-toast')!.textContent).toContain('Undid: Dark look: Bleach (was Damocles)');
  });

  it('takes the Undo off the toast once another change is the newest', async () => {
    await openAppearance(themes());
    listed(picked);
    await click(radio('Bleach, dark'));
    expect(byTestId('theme-toast-undo')).not.toBeNull();
    listed({ ...picked, history: [entry('e2', { kind: 'rename', theme: 'Dusk', was: 'Night' }, { actor: { kind: 'agent', chatId: 'c1', title: 'Chat' } }), ...picked.history] });
    themesChanged();
    await flushPromises();
    expect(byTestId('theme-toast')).not.toBeNull();
    expect(byTestId('theme-toast-undo')).toBeNull();
  });

  it('offers no Undo on the toast of an action that recorded nothing of the user\'s own', async () => {
    await openAppearance(themes({ history: [entry('e0', { kind: 'reset' })] }));
    // the newest entry after the pick is an agent's, made in between
    listed({ ...picked, history: [entry('e2', { kind: 'reset' }, { actor: { kind: 'agent', chatId: 'c1', title: 'Chat' } }), entry('e1', PICKED_BLEACH), entry('e0', { kind: 'reset' })] });
    await click(radio('Bleach, dark'));
    expect(byTestId('theme-toast')!.textContent).toContain('Dark look: Bleach');
    expect(byTestId('theme-toast-undo')).toBeNull();
  });

  it("shows the engine's refusal when the entry an Undo names is no longer the newest", async () => {
    await openAppearance(themes());
    listed(picked);
    await click(radio('Bleach, dark'));
    vi.mocked(api.themeAction).mockResolvedValueOnce(opened({ ok: false as const, error: 'Another theme change was made after this one, so nothing was undone.' }));
    await click(byTestId('theme-toast-undo'));
    expect(byTestId('theme-error')!.textContent?.trim()).toBe('Another theme change was made after this one, so nothing was undone.');
  });

  it('does not send an Undo that could only be refused: the newest change is one this Damocles cannot reverse', async () => {
    await openAppearance(themes({ history: [entry('e9', { kind: 'other' }, { cannotUndo: true })] }));
    const undo = byTestId('theme-undo') as HTMLButtonElement;
    expect(undo.getAttribute('aria-disabled')).toBe('true');
    expect(undo.title).toBe('A newer Damocles made the last theme change, so this one cannot undo it.');
    await click(undo);
    expect(api.themeAction).not.toHaveBeenCalled();
  });

  it('words a restore of a Restore entry by the change that entry went back to before, on the toast and on its button', async () => {
    const restored: ThemeHistoryChange = { kind: 'restore', before: { kind: 'rename', theme: 'Dusk', was: 'Night' } };
    await openAppearance(themes({ history: [entry('e2', restored), entry('e1', { kind: 'rename', theme: 'Dusk', was: 'Night' })] }));
    await click(byTestId('theme-history-open'));
    const row = byTestId('theme-history-e2')!;
    expect(row.textContent).toContain('Restored to before: Renamed Night to Dusk');
    const button = row.querySelector('button')!;
    expect(button.getAttribute('aria-label')).toBe('Restore: before Renamed Night to Dusk');
    await click(button);
    expect(api.themeAction).toHaveBeenLastCalledWith({ action: 'restore', entryId: 'e2' });
    expect(byTestId('theme-toast')!.textContent).toContain('Restored to before: Renamed Night to Dusk');
    expect(byTestId('theme-toast')!.textContent).not.toContain('Restored to before: Restored');
  });
});

describe('theme gallery details', () => {
  it("names Reset's shortcut for the platform, from the menu's accelerator", async () => {
    await openAppearance(themes());
    expect(byTestId('theme-reset')!.getAttribute('aria-keyshortcuts')).toBe('Control+Alt+Shift+0');
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    document.body.innerHTML = '';
    vi.mocked(api.getState).mockResolvedValue({ locale: 'en', platform: 'darwin' });
    await openAppearance(themes());
    expect(byTestId('theme-reset')!.getAttribute('aria-keyshortcuts')).toBe('Meta+Alt+Shift+0');
    vi.mocked(api.getState).mockResolvedValue({ locale: 'en', platform: 'win32' });
  });

  it.each(['en', 'el'] as const)('names a copy of a theme with a 64 character name whole, the word for copy included (%s)', async (locale) => {
    const long = 'N'.repeat(64);
    await openAppearance(themes({ themes: [ok(BUILTIN_THEME, true), ok(theme(NIGHT, long, ['dark']))] }));
    shellI18n.global.locale.value = locale;
    await flushPromises();
    // Duplicate is the item after Edit, in either language
    key(byTestId(`theme-more-${NIGHT}`)!, 'Enter');
    await flushPromises();
    await click(document.querySelectorAll('[role="menuitem"]')[1]);
    const sent = vi.mocked(api.themeAction).mock.calls.map(([action]) => action).find((action) => action.action === 'duplicate') as { name: string };
    const suffix = shellI18n.global.t('settingsHost.themes.copyName', { name: '' });
    expect(suffix.trim()).not.toBe('');
    expect([...sent.name]).toHaveLength(64);
    expect(sent.name).toBe(`${'N'.repeat(64 - [...suffix].length)}${suffix}`);
  });

  it('announces a refused name in the rename dialog and puts focus back in the field', async () => {
    await openAppearance(themes());
    const items = await openMenu('Bleach');
    await click(items.find((item) => item.textContent?.trim() === 'Rename…'));
    const input = document.getElementById('theme-rename-input') as HTMLInputElement;
    const hint = document.getElementById('theme-rename-hint')!;
    expect(hint.textContent?.trim()).toBe('Up to 64 characters.');
    expect(hint.getAttribute('role')).toBeNull();
    input.value = 'x'.repeat(65);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    (document.activeElement as HTMLElement | null)?.blur();
    byTestId('theme-rename')!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(hint.getAttribute('role')).toBe('alert');
    expect(hint.textContent?.trim()).toBe('Use at most 64 characters.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement?.id).toBe('theme-rename-input');
    expect(api.themeAction).not.toHaveBeenCalled();
  });

  it('keeps one live region for the toast: the region that is there before it', async () => {
    await openAppearance(themes());
    await click(radio('Bleach, dark'));
    const toast = byTestId('theme-toast')!;
    expect(toast.getAttribute('role')).toBeNull();
    expect(toast.parentElement!.getAttribute('aria-live')).toBe('polite');
  });
});
