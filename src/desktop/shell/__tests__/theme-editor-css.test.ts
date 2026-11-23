// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { BUILTIN_THEME } from '@shared/themes/builtin';
import {
  CSS_DROP_REASONS, CSS_MAX_DATA_URL_CHARS, CSS_MAX_RULES, CSS_MAX_SELECTOR_CHARS, CSS_MIN_TEXT_ALPHA, CSS_REGION_LIMIT_BYTES, CSS_TOTAL_LIMIT_BYTES, cssDropReasonArgs,
} from '@shared/themes/css-types';
import type { CssDroppedPart } from '@shared/themes/css-types';
import type { ThemeFile } from '@shared/themes/schema';
import CssSection from '../overlay/theme-editor/CssSection.vue';
import { shellI18n } from '../i18n';
import en from '../locales/en.json' with { type: 'json' };
import el from '../locales/el.json' with { type: 'json' };

const mounted: VueWrapper[] = [];
beforeEach(() => {
  shellI18n.global.locale.value = 'en';
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  shellI18n.global.locale.value = 'en';
});

const THEME: ThemeFile = {
  ...BUILTIN_THEME,
  id: '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10',
  name: 'Bleach',
  css: {
    transcript: '[data-tool-card] { border-radius: 0.5rem; }\n.bubble { display: none; }\n',
    sidebar: 'li { color: #ff0000; }\n',
  },
};

function section(draft: ThemeFile = THEME, extra: { readOnly?: boolean; savedDropped?: readonly CssDroppedPart[]; savedDroppedMore?: number } = {}): VueWrapper {
  const wrapper = mount(CssSection, { props: { draft, readOnly: extra.readOnly ?? false, savedDropped: extra.savedDropped, savedDroppedMore: extra.savedDroppedMore }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

const removed = (wrapper: VueWrapper) => wrapper.get('[data-testid="theme-editor-css-removed"]');
const count = (wrapper: VueWrapper, region: string) => wrapper.find(`[data-testid="theme-editor-css-region-${region}"] [data-testid="theme-editor-css-count"]`);

describe('the theme editor\'s CSS section', () => {
  it('lists the five regions in one segmented control, counting each region\'s removed parts in the warning tint', async () => {
    const wrapper = section();
    await flushPromises();
    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs.map((tab) => tab.text().replace(/\d+.*$/, '').trim())).toEqual(['Transcript', 'Sidebar', 'Editor chrome', 'Terminal chrome', 'Title bar']);
    expect(wrapper.get('[role="tablist"]').attributes('aria-label')).toBe('CSS region');
    expect(count(wrapper, 'transcript').text()).toBe('1');
    expect(count(wrapper, 'transcript').classes()).toContain('text-(--d-warning-text)');
    expect(wrapper.get('[data-testid="theme-editor-css-region-transcript"]').attributes('aria-label')).toBe('Transcript, 1 part removed');
    expect(count(wrapper, 'sidebar').exists()).toBe(false);
    expect(wrapper.get('[data-testid="theme-editor-css-region-sidebar"]').attributes('aria-label')).toBeUndefined();
  });

  it('frames the region\'s source with its label and size meters against 32 KB and 64 KB', async () => {
    const wrapper = section();
    await flushPromises();
    const source = wrapper.get<HTMLTextAreaElement>('[data-testid="theme-editor-css-source-transcript"]');
    expect(source.element.value).toBe(THEME.css!.transcript);
    expect(wrapper.get('label[for="theme-editor-css-transcript"]').text()).toBe('Transcript CSS');
    const region = wrapper.get('[data-testid="theme-editor-css-meter-region"]');
    expect(region.attributes('role')).toBe('meter');
    expect(region.attributes('aria-label')).toBe('Size of Transcript CSS');
    expect(region.attributes('aria-valuemax')).toBe('32');
    expect(region.attributes('aria-valuetext')).toBe('0.1 of 32 KB');
    const total = wrapper.get('[data-testid="theme-editor-css-meter-total"]');
    expect(total.attributes('aria-valuemax')).toBe('64');
    expect(total.attributes('aria-valuetext')).toBe('0.1 of 64 KB in all regions');
  });

  it('lists what saving removes from the shown region, each with its line and reason', async () => {
    const wrapper = section();
    await flushPromises();
    expect(wrapper.get('[data-testid="theme-editor-css-removed-count"]').text()).toBe('1 part');
    const parts = removed(wrapper).findAll('li');
    expect(parts).toHaveLength(1);
    expect(parts[0]!.attributes('data-reason')).toBe('property');
    expect(parts[0]!.get('code').text()).toBe('display: none');
    expect(parts[0]!.text()).toContain('Line 2 · Theme CSS may not set this property.');

    await wrapper.get('[data-testid="theme-editor-css-region-sidebar"]').trigger('mousedown', { button: 0 });
    await flushPromises();
    expect(wrapper.get('[data-testid="theme-editor-css-removed-count"]').text()).toBe('None');
    expect(removed(wrapper).text()).toBe('Nothing in Sidebar is removed.');
  });

  it('sends each edit as the whole theme, dropping a region and the css key once they are empty', async () => {
    const wrapper = section({ ...THEME, css: { transcript: 'p { color: #000000; }' } });
    await flushPromises();
    await wrapper.get('[data-testid="theme-editor-css-source-transcript"]').setValue('p { margin: 1rem; }');
    await wrapper.get('[data-testid="theme-editor-css-source-transcript"]').setValue('');
    const updates = wrapper.emitted('update') as [ThemeFile][];
    expect(updates[0]![0].css).toEqual({ transcript: 'p { margin: 1rem; }' });
    expect('css' in updates[1]![0]).toBe(false);
  });

  it('shows what core removed at the last save for as long as the editor gives it, and the live list once the editor drops it', async () => {
    const saved: CssDroppedPart[] = [{ region: 'transcript', reason: 'url', text: 'background: url(https://example.com/x.png)' }];
    const kept: ThemeFile = { ...THEME, css: { transcript: 'p { color: #000000; }' } };
    const wrapper = section(kept, { savedDropped: saved });
    await flushPromises();
    expect(removed(wrapper).get('li').attributes('data-reason')).toBe('url');

    // the editor owns the saved list: the section keeps no "edited since" of its own, which a tab switch would forget
    await wrapper.setProps({ draft: { ...kept, css: { transcript: 'p { color: #000000; }\n' } }, savedDropped: undefined });
    expect(removed(wrapper).text()).toBe('Nothing in Transcript is removed.');
  });

  it('says how many removed parts the list leaves out, in both languages, and never that nothing is removed then', async () => {
    const many: ThemeFile = { ...THEME, css: { transcript: `p { ${'display: none; '.repeat(130)}}`, sidebar: 'li { position: fixed }' } };
    const wrapper = section(many);
    await flushPromises();
    expect(removed(wrapper).findAll('li[data-reason]')).toHaveLength(100);
    expect(wrapper.get('[data-testid="theme-editor-css-removed-more"]').text()).toBe('31 more parts are removed and not listed.');
    // the sidebar's one part is among those the list leaves out
    await wrapper.get('[data-testid="theme-editor-css-region-sidebar"]').trigger('mousedown');
    await wrapper.get('[data-testid="theme-editor-css-region-sidebar"]').trigger('click');
    await flushPromises();
    expect(removed(wrapper).text()).not.toContain('Nothing in Sidebar is removed.');
    shellI18n.global.locale.value = 'el';
    await flushPromises();
    expect(wrapper.get('[data-testid="theme-editor-css-removed-more"]').text()).toBe('Αφαιρούνται 31 ακόμη τμήματα, που δεν εμφανίζονται στη λίστα.');

    const saved = section(THEME, { savedDropped: [], savedDroppedMore: 1 });
    await flushPromises();
    shellI18n.global.locale.value = 'en';
    await flushPromises();
    expect(saved.get('[data-testid="theme-editor-css-removed-more"]').text()).toBe('1 more part is removed and not listed.');
  });

  it('shows a built-in theme\'s CSS read-only and sends no edit', async () => {
    const wrapper = section(THEME, { readOnly: true });
    await flushPromises();
    const source = wrapper.get('[data-testid="theme-editor-css-source-transcript"]');
    expect(source.attributes('readonly')).toBeDefined();
    await source.setValue('p {}');
    expect(wrapper.emitted('update')).toBeUndefined();
  });

  it('words every reason the sanitizer can give, in English and Greek, each a message vue-i18n compiles', () => {
    const reasons = (catalog: typeof en): Record<string, string> => catalog.themeEditor.css.reasons;
    for (const locale of ['en', 'el'] as const) {
      shellI18n.global.locale.value = locale;
      for (const reason of CSS_DROP_REASONS) {
        expect(reasons((locale === 'en' ? en : el) as typeof en)[reason], reason).toBeTruthy();
        // a limit is named only through its placeholder, never typed into the message
        expect(reasons((locale === 'en' ? en : el) as typeof en)[reason], reason).not.toMatch(/\d/);
        const { named, count: plural } = cssDropReasonArgs(reason, locale);
        const text = plural === undefined ? shellI18n.global.t(`themeEditor.css.reasons.${reason}`, named) : shellI18n.global.t(`themeEditor.css.reasons.${reason}`, named, plural);
        expect(text, `${locale} ${reason}`).not.toMatch(/[{}|]|themeEditor/);
      }
    }
    shellI18n.global.locale.value = 'en';
    expect(shellI18n.global.t('themeEditor.css.reasons.atRule')).toBe('Only @media, @supports and @container are allowed.');
  });

  it('names each limit from its constant, in the plural form its count takes', () => {
    const text = (locale: 'en' | 'el', reason: (typeof CSS_DROP_REASONS)[number]): string => {
      shellI18n.global.locale.value = locale;
      const { named, count: plural } = cssDropReasonArgs(reason, locale);
      return plural === undefined ? shellI18n.global.t(`themeEditor.css.reasons.${reason}`, named) : shellI18n.global.t(`themeEditor.css.reasons.${reason}`, named, plural);
    };
    expect(text('en', 'regionTooLarge')).toBe(`This region is over ${CSS_REGION_LIMIT_BYTES / 1024} KB, so all of its CSS is removed.`);
    expect(text('en', 'tooManyRules')).toBe(`Past the limit of ${CSS_MAX_RULES} rules.`);
    expect(text('en', 'selectorTooLong')).toBe(`The selector is longer than ${CSS_MAX_SELECTOR_CHARS} characters.`);
    expect(text('en', 'url')).toBe(`Only still data: images up to ${CSS_MAX_DATA_URL_CHARS / 1024} KB are allowed; nothing loads from the network.`);
    expect(text('en', 'colorAlpha')).toBe(`A color needs at least ${CSS_MIN_TEXT_ALPHA * 100}% opacity, or a --d- or --s- token.`);
    expect(text('el', 'tooManyRules')).toBe(`Ξεπερνά το όριο των ${CSS_MAX_RULES} κανόνων.`);
    expect(text('el', 'totalTooLarge')).toBe(`Το CSS του θέματος ξεπερνά τα ${CSS_TOTAL_LIMIT_BYTES / 1024} KB σε όλες τις περιοχές, οπότε αφαιρείται το CSS αυτής της περιοχής.`);
    shellI18n.global.locale.value = 'en';
  });

  it('speaks Greek', async () => {
    shellI18n.global.locale.value = 'el';
    const wrapper = section();
    await flushPromises();
    expect(wrapper.get('h2').text()).toBe('Αφαιρούνται κατά την αποθήκευση');
    expect(removed(wrapper).get('li').text()).toContain('Το CSS του θέματος δεν μπορεί να ορίσει αυτή την ιδιότητα.');
  });
});
