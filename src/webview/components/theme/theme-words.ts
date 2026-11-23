// How the theme cards word core's structured theme data; core never renders the text.
import { isolated } from '@shared/bidi-isolate';
import type { ThemeChangeItem, ThemeContrastIssue } from '@shared/themes/agent';
import { isBuiltinThemeId } from '@shared/themes/builtin';
import type { ThemeHistoryChange } from '@shared/themes/changes';
import { cssDropReasonArgs, type CssDroppedPart } from '@shared/themes/css-types';
import type { LookKind } from '@shared/themes/tokens';

type Translate = (key: string, named?: Record<string, unknown>, plural?: number) => string;

/** The words of a card: vue-i18n's `t` and the UI language, which formats the numbers and lists core sends as data. */
export interface Words {
  readonly t: Translate;
  readonly locale: string;
}

const formats = new Map<string, { readonly number: Intl.NumberFormat; readonly ratio: Intl.NumberFormat; readonly list: Intl.ListFormat }>();
function formatsOf(locale: string): { readonly number: Intl.NumberFormat; readonly ratio: Intl.NumberFormat; readonly list: Intl.ListFormat } {
  let known = formats.get(locale);
  if (!known) {
    known = {
      number: new Intl.NumberFormat(locale),
      ratio: new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      list: new Intl.ListFormat(locale, { type: 'conjunction' }),
    };
    formats.set(locale, known);
  }
  return known;
}

/** The name a card gives `theme`: a built-in's is Damocles' own text, in the UI's language; any other theme's `name` is data. */
export const themeNameText = (t: Translate, theme: { readonly id: string } | undefined, name: string | undefined): string | undefined =>
  (theme !== undefined && isBuiltinThemeId(theme.id) ? t(`themeAgent.builtinName.${theme.id}`) : name);

/** A number as the UI language writes it: "0.6" in English, "0,6" in Greek. */
export const numberText = (locale: string, value: number): string => formatsOf(locale).number.format(value);

/** Names as the UI language lists them: "chat and sidebar". */
export const listText = (locale: string, items: readonly string[]): string => formatsOf(locale).list.format(items);

/** "dark and light", "dark" or "light", in the order dark, light; '' for no look. */
export function looksText(t: Translate, looks: readonly LookKind[]): string {
  const has = (kind: LookKind): boolean => looks.includes(kind);
  if (has('dark') && has('light')) return t('themeAgent.looks.both');
  if (has('dark')) return t('themeAgent.looks.dark');
  return has('light') ? t('themeAgent.looks.light') : '';
}

/** The ratio as the theme editor shows it, rounded down so a ratio shown as passing passes: "4.5:1". */
export const ratioText = (locale: string, ratio: number): string => `${formatsOf(locale).ratio.format(Math.floor(ratio * 10) / 10)}:1`;

/** A change in words, each name in it marked as user text (isolated): show it through IsolatedText. */
export function historyChangeText({ t, locale }: Words, change: ThemeHistoryChange): string {
  // a name stored beside a theme id; an entry stored without one keeps its name
  const named = (id: string | undefined, name: string): string => isolated(themeNameText(t, id === undefined ? undefined : { id }, name) ?? name);
  switch (change.kind) {
    case 'pick':
      return t('themeAgent.history.pick', { theme: named(change.themeId, change.theme), look: t(`themeAgent.look.${change.look}`) });
    case 'save':
    case 'create':
    case 'delete':
      return t(`themeAgent.history.${change.kind}`, { theme: isolated(change.theme) });
    case 'rename':
      return t('themeAgent.history.rename', { theme: isolated(change.theme), was: isolated(change.was) });
    case 'reset':
      return t('themeAgent.history.reset');
    case 'schedule':
      return t('themeAgent.history.schedule');
    case 'hold':
      return t('themeAgent.history.hold', { theme: named(change.themeId, change.theme), look: t(`themeAgent.look.${change.look}`) });
    case 'resume':
      return t('themeAgent.history.resume');
    case 'projectLook':
      return t(`themeAgent.history.projectLook.${change.look}`, { project: isolated(change.project) });
    case 'storeRemoved':
      return t('themeAgent.history.storeRemoved', { themes: listText(locale, change.themes.map(isolated)) });
    case 'wallpapersOff':
      return t('themeAgent.history.wallpapersOff');
    case 'restore':
      return t('themeAgent.history.restore', { change: historyChangeText({ t, locale }, change.before) });
    case 'other':
      return t('themeAgent.history.other');
  }
}

/** One line of a proposal in words, each name in it marked as user text (isolated): show it through IsolatedText. */
export function changeItemText({ t, locale }: Words, item: ThemeChangeItem): string {
  switch (item.kind) {
    case 'name':
      return t('themeAgent.change.name', { name: isolated(item.name) });
    case 'look':
      return t(item.added ? 'themeAgent.change.lookAdded' : 'themeAgent.change.lookRemoved', { look: t(`themeAgent.look.${item.look}`) });
    case 'color':
      return t('themeAgent.change.color', { look: t(`themeAgent.look.${item.look}`), color: t(`themeAgent.seed.${item.seed}`), hex: item.hex });
    case 'tokens':
      return t('themeAgent.change.tokens', { look: t(`themeAgent.look.${item.look}`), n: item.count }, item.count);
    case 'font':
      return item.family === null ? t(`themeAgent.change.fontDefault.${item.role}`) : t(`themeAgent.change.font.${item.role}`, { family: item.family });
    case 'lineHeight':
    case 'radius':
    case 'density':
      return item.value === null ? t(`themeAgent.change.default.${item.kind}`) : t(`themeAgent.change.${item.kind}`, { value: numberText(locale, item.value) });
    case 'chatColumn':
      if (item.value === null) return t('themeAgent.change.default.chatColumn');
      return item.value === 'full' ? t('themeAgent.change.chatColumnFull') : t('themeAgent.change.chatColumn', { value: numberText(locale, item.value) });
    case 'pick':
      return t('themeAgent.change.pick', { looks: looksText(t, item.looks) });
    case 'wallpapers':
      return item.panels === 0
        ? t('themeAgent.change.wallpapersNone', { look: t(`themeAgent.look.${item.look}`) })
        : t('themeAgent.change.wallpapers', { look: t(`themeAgent.look.${item.look}`), n: item.panels }, item.panels);
    case 'surfaceOpacity':
      return item.value === null
        ? t('themeAgent.change.default.surfaceOpacity', { look: t(`themeAgent.look.${item.look}`) })
        : t('themeAgent.change.surfaceOpacity', { look: t(`themeAgent.look.${item.look}`), value: Math.round(item.value * 100) });
    case 'cycle':
      return item.minutes === null
        ? t('themeAgent.change.cycleShortcut', { look: t(`themeAgent.look.${item.look}`) })
        : t('themeAgent.change.cycle', { look: t(`themeAgent.look.${item.look}`), n: item.minutes }, item.minutes);
    case 'paletteFromWallpaper':
      return t('themeAgent.change.paletteFromWallpaper', { look: t(`themeAgent.look.${item.look}`) });
    case 'wallpapersOff':
      return t('themeAgent.change.wallpapersOff');
    case 'layout':
      return t(item.cleared ? 'themeAgent.change.layoutCleared' : 'themeAgent.change.layout');
    case 'arrangementApplies':
      return t('themeAgent.change.arrangementApplies');
    case 'css':
      return t(item.cleared ? 'themeAgent.change.cssCleared' : 'themeAgent.change.css', { region: t(`themeAgent.cssRegion.${item.region}`) });
    case 'characters':
      return item.count === 0 ? t('themeAgent.change.charactersNone') : t('themeAgent.change.characters', { n: item.count }, item.count);
    case 'schedule':
      return item.enabled ? t('themeAgent.change.scheduleOn', { n: item.rules }, item.rules) : t('themeAgent.change.scheduleOff');
    case 'projectLook':
      if (item.look === 'none') return t('themeAgent.change.projectLookNone', { project: isolated(item.project) });
      if (item.look === 'full') return t(`themeAgent.change.projectLookFull.${item.themeLook ?? 'auto'}`, { project: isolated(item.project), theme: isolated(item.theme ?? '') });
      return t('themeAgent.change.projectLookTouches', { project: isolated(item.project), touches: listText(locale, (item.touches ?? []).map((touch) => t(`themeAgent.change.touch.${touch}`))) });
    case 'undo':
      return t('themeAgent.change.undo', { change: historyChangeText({ t, locale }, item.change) });
  }
}

export function contrastText({ t, locale }: Words, issue: ThemeContrastIssue): string {
  if (issue.rule === 'format') return t('themeAgent.contrast.format', { fg: issue.fg });
  return t('themeAgent.contrast.issue', { fg: issue.fg, bg: issue.bg, ratio: ratioText(locale, issue.ratio), need: ratioText(locale, issue.min) });
}

/** Where a removed part of the theme's CSS was and why the sanitizer removed it; its text renders apart, as code. */
export function droppedCssText({ t, locale }: Words, part: CssDroppedPart): string {
  const limit = cssDropReasonArgs(part.reason, locale);
  const named = { region: t(`themeAgent.cssRegion.${part.region}`), reason: t(`themeAgent.dropped.reason.${part.reason}`, limit.named, limit.count) };
  return part.line === undefined ? t('themeAgent.dropped.partNoLine', named) : t('themeAgent.dropped.part', { ...named, line: part.line });
}
