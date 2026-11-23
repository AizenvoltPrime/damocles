// Main's read of an unsettled on-the-fly change (docs/invariants.md "Desktop themes"): appearance.json's pendingConfirm and its
// history entry's before-snapshot, which main paints without writing anything; core alone reverts the files.
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { ConfigNotices } from '../../../core/config/local-config-path';
import { readFileBytes } from '../../../core/file-bytes';
import { createThemePathRule, type ThemePathRule } from '../../../core/themes/network-rule';
import { pendingConfirmOf, type PendingConfirm } from '../../../shared/themes/agent';
import { BUILTIN_THEME_ID } from '../../../shared/themes/builtin';
import { HISTORY_FILE, HISTORY_FOLDER, HISTORY_VERSION, MAX_HISTORY_BYTES, MAX_STATE_FILE_BYTES } from '../../../shared/themes/limits';
import { APPEARANCE_FILE, parseAppearanceSchedule } from '../../../shared/themes/schedule';
import { LOOK_KINDS, type LookKind } from '../../../shared/themes/tokens';
import { parseProjectLooks } from '../../../shared/themes/project-looks';
import { parseStoredJson } from '../../../shared/themes/stored-json';
import { THEME_PREFERENCES, type ThemePreference } from '../../local-services/desktop-configuration';
import type { HeldLook } from '../theme';
import { themeEntry, type LibraryEntry } from './theme-files';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * This app among those that share the themes folder (COUNTDOWN_OWNER), from its userData folder: Electron's single-instance
 * lock is per userData, so one app runs with it at a time and every run of that app has it.
 */
export const countdownOwnerOf = (userData: string): string => createHash('sha256').update(path.resolve(userData)).digest('hex').slice(0, 32);

const parsed = (text: unknown): unknown => {
  try {
    return typeof text === 'string' ? parseStoredJson(text) : undefined;
  } catch {
    return undefined;
  }
};

// files past their writer's size, each told once per run
const toldTooLarge = new Set<string>();

// A file of the themes folder as main read it: its JSON, no file there, or a file main could not read, which says nothing.
type StateRead = { readonly kind: 'json'; readonly value: unknown } | { readonly kind: 'missing' | 'unreadable' };

// `cap` is the size the file's writer keeps to: main parses on its own thread, so a larger file is never read.
async function readState(rule: ThemePathRule, file: string, cap: number, log: (line: string) => void): Promise<StateRead> {
  try {
    await rule.readable(file);
    const read = await readFileBytes(file, cap);
    if (read.kind === 'missing') return { kind: 'missing' };
    if (read.kind === 'tooLarge') {
      if (!toldTooLarge.has(file)) log(`[themes] ${file} is ${read.bytes} bytes, more than the ${cap} its writer keeps to, so it was not read`);
      toldTooLarge.add(file);
      return { kind: 'unreadable' };
    }
    if (read.kind !== 'bytes') throw new Error(read.kind === 'unreadable' ? read.error : 'it is not a file');
    return { kind: 'json', value: parseStoredJson(read.bytes.toString('utf8')) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    log(`[themes] ${file} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return { kind: 'unreadable' };
  }
}

/**
 * A JSON file of the themes folder, which core writes, read under main's network rule: undefined when it is missing, refused,
 * too large or does not parse.
 */
export async function readStateJson(rule: ThemePathRule, file: string, cap: number, log: (line: string) => void): Promise<unknown> {
  const read = await readState(rule, file, cap, log);
  return read.kind === 'json' ? read.value : undefined;
}

const readAppearance = (rule: ThemePathRule, root: string, log: (line: string) => void): Promise<unknown> => readStateJson(rule, path.join(root, APPEARANCE_FILE), MAX_STATE_FILE_BYTES, log);
// The history's entries, oldest first; none for a file of another version, as core lists it.
const readHistory = async (rule: ThemePathRule, root: string, log: (line: string) => void): Promise<readonly unknown[]> => {
  const history = await readStateJson(rule, path.join(root, HISTORY_FOLDER, HISTORY_FILE), MAX_HISTORY_BYTES, log);
  return isRecord(history) && history['version'] === HISTORY_VERSION && Array.isArray(history['entries']) ? history['entries'] : [];
};

/**
 * The look a before-snapshot describes, each item only when the snapshot holds it; a theme text that does not parse is listed
 * broken, as any file, and a setting that was not there reads as its default.
 */
export function heldLookOf(before: unknown): HeldLook | undefined {
  if (!isRecord(before)) return undefined;
  const preferred: Partial<Record<LookKind, string>> = {};
  const settings = isRecord(before['settings']) ? before['settings'] : {};
  for (const kind of LOOK_KINDS) {
    if (!Object.hasOwn(settings, kind)) continue;
    const value = settings[kind];
    preferred[kind] = typeof value === 'string' && value !== '' ? value : BUILTIN_THEME_ID;
  }
  const themes = new Map<string, LibraryEntry | undefined>();
  for (const [id, text] of Object.entries(isRecord(before['themes']) ? before['themes'] : {})) {
    if (text === null) {
      themes.set(id, undefined);
      continue;
    }
    themes.set(id, themeEntry(id, parsed(text)));
  }
  const mode = before['mode'];
  return {
    preferred,
    themes,
    ...(Object.hasOwn(before, 'projects') ? { projectLooks: parseProjectLooks(parsed(before['projects'])) } : {}),
    ...(Object.hasOwn(before, 'mode') ? { mode: THEME_PREFERENCES.includes(mode as ThemePreference) ? (mode as ThemePreference) : 'system' } : {}),
    ...(Object.hasOwn(before, 'appearance') ? { schedule: parseAppearanceSchedule(parsed(before['appearance'])) } : {}),
    ...(Object.hasOwn(before, 'showWallpapers') ? { showWallpapers: before['showWallpapers'] !== false } : {}),
  };
}

/** The before-snapshot of a countdown's changes, the marked entry's and every later one's, each item as the oldest held it. */
export function countdownBefore(entries: readonly unknown[], entryId: string): Record<string, unknown> | undefined {
  const index = entries.findIndex((candidate) => isRecord(candidate) && candidate['id'] === entryId);
  if (index < 0) return undefined;
  const before: Record<string, unknown> = {};
  const settings: Record<string, unknown> = {};
  const themes: Record<string, unknown> = {};
  // newest first, so each older value replaces a newer one
  for (const entry of entries.slice(index).reverse()) {
    const snapshot = isRecord(entry) && isRecord(entry['before']) ? entry['before'] : {};
    for (const [key, value] of Object.entries(snapshot)) {
      if (key === 'settings' && isRecord(value)) Object.assign(settings, value);
      else if (key === 'themes' && isRecord(value)) Object.assign(themes, value);
      else before[key] = value;
    }
  }
  return { ...before, ...(Object.keys(settings).length > 0 ? { settings } : {}), ...(Object.keys(themes).length > 0 ? { themes } : {}) };
}

/**
 * How the countdown of `entryId` stands for an engine that started after the one that ran it ended: marked while
 * appearance.json still names it, else kept while its entry is still in the history, else reverted. Unknown when a file the
 * answer needs is there and main cannot read it, or is of another version: such a file names no end.
 */
export async function readCountdownEnd(root: string, entryId: string, log: (line: string) => void, notices?: ConfigNotices): Promise<'marked' | 'kept' | 'reverted' | 'unknown'> {
  const rule = createThemePathRule(root, notices);
  const appearance = await readState(rule, path.join(root, APPEARANCE_FILE), MAX_STATE_FILE_BYTES, log);
  if (appearance.kind === 'unreadable') return 'unknown';
  if (appearance.kind === 'json') {
    if (!isRecord(appearance.value) || appearance.value['version'] !== 1) return 'unknown';
    if (pendingConfirmOf(appearance.value)?.entryId === entryId) return 'marked';
  }
  const history = await readState(rule, path.join(root, HISTORY_FOLDER, HISTORY_FILE), MAX_HISTORY_BYTES, log);
  if (history.kind === 'missing') return 'reverted';
  const entries = history.kind === 'json' && isRecord(history.value) && history.value['version'] === HISTORY_VERSION ? history.value['entries'] : undefined;
  if (!Array.isArray(entries)) return 'unknown';
  return entries.some((entry) => isRecord(entry) && entry['id'] === entryId) ? 'kept' : 'reverted';
}

/**
 * The unsettled countdown, the look from before its first change and the window arrangement its changes replaced; undefined
 * when appearance.json holds no mark or its entry is gone.
 */
export async function readPendingBefore(root: string, log: (line: string) => void, notices?: ConfigNotices): Promise<{ readonly mark: PendingConfirm; readonly look: HeldLook; readonly arrangement?: unknown } | undefined> {
  const rule = createThemePathRule(root, notices);
  const appearance = await readAppearance(rule, root, log);
  const mark = isRecord(appearance) && appearance['version'] === 1 ? pendingConfirmOf(appearance) : undefined;
  if (!mark) return undefined;
  const before = countdownBefore(await readHistory(rule, root, log), mark.entryId);
  const look = heldLookOf(before);
  return look ? { mark, look, ...(before?.['arrangement'] !== undefined ? { arrangement: before['arrangement'] } : {}) } : undefined;
}
