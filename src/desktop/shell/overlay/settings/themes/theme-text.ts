// The words Settings › Appearance's themes use for history entries, origins and pick names; core stores only data.
import { isolated } from '@shared/bidi-isolate';
import { SYSTEM_THEME_ID } from '@shared/themes/builtin';
import { restoredChange, type ThemeChange, type ThemeHistoryChange, type ThemeHistoryEntry } from '@shared/themes/changes';
import type { ThemeFile } from '@shared/themes/schema';
import type { LookKind } from '@shared/themes/tokens';

type Translate = (key: string, values?: Record<string, unknown>) => string;

const T = 'settingsHost.themes';

/** A span of whole seconds as the UI language writes it: "15 seconds". */
export const secondsText = (locale: string, ms: number): string => new Intl.NumberFormat(locale, { style: 'unit', unit: 'second', unitDisplay: 'long' }).format(ms / 1000);

/** A change in words, each name in it marked as user text (isolated): show it through IsolatedText. */
export function changeText(t: Translate, change: ThemeHistoryChange): string {
  if (change.kind === 'restore') return t(`${T}.change.restore`, { change: plainChange(t, change.before) });
  return plainChange(t, change);
}

/** The change a Restore of `change` goes back to before, for a sentence that already says "restore". */
export function restoredChangeText(t: Translate, change: ThemeHistoryChange): string {
  return plainChange(t, restoredChange(change));
}

/**
 * What the page says when a call to main failed. A rejected invoke's message is Electron's English wrapper around main's
 * error, so it goes to the console and the page shows its own sentence.
 */
export function failureText(t: Translate, err: unknown, what: 'load' | 'action' | 'install'): string {
  console.error(`[themes] main refused a theme ${what}`, err);
  return t(`${T}.failed.${what}`);
}

function plainChange(t: Translate, change: ThemeChange): string {
  switch (change.kind) {
    case 'pick':
      return change.was === undefined
        ? t(`${T}.change.pickNoPrevious.${change.look}`, { theme: isolated(change.theme) })
        : t(`${T}.change.pick.${change.look}`, { theme: isolated(change.theme), was: isolated(change.was) });
    case 'rename':
      return t(`${T}.change.rename`, { theme: isolated(change.theme), was: isolated(change.was) });
    case 'reset':
      return t(`${T}.change.reset`);
    case 'schedule': {
      const schedule = change.enabled ? t(`${T}.change.scheduleOn`, { n: change.rules }) : t(`${T}.change.scheduleOff`);
      return change.mode === undefined ? schedule : t(`${T}.change.withMode.${change.mode}`, { change: schedule });
    }
    case 'hold':
      return t(`${T}.change.hold.${change.look}`, { theme: isolated(change.theme) });
    case 'resume':
      return t(`${T}.change.resume`);
    case 'projectLook':
      return t(`${T}.change.projectLook.${change.look}`, { project: isolated(change.project) });
    case 'storeRemoved':
      return t(`${T}.change.storeRemoved`, { themes: change.themes.map(isolated).join(', ') });
    case 'wallpapersOff':
      return t(`${T}.change.wallpapersOff`);
    case 'other':
      return t(`${T}.change.other`);
    case 'save':
    case 'create': {
      // an agent's apply also picks the theme for the looks it names
      const picked = change.picked ?? [];
      if (picked.length === 0) return t(`${T}.change.${change.kind}`, { theme: isolated(change.theme) });
      const looks = picked.includes('dark') && picked.includes('light') ? 'both' : picked[0]!;
      return t(`${T}.change.${change.kind}Picked.${looks}`, { theme: isolated(change.theme) });
    }
    default:
      return t(`${T}.change.${change.kind}`, { theme: isolated(change.theme) });
  }
}

export function whoAndWhen(t: Translate, entry: ThemeHistoryEntry, locale: string): string {
  const actor = entry.actor;
  const who = actor.kind === 'user' ? t(`${T}.history.you`) : actor.title === '' ? t(`${T}.history.agentUntitled`) : t(`${T}.history.agent`, { title: isolated(actor.title) });
  const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(entry.at);
  return t(`${T}.history.when`, { who, time });
}

/** Where a theme came from, as its card's origin line says it; fromName is the source's name while it is installed. */
export function originText(t: Translate, theme: ThemeFile, builtin: boolean, fromName: string | undefined): string {
  // System colors' description is Damocles' own text, which its card says in the UI's language
  if (theme.id === SYSTEM_THEME_ID) return t(`${T}.system.description`);
  if (builtin) return t(`${T}.origin.builtin`);
  const origin = theme.origin;
  if (!origin || origin.kind === 'created') return t(`${T}.origin.created`);
  if (origin.kind === 'duplicate') return fromName !== undefined ? t(`${T}.origin.copyOf`, { name: isolated(fromName) }) : t(`${T}.origin.copy`);
  if (origin.kind === 'store' && origin.store) return t(`${T}.origin.storeVersion`, { version: origin.store.version });
  return t(`${T}.origin.${origin.kind}`);
}

export function looksText(t: Translate, theme: ThemeFile): string {
  const { dark, light } = theme.looks;
  return t(`${T}.looks.${dark && light ? 'both' : dark ? 'dark' : 'light'}`);
}

/** The miniature's accessible name: "Bleach, dark and light looks". */
export function miniatureLabel(t: Translate, name: string, theme: ThemeFile): string {
  const { dark, light } = theme.looks;
  return t(`${T}.miniature.${dark && light ? 'both' : dark ? 'dark' : 'light'}`, { name });
}

/** A pick's accessible name: "Bleach, dark", with ", active" while it shows and ", selected" while it is pressed but not shown. */
export function pickName(t: Translate, name: string, kind: LookKind, state: 'active' | 'selected' | undefined): string {
  const suffix = state === 'active' ? 'Active' : state === 'selected' ? 'Selected' : '';
  return t(`${T}.pick.${kind}${suffix}`, { name });
}
