// What a theme history entry says it changed and who changed it, as data: core stores it, the renderers word it.
import type { LookKind } from './tokens';

// damocles.desktop.theme's values
export type ThemeModeValue = 'system' | 'dark' | 'light';

// Theme names as they were when the change was made, so an entry still reads right after a rename or a delete.
export type ThemeChange =
  | { readonly kind: 'pick'; readonly look: LookKind; readonly theme: string; readonly was: string }
  // picked: the looks an agent's apply also made the preferred ones
  | { readonly kind: 'save'; readonly theme: string; readonly picked?: readonly LookKind[] }
  | { readonly kind: 'create'; readonly theme: string; readonly picked?: readonly LookKind[] }
  // mode: damocles.desktop.theme when the same change set it
  | { readonly kind: 'schedule'; readonly enabled: boolean; readonly rules: number; readonly mode?: ThemeModeValue }
  // a look shown over a running schedule until its next rule start (Toggle Theme)
  | { readonly kind: 'hold'; readonly theme: string; readonly look: LookKind }
  // a pick that held over the schedule ended early
  | { readonly kind: 'resume' }
  | { readonly kind: 'rename'; readonly theme: string; readonly was: string }
  | { readonly kind: 'delete'; readonly theme: string }
  // a project's own look set on this computer; project: its name when it was set, look none when it was turned off
  | { readonly kind: 'projectLook'; readonly project: string; readonly look: 'none' | 'touches' | 'full' }
  // the community store's signed list removed these installed themes: each is marked, and the preferred looks, schedule rules and
  // project looks that named one moved to the built-in theme
  | { readonly kind: 'storeRemoved'; readonly themes: readonly string[] }
  // Show wallpapers turned off (an agent's ThemeSet wallpapersOff)
  | { readonly kind: 'wallpapersOff' }
  | { readonly kind: 'reset' }
  // a change of a kind a newer Damocles recorded, which this one cannot name; its entry stays in the history as it was written
  | { readonly kind: 'other' };

// A Restore names the change it went back to before; a restore of a restore names that one's change.
export type ThemeHistoryChange = ThemeChange | { readonly kind: 'restore'; readonly before: ThemeChange };

export type ThemeActor = { readonly kind: 'user' } | { readonly kind: 'agent'; readonly chatId: string; readonly title: string };

export const USER_ACTOR: ThemeActor = { kind: 'user' };

export interface ThemeHistoryEntry {
  readonly id: string;
  // ms since the epoch
  readonly at: number;
  readonly actor: ThemeActor;
  readonly change: ThemeHistoryChange;
  // its before-snapshot holds something this Damocles cannot write back, so no undo or restore reaches it or an older entry
  readonly cannotUndo?: true;
}

/** The change a Restore of an entry with `change` goes back to before. */
export const restoredChange = (change: ThemeHistoryChange): ThemeChange => (change.kind === 'restore' ? change.before : change);

// The bounds of a history entry's texts. The core protocol carries exactly what these parsers accept, so an entry the history
// reads is one core can send.
export const MAX_CHANGE_ID_CHARS = 128;
export const MAX_CHANGE_NAME_CHARS = 256;
export const MAX_CHANGE_LABEL_CHARS: number = 64 * 1024;
export const MAX_CHANGE_ITEMS = 100_000;

const CHANGE_KINDS = ['pick', 'save', 'create', 'schedule', 'hold', 'resume', 'rename', 'delete', 'projectLook', 'storeRemoved', 'wallpapersOff', 'reset', 'other'] as const satisfies readonly ThemeChange['kind'][];
// fails to compile while a ThemeChange kind has no entry above
true satisfies (Exclude<ThemeChange['kind'], (typeof CHANGE_KINDS)[number]> extends never ? true : false);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isName = (raw: unknown): raw is string => typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_CHANGE_NAME_CHARS;
const isLabel = (raw: unknown): raw is string => typeof raw === 'string' && raw.length <= MAX_CHANGE_LABEL_CHARS;
const isLook = (raw: unknown): raw is LookKind => raw === 'dark' || raw === 'light';
const isMode = (raw: unknown): raw is ThemeModeValue => raw === 'system' || raw === 'dark' || raw === 'light';

/** Whether `kind` is a change kind this Damocles records; a history entry of any other kind was written by a newer one. */
export const isChangeKind = (kind: unknown): boolean => kind === 'restore' || (CHANGE_KINDS as readonly unknown[]).includes(kind);

/** A change with exactly the fields of its kind; undefined for anything else. */
export function parseThemeChange(raw: unknown): ThemeChange | undefined {
  if (!isRecord(raw)) return undefined;
  const { theme, was, look } = raw;
  switch (raw['kind']) {
    case 'pick':
      return isLook(look) && isName(theme) && isName(was) ? { kind: 'pick', look, theme, was } : undefined;
    case 'save':
    case 'create': {
      const { picked } = raw;
      if (!isName(theme) || (picked !== undefined && !(Array.isArray(picked) && picked.length <= 2 && picked.every(isLook)))) return undefined;
      return { kind: raw['kind'], theme, ...(picked !== undefined ? { picked: picked as LookKind[] } : {}) };
    }
    case 'schedule': {
      const { enabled, rules, mode } = raw;
      if (typeof enabled !== 'boolean' || !Number.isInteger(rules) || (rules as number) < 0 || (rules as number) > MAX_CHANGE_ITEMS || (mode !== undefined && !isMode(mode))) return undefined;
      return { kind: 'schedule', enabled, rules: rules as number, ...(mode !== undefined ? { mode } : {}) };
    }
    case 'hold':
      return isName(theme) && isLook(look) ? { kind: 'hold', theme, look } : undefined;
    case 'rename':
      return isName(theme) && isName(was) ? { kind: 'rename', theme, was } : undefined;
    case 'delete':
      return isName(theme) ? { kind: 'delete', theme } : undefined;
    case 'projectLook': {
      const { project } = raw;
      return isLabel(project) && (look === 'none' || look === 'touches' || look === 'full') ? { kind: 'projectLook', project, look } : undefined;
    }
    case 'storeRemoved': {
      const { themes } = raw;
      return Array.isArray(themes) && themes.length <= MAX_CHANGE_ITEMS && themes.every(isName) ? { kind: 'storeRemoved', themes: themes as string[] } : undefined;
    }
    case 'resume':
    case 'wallpapersOff':
    case 'reset':
    case 'other':
      return { kind: raw['kind'] };
    default:
      return undefined;
  }
}

export function parseThemeHistoryChange(raw: unknown): ThemeHistoryChange | undefined {
  if (!isRecord(raw) || raw['kind'] !== 'restore') return parseThemeChange(raw);
  const before = parseThemeChange(raw['before']);
  return before ? { kind: 'restore', before } : undefined;
}

export function parseThemeActor(raw: unknown): ThemeActor | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw['kind'] === 'user') return USER_ACTOR;
  const { chatId, title } = raw;
  return raw['kind'] === 'agent' && typeof chatId === 'string' && chatId.length > 0 && chatId.length <= MAX_CHANGE_ID_CHARS && isLabel(title) ? { kind: 'agent', chatId, title } : undefined;
}
