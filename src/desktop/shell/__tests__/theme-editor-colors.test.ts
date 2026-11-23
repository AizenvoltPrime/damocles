// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import { deriveLook } from '@shared/themes/derive';
import type { Look, LookColors, ThemeFile } from '@shared/themes/schema';
import ThemeEditor from '../overlay/theme-editor/ThemeEditor.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// The theme editor's Colors section: the contrast warnings and their lightness fix, the hex fields, and the color a tone
// shows as where the derivation moved it off the seed.
const ID = '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10';
const DARK = BUILTIN_THEME.looks.dark!.colors;

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  shellI18n.global.locale.value = 'en';
});

async function editor(colors: LookColors, tokens?: Look['tokens'], light?: LookColors): Promise<VueWrapper> {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  const theme: ThemeFile = { schemaVersion: 1, id: ID, name: 'Dusk', looks: { dark: { colors, ...(tokens ? { tokens } : {}) }, ...(light ? { light: { colors: light } } : {}) } };
  const api = fakeOverlayApi();
  vi.mocked(api.themeEditor.getSession).mockResolvedValue({ sessionId: 1, themeId: ID, builtin: false, theme, kind: 'dark', nextWallpaperShortcut: '' });
  const wrapper = mount(ThemeEditor, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

const notes = (wrapper: VueWrapper): string[] => wrapper.findAll('[data-testid="theme-editor-moved"]').map((note) => note.text());
const warnings = (wrapper: VueWrapper) => wrapper.get('[data-testid="theme-editor-warnings"]');
const fixStatus = (wrapper: VueWrapper) => wrapper.get('[data-testid="theme-editor-fix-status"]');
const hex = (wrapper: VueWrapper, seed: string) => wrapper.get<HTMLInputElement>(`#theme-hex-${seed}`);
const button = (wrapper: VueWrapper, name: string | RegExp) => wrapper.findAll('button').find((candidate) => (typeof name === 'string' ? candidate.text() === name : name.test(candidate.text())))!;

describe('the theme editor Colors section', () => {
  it('shows the text color an accent moved to for 4.5:1 beside it, and describes its hex field with it', async () => {
    const colors = { ...DARK, accent: '#1d3b8a' };
    const shown = deriveLook(colors, 'dark')['--d-accent']!;
    const wrapper = await editor(colors);
    expect(notes(wrapper)).toEqual([`Shown as ${shown} in text, so text in this color stays at 4.5:1.`]);
    const note = wrapper.get('[data-testid="theme-editor-moved"]');
    expect(hex(wrapper, 'accent').attributes('aria-describedby')).toBe(note.attributes('id'));
  });

  it('shows the fill an accent moved to when neither white nor near-black text reaches 4.5:1 on it, in Greek too', async () => {
    const colors = { ...DARK, accent: '#d728aa' };
    const fill = deriveLook(colors, 'dark')['--d-accent-fill']!;
    expect(fill).not.toBe('#d728aa');
    shellI18n.global.locale.value = 'el';
    const wrapper = await editor(colors);
    expect(notes(wrapper)).toContain(`Εμφανίζεται ως ${fill} στα γεμίσματα, ώστε το κείμενο πάνω τους να μένει σε 4,5:1.`);
  });

  it('shows nothing where an Advanced override sets the color', async () => {
    const wrapper = await editor({ ...DARK, accent: '#1d3b8a' }, { '--d-accent': '#8ab4ff' });
    expect(notes(wrapper)).toEqual([]);
    expect(hex(wrapper, 'accent').attributes('aria-describedby')).toBeUndefined();
  });

  it('warns about a color that fails contrast with its ratio rounded down, and fixes it by lightness alone, with Undo fix', async () => {
    const wrapper = await editor({ ...DARK, text: '#6b7280' });
    const row = warnings(wrapper).get('li');
    expect(row.text()).toMatch(/^Text on Panel [\d.]+:1, needs 4\.5:1/);
    const fixButton = row.get('button');
    expect(fixButton.text()).toMatch(/^Fix: lightness to 4\.[5-9]:1$/);
    await fixButton.trigger('click');
    expect(warnings(wrapper).text()).toBe('All colors pass');
    const fixed = hex(wrapper, 'text').element.value;
    expect(fixStatus(wrapper).text()).toContain(`Fixed: Text moved from #6b7280 to ${fixed}`);
    await button(wrapper, 'Undo fix').trigger('click');
    expect(hex(wrapper, 'text').element.value).toBe('#6b7280');
    expect(fixStatus(wrapper).text()).toBe('Text is back to #6b7280.');
    expect(button(wrapper, 'Undo fix')).toBeUndefined();
  });

  it('offers no fix where no lightness passes on both surfaces, and says what to change instead, in Greek with its own decimal sign', async () => {
    const wrapper = await editor({ ...DARK, background: '#000000', panel: '#999999' });
    const row = warnings(wrapper).findAll('li').find((item) => item.text().startsWith('Text on'))!;
    expect(row.text()).toContain('Text on Panel 2.4:1, needs 4.5:1');
    expect(row.find('button').exists()).toBe(false);
    expect(row.get('[data-testid="theme-editor-no-fix"]').text()).toBe('No lightness passes on both surfaces. Change Background or Panel.');
    shellI18n.global.locale.value = 'el';
    await flushPromises();
    expect(warnings(wrapper).findAll('li').some((item) => item.text().includes('2,4:1, χρειάζεται 4,5:1'))).toBe(true);
  });

  it('takes Undo fix away once the fixed color is set again, and when the other look shows', async () => {
    const wrapper = await editor({ ...DARK, text: '#6b7280' }, undefined, { ...BUILTIN_THEME.looks.light!.colors });
    await warnings(wrapper).get('li button').trigger('click');
    expect(button(wrapper, 'Undo fix')).toBeDefined();
    // another color changes: the fix can still be undone
    await hex(wrapper, 'accent').setValue('#4cc2ff');
    expect(button(wrapper, 'Undo fix')).toBeDefined();
    // the fixed color is typed over: undoing the fix would overwrite what was typed
    await hex(wrapper, 'text').setValue('#ffffff');
    expect(button(wrapper, 'Undo fix')).toBeUndefined();
    expect(fixStatus(wrapper).text()).toBe('');

    await hex(wrapper, 'text').setValue('#6b7280');
    await warnings(wrapper).get('li button').trigger('click');
    expect(button(wrapper, 'Undo fix')).toBeDefined();
    await wrapper.get('[data-testid="theme-editor-looks"]').findAll('[role="radio"]').find((radio) => radio.text() === 'Light')!.trigger('click');
    await flushPromises();
    expect(fixStatus(wrapper).text()).toBe('');
  });

  it('chooses the look to edit in a radio group, which names no tab panel', async () => {
    const wrapper = await editor(DARK, undefined, { ...BUILTIN_THEME.looks.light!.colors });
    const looks = wrapper.get('[data-testid="theme-editor-looks"]');
    expect(looks.attributes()).toMatchObject({ role: 'radiogroup', 'aria-label': 'Look' });
    const radios = looks.findAll('[role="radio"]');
    expect(radios.map((radio) => [radio.text(), radio.attributes('aria-checked')])).toEqual([['Dark', 'true'], ['Light', 'false']]);
    expect(radios.every((radio) => radio.attributes('aria-controls') === undefined)).toBe(true);
    await radios[1]!.trigger('click');
    await flushPromises();
    expect(hex(wrapper, 'background').element.value).toBe(BUILTIN_THEME.looks.light!.colors.background);
  });

  it('judges a hex field when it is left, never on the way to a color, and takes a color as soon as it is one', async () => {
    const wrapper = await editor(DARK);
    const field = hex(wrapper, 'accent');
    await field.setValue('#12');
    expect(field.attributes('aria-invalid')).toBeUndefined();
    expect(wrapper.find('#theme-hex-accent-error').exists()).toBe(false);
    await field.trigger('blur');
    expect(field.attributes('aria-invalid')).toBe('true');
    expect(wrapper.get('#theme-hex-accent-error').text()).toBe('Use 6 hex digits, such as #1a2b3c.');
    expect(field.attributes('aria-describedby')).toContain('theme-hex-accent-error');
    // typing again ends the error until the field is left again
    await field.setValue('#123');
    expect(field.attributes('aria-invalid')).toBeUndefined();
    await field.setValue('#123456');
    await field.trigger('blur');
    expect(field.attributes('aria-invalid')).toBeUndefined();
    expect(hex(wrapper, 'accent').element.value).toBe('#123456');
  });
});
