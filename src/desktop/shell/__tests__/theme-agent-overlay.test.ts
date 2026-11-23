// @vitest-environment happy-dom
import { isolatedParts, withoutIsolates } from '@shared/bidi-isolate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import type { ThemeHistoryEntry } from '@shared/themes/changes';
import ThemeEditor from '../overlay/theme-editor/ThemeEditor.vue';
import ThemeHistory from '../overlay/settings/themes/ThemeHistory.vue';
import el from '../locales/el.json' with { type: 'json' };
import { changeText, whoAndWhen } from '../overlay/settings/themes/theme-text';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// The overlay's parts of the agent's theme changes: the editor dock's preview yields to a chat card's Show in window, and
// the history words the agent's changes.
const AMBER = { ...BUILTIN_THEME, id: '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10', name: 'Amber Night' };
const t = (key: string, values?: Record<string, unknown>): string => shellI18n.global.t(key, values ?? {});

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

describe('the theme editor dock when a chat card takes the window', () => {
  it('turns "Previewing your edits" off with a note, and the next edit previews again', async () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const api = fakeOverlayApi();
    vi.mocked(api.themeEditor.getSession).mockResolvedValue({ sessionId: 1, themeId: AMBER.id, builtin: false, theme: AMBER, kind: 'dark', nextWallpaperShortcut: '' });
    const wrapper = mount(ThemeEditor, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    const status = (): string => wrapper.get('[data-testid="theme-editor-preview"]').text();
    expect(status()).toBe('Previewing your edits · Amber Night, dark look');

    const takenOver = vi.mocked(api.themeEditor.onPreviewTakenOver).mock.calls[0]![0];
    takenOver();
    await flushPromises();
    expect(status()).toBe('Not previewing: a chat card\'s Show in window took the window. Your next edit previews again.');

    await wrapper.get('[data-testid="theme-editor-compare"]').trigger('click');
    await flushPromises();
    expect(status()).toBe('Showing your current theme');
  });
});

describe('the theme history words the agent\'s changes', () => {
  it('names a schedule, a picked apply and an untitled chat', () => {
    expect(changeText(t, { kind: 'schedule', enabled: true, rules: 2 })).toBe('Theme schedule on, rules: 2');
    expect(changeText(t, { kind: 'schedule', enabled: false, rules: 0 })).toBe('Theme schedule off');
    expect(withoutIsolates(changeText(t, { kind: 'create', theme: 'Amber Night', picked: ['dark'] }))).toBe('Created Amber Night, now your dark look');
    expect(withoutIsolates(changeText(t, { kind: 'save', theme: 'Amber Night', picked: ['dark', 'light'] }))).toBe('Edited Amber Night, now your dark and light looks');
    expect(withoutIsolates(changeText(t, { kind: 'save', theme: 'Amber Night' }))).toBe('Edited Amber Night');
    expect(withoutIsolates(changeText(t, { kind: 'restore', before: { kind: 'create', theme: 'Amber Night', picked: ['light'] } }))).toBe('Restored to before: Created Amber Night, now your light look');
    const entry = (title: string): ThemeHistoryEntry => ({ id: 'e1', at: 0, actor: { kind: 'agent', chatId: 'c1', title }, change: { kind: 'reset' } });
    expect(whoAndWhen(t, entry(''), 'en')).toMatch(/^Agent in an untitled chat · /);
    expect(withoutIsolates(whoAndWhen(t, entry('Warmer sidebar'), 'en'))).toMatch(/^Agent in “Warmer sidebar” · /);
    // each name is marked as user text of its own direction, which IsolatedText draws as a bdi element
    expect(isolatedParts(changeText(t, { kind: 'rename', theme: 'Dusk', was: 'Night' })).filter((part) => part.isolated).map((part) => part.text)).toEqual(['Night', 'Dusk']);
  });

  it('words a change a newer Damocles recorded as a neutral line, in English and Greek', () => {
    expect(changeText(t, { kind: 'other' })).toBe('A change made by a newer Damocles');
    expect(changeText(t, { kind: 'restore', before: { kind: 'other' } })).toBe('Restored to before: A change made by a newer Damocles');
    expect(el.settingsHost.themes.change.other).toBe('Αλλαγή από νεότερο Damocles');
  });
});

describe('the theme history dialog', () => {
  const entry = (id: string, change: ThemeHistoryEntry['change'], cannotUndo = false): ThemeHistoryEntry => ({ id, at: 0, actor: { kind: 'user' }, change, ...(cannotUndo ? { cannotUndo: true as const } : {}) });
  const open = (entries: readonly ThemeHistoryEntry[]): VueWrapper => {
    const wrapper = mount(ThemeHistory, { props: { open: true, entries, busy: false }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(wrapper);
    return wrapper;
  };
  const row = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-testid="theme-history-${id}"]`)!;

  it('lists a newer Damocles change as its neutral line and offers its Restore when its snapshot can be written back', async () => {
    const wrapper = open([entry('newer', { kind: 'other' }), entry('older', { kind: 'reset' })]);
    await flushPromises();
    expect(row('newer').textContent).toContain('A change made by a newer Damocles');
    expect(document.querySelector('[data-testid="theme-history-cannot-restore"]')).toBeNull();
    row('newer').querySelector('button')!.click();
    expect(wrapper.emitted('restore')).toEqual([['newer']]);
  });

  it('offers no Restore from the newest entry this Damocles cannot undo on down, and says why', async () => {
    open([entry('newest', { kind: 'reset' }), entry('fixed', { kind: 'other' }, true), entry('older', { kind: 'reset' })]);
    await flushPromises();
    expect(row('newest').querySelector('button')).not.toBeNull();
    expect(row('fixed').querySelector('button')).toBeNull();
    expect(row('older').querySelector('button')).toBeNull();
    expect(document.querySelector('[data-testid="theme-history-cannot-restore"]')?.textContent).toContain('cannot undo a change that a newer Damocles made');
  });
});
