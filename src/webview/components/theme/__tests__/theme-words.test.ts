import { describe, expect, it } from 'vitest';
import { createI18n } from 'vue-i18n';
import { CSS_DROP_REASONS, CSS_MAX_RULES, CSS_MAX_SELECTOR_CHARS, CSS_MIN_TEXT_ALPHA, CSS_REGION_LIMIT_BYTES, type CssDropReason, type CssDroppedPart } from '@shared/themes/css-types';
import en from '../../../i18n/locales/en.json' with { type: 'json' };
import el from '../../../i18n/locales/el.json' with { type: 'json' };
import { SYSTEM_THEME_ID } from '@shared/themes/builtin';
import { changeItemText, contrastText, droppedCssText, historyChangeText, listText, looksText, numberText, ratioText, themeNameText, type Words } from '../theme-words';

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

  it('word sprites and character edits by the counts that are not 0, and a change of the set alone', () => {
    expect(changeItemText({ t, locale: 'en' }, { kind: 'sprites', added: 3, recolored: 1 })).toBe('themeAgent.change.spritesDrawn {"n":3} and themeAgent.change.spritesRecolored {"n":1}');
    expect(changeItemText({ t, locale: 'en' }, { kind: 'sprites', added: 0, recolored: 2 })).toBe('themeAgent.change.spritesRecolored {"n":2}');
    expect(changeItemText({ t, locale: 'el' }, { kind: 'characterEdits', added: 1, changed: 0, removed: 2 })).toBe('themeAgent.change.charactersAdded {"n":1} και themeAgent.change.charactersRemoved {"n":2}');
    expect(changeItemText({ t, locale: 'en' }, { kind: 'characterEdits', added: 0, changed: 0, removed: 0 })).toBe('themeAgent.change.characterSet');
    const english = createI18n({ legacy: false, locale: 'en', messages: { en } }).global;
    expect(changeItemText({ t: english.t as Words['t'], locale: 'en' }, { kind: 'characterEdits', added: 1, changed: 2, removed: 0 })).toBe('1 project character added and 2 project characters changed');
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

describe('a theme\'s name on a card', () => {
  const i18n = createI18n({ legacy: false, locale: 'el', messages: { en, el } });
  const greek: Words = { t: i18n.global.t as Words['t'], locale: 'el' };

  it('is a built-in\'s own text in the UI\'s language, and any other theme\'s name as it is', () => {
    expect(themeNameText(greek.t, { id: SYSTEM_THEME_ID }, 'System colors')).toBe('Χρώματα συστήματος');
    expect(themeNameText(greek.t, { id: 'damocles-aurora' }, 'Aurora')).toBe('Σέλας');
    expect(themeNameText(greek.t, { id: 'damocles-paper' }, 'Paper')).toBe('Χαρτί');
    expect(themeNameText(greek.t, { id: 'damocles' }, 'Damocles')).toBe('Damocles');
    // an id that is no built-in's, an Object property's name included
    expect(themeNameText(greek.t, { id: 'constructor' }, 'Mine')).toBe('Mine');
    expect(themeNameText(greek.t, { id: '0b7c5a52-3a8e-4c56-9a43-2f1d8e6b9c10' }, 'System colors')).toBe('System colors');
    expect(themeNameText(greek.t, undefined, 'Night')).toBe('Night');
  });

  it('names System colors in an undone pick or hold by its id, and keeps the name of an entry stored without one', () => {
    expect(historyChangeText(greek, { kind: 'pick', look: 'dark', theme: 'System colors', themeId: SYSTEM_THEME_ID, was: 'Damocles', wasId: 'damocles' }))
      .toBe('επέλεξε το \u2068Χρώματα συστήματος\u2069 για την σκούρα εμφάνιση');
    expect(historyChangeText(greek, { kind: 'restore', before: { kind: 'hold', theme: 'System colors', themeId: SYSTEM_THEME_ID, look: 'light' } }))
      .toContain('\u2068Χρώματα συστήματος\u2069');
    expect(historyChangeText(greek, { kind: 'pick', look: 'dark', theme: 'System colors', was: 'Damocles' })).toBe('επέλεξε το \u2068System colors\u2069 για την σκούρα εμφάνιση');
  });

  it('names a pinned built-in by its id, and keeps the name of a pin stored without one', () => {
    const pin = { kind: 'projectPin', project: 'site', theme: 'System colors', character: 'Pip' } as const;
    expect(historyChangeText(greek, { ...pin, themeId: SYSTEM_THEME_ID })).toBe('καρφίτσωσε τον χαρακτήρα \u2068Pip\u2069 για το \u2068site\u2069 στο θέμα \u2068Χρώματα συστήματος\u2069');
    expect(changeItemText(greek, { ...pin, themeId: SYSTEM_THEME_ID })).toBe('Το \u2068site\u2069 δείχνει τον χαρακτήρα \u2068Pip\u2069 στο θέμα \u2068Χρώματα συστήματος\u2069');
    expect(historyChangeText(greek, pin)).toContain('\u2068System colors\u2069');
  });
});

describe("a project pin's words", () => {
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en, el } });
  const words = (locale: 'en' | 'el'): Words => {
    i18n.global.locale.value = locale;
    return { t: i18n.global.t as Words['t'], locale };
  };
  const pins = {
    theme: { kind: 'projectPin', project: 'site', theme: 'Night', character: 'Pip' },
    every: { kind: 'projectPin', project: 'site', theme: 'Night', character: 'Pip', everyTheme: true },
    themeCleared: { kind: 'projectPin', project: 'site', theme: 'Night', character: null },
    everyCleared: { kind: 'projectPin', project: 'site', theme: 'Night', character: null, everyTheme: true },
  } as const;
  const named = (text: string): string => text.replace(/\u2068|\u2069/g, '');

  it('has every form in history and on a card, in both languages, with its names in place', () => {
    const expected = {
      en: {
        history: { theme: 'pinned Pip to site in Night', every: 'kept Pip for site in every theme', themeCleared: 'unpinned the character of site in Night', everyCleared: 'stopped keeping a character for site in every theme' },
        change: { theme: 'site shows Pip in Night', every: 'site shows Pip in every theme', themeCleared: "site shows the theme's own pick of character in Night", everyCleared: 'site no longer keeps a character in every theme' },
      },
      el: {
        history: { theme: 'καρφίτσωσε τον χαρακτήρα Pip για το site στο θέμα Night', every: 'κράτησε τον χαρακτήρα Pip για το site σε κάθε θέμα', themeCleared: 'ξεκαρφίτσωσε τον χαρακτήρα του site στο θέμα Night', everyCleared: 'σταμάτησε να κρατά χαρακτήρα για το site σε κάθε θέμα' },
        change: { theme: 'Το site δείχνει τον χαρακτήρα Pip στο θέμα Night', every: 'Το site δείχνει τον χαρακτήρα Pip σε κάθε θέμα', themeCleared: 'Το site δείχνει στο θέμα Night τον χαρακτήρα που διαλέγει το ίδιο το θέμα', everyCleared: 'Το site δεν κρατά πλέον χαρακτήρα σε κάθε θέμα' },
      },
    } as const;
    for (const locale of ['en', 'el'] as const) {
      for (const form of Object.keys(pins) as (keyof typeof pins)[]) {
        expect(named(historyChangeText(words(locale), pins[form])), `${locale} history ${form}`).toBe(expected[locale].history[form]);
        expect(named(changeItemText(words(locale), pins[form])), `${locale} change ${form}`).toBe(expected[locale].change[form]);
      }
    }
  });
});
