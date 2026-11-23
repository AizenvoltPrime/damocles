// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import { checkPalette } from '@shared/themes/contrast';
import { deriveLook } from '@shared/themes/derive';
import type { TokenName } from '@shared/themes/tokens';
import TokenTable from '../overlay/theme-editor/TokenTable.vue';
import { shellI18n } from '../i18n';

// The theme editor's Advanced table: every token with its override, and what an override breaks, listed and never blocked.
const DARK = BUILTIN_THEME.looks.dark!.colors;

const mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  shellI18n.global.locale.value = 'en';
});

function table(overrides: Partial<Record<TokenName, string>> = {}): VueWrapper {
  const derived = deriveLook(DARK, 'dark');
  const shown = deriveLook(DARK, 'dark', overrides);
  const wrapper = mount(TokenTable, { props: { derived, shown, overrides, issues: checkPalette(shown, 'dark'), kind: 'dark', readOnly: false }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}
const field = (wrapper: VueWrapper, token: string) => wrapper.get<HTMLInputElement>(`#theme-token-d-${token}`);
async function type(wrapper: VueWrapper, token: string, value: string): Promise<void> {
  const input = field(wrapper, token);
  input.element.value = value;
  await input.trigger('input');
  await input.trigger('change');
}

describe('the theme editor\'s token table', () => {
  it('lists an override that fails contrast under the overridden text', async () => {
    const wrapper = table({ '--d-muted': '#30363d' });
    await flushPromises();
    const note = wrapper.get('#theme-token-d-muted-warning');
    expect(note.text()).toMatch(/^Override kept\. --d-muted on --d-\w+ is [\d.]+:1, needs 4\.5:1\.$/);
    expect(field(wrapper, 'muted').attributes('aria-describedby')).toBe('theme-token-d-muted-warning');
  });

  it('lists it under an overridden surface too, which fails the text drawn on it', async () => {
    const wrapper = table({ '--d-bg': '#ffffff' });
    await flushPromises();
    const note = wrapper.get('#theme-token-d-bg-warning');
    expect(note.text()).toMatch(/^Override kept\. --d-[\w-]+ on --d-bg is [\d.]+:1, needs 4\.5:1\.$/);
    expect(field(wrapper, 'bg').attributes('aria-describedby')).toBe('theme-token-d-bg-warning');
    // text that is not overridden gets no row of its own
    expect(wrapper.find('#theme-token-d-text-warning').exists()).toBe(false);
  });

  it('says that a translucent color where an opaque one is needed turns the Damocles colors on for trusted screens', async () => {
    const wrapper = table({ '--d-card': '#15203080' });
    await flushPromises();
    expect(wrapper.get('#theme-token-d-card-warning').text()).toBe('Override kept. --d-card must be a color with no transparency; while it has some, menus, dialogs and Settings keep the Damocles colors.');
  });

  it('says that a value which is no color was not taken, marks the field, and puts its stored value back when it is left', async () => {
    const wrapper = table({ '--d-muted': '#9aa4b2' });
    await flushPromises();
    await type(wrapper, 'muted', 'zzz');
    expect(wrapper.emitted('set')).toBeUndefined();
    const input = field(wrapper, 'muted');
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(input.attributes('aria-describedby')).toBe('theme-token-d-muted-invalid');
    expect(wrapper.get('#theme-token-d-muted-invalid').text()).toBe('Not changed: a color is written #rrggbb or #rrggbbaa.');
    expect(input.element.value).toBe('zzz');
    await input.trigger('blur');
    expect(input.element.value).toBe('#9aa4b2');
    // typing again ends the message
    input.element.value = '#';
    await input.trigger('input');
    expect(wrapper.find('#theme-token-d-muted-invalid').exists()).toBe(false);
    expect(input.attributes('aria-invalid')).toBeUndefined();

    await type(wrapper, 'shadow', 'big');
    expect(wrapper.get('#theme-token-d-shadow-invalid').text()).toBe('Not changed: a shadow is two to four px lengths and a #rrggbb or #rrggbbaa color.');
  });

  it('takes a color typed with or without its #, and an emptied field as no override', async () => {
    const wrapper = table({ '--d-muted': '#9aa4b2' });
    await flushPromises();
    await type(wrapper, 'faint', 'A1B2C3');
    await type(wrapper, 'muted', '');
    expect(wrapper.emitted('set')).toEqual([['--d-faint', '#a1b2c3'], ['--d-muted', undefined]]);
  });
});
