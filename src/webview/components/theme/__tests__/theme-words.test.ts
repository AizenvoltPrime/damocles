import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import { CSS_DROP_REASONS, CSS_MAX_RULES, CSS_MAX_SELECTOR_CHARS, CSS_MIN_TEXT_ALPHA, CSS_REGION_LIMIT_BYTES, type CssDropReason, type CssDroppedPart } from '@shared/themes/css-types';
import en from '../../../i18n/locales/en.json' with { type: 'json' };
import el from '../../../i18n/locales/el.json' with { type: 'json' };
import { changeItemText, contrastText, droppedCssText, historyChangeText, listText, looksText, numberText, ratioText, type Words } from '../theme-words';

// the key and what it was given, so a test reads exactly what a locale would be handed
const t = (key: string, named?: Record<string, unknown>): string => (named ? `${key} ${JSON.stringify(named)}` : key);

describe('the theme cards\' words', () => {
  it('name the looks a list holds, and nothing for an empty list', () => {
    expect(looksText(t, ['light', 'dark'])).toBe('themeAgent.looks.both');
    expect(looksText(t, ['dark'])).toBe('themeAgent.looks.dark');
    expect(looksText(t, ['light'])).toBe('themeAgent.looks.light');
    expect(looksText(t, [])).toBe('');
  });

  it('write a ratio and a number as the UI\'s language does, the ratio rounded down', () => {
    expect(ratioText('en', 4.5)).toBe('4.5:1');
    expect(ratioText('en', 3.99)).toBe('3.9:1');
    expect(ratioText('en', 7)).toBe('7.0:1');
    expect(ratioText('el', 4.5)).toBe('4,5:1');
    expect(numberText('en', 0.6)).toBe('0.6');
    expect(numberText('el', 0.6)).toBe('0,6');
    expect(contrastText({ t, locale: 'el' }, { look: 'dark', rule: 'text', severity: 'error', fg: '--d-muted', bg: '--d-panel', ratio: 3.94, min: 4.5 }))
      .toBe('themeAgent.contrast.issue {"fg":"--d-muted","bg":"--d-panel","ratio":"3,9:1","need":"4,5:1"}');
  });

  it('list names as the UI\'s language does, with no separator of their own', () => {
    expect(listText('en', ['chat', 'sidebar'])).toBe('chat and sidebar');
    expect(listText('en', ['a', 'b', 'c'])).toBe('a, b, and c');
    expect(listText('el', ['α', 'β', 'γ'])).toBe('α, β και γ');
    expect(listText('en', ['only'])).toBe('only');
    // each name is marked as user text of its own direction, which IsolatedText draws as a bdi element
    expect(historyChangeText({ t, locale: 'el' }, { kind: 'storeRemoved', themes: ['Aurora', 'Bleach'] })).toBe('themeAgent.history.storeRemoved {"themes":"\u2068Aurora\u2069 και \u2068Bleach\u2069"}');
    expect(historyChangeText({ t, locale: 'en' }, { kind: 'rename', theme: 'ליל 2', was: 'Night' })).toBe('themeAgent.history.rename {"theme":"\u2068ליל 2\u2069","was":"\u2068Night\u2069"}');
    expect(changeItemText({ t: (key, named) => (key.startsWith('themeAgent.change.touch.') ? key.slice(24) : t(key, named)), locale: 'en' }, { kind: 'projectLook', project: 'api', look: 'touches', touches: ['accent', 'wallpaper'] }))
      .toBe('themeAgent.change.projectLookTouches {"project":"\u2068api\u2069","touches":"accent and wallpaper"}');
    expect(changeItemText({ t, locale: 'el' }, { kind: 'radius', value: 0.6 })).toBe('themeAgent.change.radius {"value":"0,6"}');
    expect(changeItemText({ t, locale: 'el' }, { kind: 'chatColumn', value: 52.5 })).toBe('themeAgent.change.chatColumn {"value":"52,5"}');
  });
});

describe('a removed part of a theme\'s CSS', () => {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en, el } });
  const words = (locale: 'en' | 'el'): Words => {
    i18n.global.locale.value = locale;
    return { t: i18n.global.t as Words['t'], locale };
  };
  const part = (reason: CssDropReason): CssDroppedPart => ({ region: 'transcript', reason, text: 'x', line: 3 });

  it('names each limit from its constant, in the plural form its count takes', () => {
    expect(droppedCssText(words('en'), part('tooManyRules'))).toBe(`transcript, line 3: past the limit of ${CSS_MAX_RULES} rules`);
    expect(droppedCssText(words('en'), part('regionTooLarge'))).toBe(`transcript, line 3: the region is over ${CSS_REGION_LIMIT_BYTES / 1024} KB, so all of its CSS is removed`);
    expect(droppedCssText(words('en'), part('colorAlpha'))).toBe(`transcript, line 3: a color needs at least ${CSS_MIN_TEXT_ALPHA * 100}% opacity, or a --d- or --s- token`);
    expect(droppedCssText(words('el'), part('selectorTooLong'))).toBe(`συνομιλία, γραμμή 3: ο επιλογέας είναι μεγαλύτερος από ${CSS_MAX_SELECTOR_CHARS} χαρακτήρες`);
  });

  it('types no limit into a reason\'s message, in either language', () => {
    for (const catalog of [en, el]) for (const reason of CSS_DROP_REASONS) expect(catalog.themeAgent.dropped.reason[reason], reason).not.toMatch(/\d/);
  });
});
