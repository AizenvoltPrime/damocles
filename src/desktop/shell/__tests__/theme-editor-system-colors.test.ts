// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { Component } from 'vue';
import SettingSeg from '@/components/settings/controls/SettingSeg.vue';
import { SYSTEM_THEME_ID } from '@shared/themes/builtin';
import { systemTheme } from '@shared/themes/system-theme';
import type { ThemeEditorSession } from '../../preload/overlay-channels';
import ThemeEditor from '../overlay/theme-editor/ThemeEditor.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// System colors in the theme editor: main sends the session it holds again with new looks when the OS colors change, which
// must leave the user's place in the editor as it was, and its name and description are Damocles' text in the UI's language.

const BLUE = '#0078d4';
const RED = '#e81123';

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  shellI18n.global.locale.value = 'en';
});

const session = (accent: string, sessionId = 1, shownName = 'System colors'): ThemeEditorSession => ({
  sessionId, themeId: SYSTEM_THEME_ID, builtin: true, theme: systemTheme({ accent }), shownName, kind: 'dark', nextWallpaperShortcut: 'Ctrl+Alt+Shift+.',
});

async function editor(start: ThemeEditorSession) {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const api = fakeOverlayApi();
  vi.mocked(api.themeEditor.getSession).mockResolvedValue(start);
  const wrapper = mount(ThemeEditor, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  const edits = vi.mocked(api.themeEditor);
  const tab = async (name: string): Promise<void> => {
    await wrapper.findAll('[role="tab"]').find((candidate) => candidate.text() === name)!.trigger('mousedown', { button: 0 });
    await flushPromises();
  };
  const looks = () => wrapper.findComponent(SettingSeg as Component);
  const lookShown = (): unknown => (looks().props() as Record<string, unknown>)['modelValue'];
  const setLook = async (kind: 'dark' | 'light'): Promise<void> => {
    looks().vm.$emit('update:modelValue', kind);
    await flushPromises();
  };
  const load = async (next: ThemeEditorSession): Promise<void> => {
    edits.onSession.mock.calls[0]![0](next);
    await flushPromises();
  };
  const header = (): string => wrapper.get('[data-testid="theme-editor-name"]').text();
  const field = (id: string): string => wrapper.get<HTMLInputElement | HTMLTextAreaElement>(`#${id}`).element.value;
  return { wrapper, edits, tab, lookShown, setLook, load, header, field };
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('a System colors session', () => {
  // a read-only session shows no preview line, so Compare is never on in it
  it('takes new looks of the session it holds and keeps the look tab and the section', async () => {
    const e = await editor(session(BLUE));
    expect(e.wrapper.find('[data-testid="theme-editor-compare"]').exists()).toBe(false);
    await e.setLook('light');
    await e.tab('Details');
    expect([e.lookShown(), e.wrapper.find('#theme-editor-name').exists()]).toEqual(['light', true]);

    await e.load(session(RED));
    expect(e.lookShown()).toBe('light');
    expect(e.wrapper.find('#theme-editor-name').exists()).toBe(true);
    await e.tab('Colors');
    expect(e.field('theme-hex-accent')).toBe(systemTheme({ accent: RED }).looks.light!.colors.accent);

    // another session starts where any session does
    await e.setLook('light');
    await e.tab('Details');
    await e.load(session(BLUE, 2));
    expect([e.lookShown(), e.wrapper.find('#theme-editor-name').exists()]).toEqual(['dark', false]);
  });

  // main sends the name again in the session it holds when the language changes; the description is the page's own text
  it('shows its name and description in the UI language, Greek included, across an OS change, and never writes them back', async () => {
    const e = await editor(session(BLUE));
    await e.tab('Details');
    expect([e.header(), e.field('theme-editor-name'), e.field('theme-editor-description')]).toEqual(['System colors', 'System colors', "Follows this computer's colors"]);

    shellI18n.global.locale.value = 'el';
    await e.load(session(BLUE, 1, 'Χρώματα συστήματος'));
    const greek = ['Χρώματα συστήματος', 'Χρώματα συστήματος', 'Ακολουθεί τα χρώματα αυτού του υπολογιστή'];
    expect([e.header(), e.field('theme-editor-name'), e.field('theme-editor-description')]).toEqual(greek);
    await e.load(session(RED, 1, 'Χρώματα συστήματος'));
    expect([e.header(), e.field('theme-editor-name'), e.field('theme-editor-description')]).toEqual(greek);

    // read-only: the fields change no draft, so nothing is previewed, marked unsaved or saved
    await e.wrapper.get('#theme-editor-name').setValue('Mine');
    await e.wrapper.get('#theme-editor-description').setValue('Mine too');
    await wait(120);
    expect(e.header()).toBe(greek[0]);
    expect(e.edits.preview).not.toHaveBeenCalled();
    expect(e.edits.setDirty).not.toHaveBeenCalled();
    expect(e.edits.save).not.toHaveBeenCalled();
  });
});

describe('a built-in example\'s session', () => {
  it('shows the name main sends, in the name field and the read-only banner', async () => {
    const aurora = { ...systemTheme({}), id: 'damocles-aurora', name: 'Aurora' };
    const e = await editor({ sessionId: 1, themeId: aurora.id, builtin: true, theme: aurora, shownName: 'Σέλας', kind: 'dark', nextWallpaperShortcut: '' });
    expect(e.header()).toBe('Σέλας');
    expect(e.wrapper.text()).not.toContain('Aurora');
    await e.tab('Details');
    expect(e.field('theme-editor-name')).toBe('Σέλας');
  });
});
