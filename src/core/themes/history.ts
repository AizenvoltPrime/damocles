// The theme undo history (docs/invariants.md "Desktop themes"): history/index.json, a ring of HISTORY_LIMIT entries, each
// holding the before-snapshots of what its change touched and who made it. Every method runs inside the store's write lane.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isChangeKind, MAX_CHANGE_ID_CHARS, parseThemeActor, parseThemeHistoryChange, restoredChange, type ThemeActor, type ThemeHistoryChange, type ThemeHistoryEntry } from '../../shared/themes/changes';
import { LocalizedError } from '../../shared/localized-text';
import { HISTORY_FILE, HISTORY_FOLDER, HISTORY_LIMIT, HISTORY_VERSION, MAX_HISTORY_BYTES, USER_THEME_ID } from '../../shared/themes/limits';
import { LOOK_KINDS, type LookKind } from '../../shared/themes/tokens';
import { l } from '../l10n';
import { createThemePathRule, type ThemePathRule } from './network-rule';
import { readCappedOrNull, readVersioned, UnreadableFile } from './state-file';

export { HISTORY_FILE, HISTORY_FOLDER, HISTORY_LIMIT, HISTORY_VERSION, MAX_HISTORY_BYTES };
// The user's schedule edits no further apart than this are one run, and one entry (docs/invariants.md "Desktop themes").
export const SCHEDULE_FOLD_GAP_MS = 30_000;

/** What a change touched, as it was before: a value of null means the key, file or theme was not there. */
export interface Snapshot {
  // damocles.desktop.themes.dark and .light in the user settings file
  readonly settings?: Partial<Record<LookKind, string | null>>;
  // damocles.desktop.theme in the user settings file
  readonly mode?: string | null;
  // damocles.desktop.themes.showWallpapers in the user settings file
  readonly showWallpapers?: boolean | null;
  // appearance.json's text
  readonly appearance?: string | null;
  // theme.json texts by theme id
  readonly themes?: Readonly<Record<string, string | null>>;
  // projects.json's text: the characters projects pin
  readonly projects?: string | null;
  // the window arrangement main applied with a pick (src/shared/themes/schema.ts Arrangement); main checks it again
  readonly arrangement?: unknown;
}

export interface StoredEntry extends ThemeHistoryEntry {
  readonly before: Snapshot;
  // the change as a newer Damocles wrote it, which the file keeps while this one reads the entry as `other`
  readonly foreign?: unknown;
}

/** Reads and writes what a snapshot holds; the caller holds the write lane. */
export interface SnapshotIo {
  readSettings(): Promise<Record<LookKind, string | null>>;
  writeSettings(values: Partial<Record<LookKind, string | null>>): Promise<void>;
  readMode(): Promise<string | null>;
  writeMode(value: string | null): Promise<void>;
  readShowWallpapers(): Promise<boolean | null>;
  writeShowWallpapers(value: boolean | null): Promise<void>;
  readAppearance(): Promise<string | null>;
  writeAppearance(text: string | null): Promise<void>;
  readTheme(id: string): Promise<string | null>;
  writeTheme(id: string, text: string | null): Promise<void>;
  readProjects(): Promise<string | null>;
  writeProjects(text: string | null): Promise<void>;
}

export interface ThemeHistory {
  // newest first; none for a file of another version, which a newer Damocles owns
  entries(): Promise<readonly StoredEntry[]>;
  // entries() for a change, which is refused for a file of another version: every method that writes the file refuses it so
  editable(): Promise<readonly StoredEntry[]>;
  // The id of the entry that holds the change: a new one, or the newest entry when the change continues the user's run of
  // schedule edits, which then keeps its oldest before-values. `id` fixes the new entry's id, and such an entry never folds.
  // `from` is entries() as the caller read it in this lane run, so the file is read once.
  record(actor: ThemeActor, change: ThemeHistoryChange, before: Snapshot, options?: { readonly id?: string; readonly from?: readonly StoredEntry[] }): Promise<string>;
  // folds a later change into entry `entryId`: each item keeps the oldest before-value, and the entry takes `change`
  extend(entryId: string, change: ThemeHistoryChange, before: Snapshot, from?: readonly StoredEntry[]): Promise<void>;
  // puts back what a change that failed part-way had written: each item as the first of `taken` to hold it had it
  rollBack(taken: readonly Snapshot[]): Promise<void>;
  newId(): string;
  // applies the before-snapshot of `entryId` alone and returns the change and before-snapshot of a new entry that would reverse
  // it, which the caller records; the caller checked that no later entry touched the same items. `arrangementNow` is the
  // window's arrangement, which the new entry keeps when the revert puts an earlier one back. `taking` hears that
  // before-snapshot before anything is written
  revert(entryId: string, arrangementNow?: unknown, taking?: (before: Snapshot) => void): Promise<{ readonly reverted: StoredEntry; readonly change: ThemeHistoryChange; readonly before: Snapshot }>;
  // the newest entry, its before-snapshot applied and the entry dropped; undefined when there is none. `expected` names the
  // entry the caller means: when another is the newest, or none is left, nothing is undone and the call is refused.
  // undo, undoThrough and restore are whole or not at all: `then` runs last, and a failure at any step, its own included,
  // puts back every file written and the history
  undo(expected?: string, then?: (undone: StoredEntry) => Promise<void>): Promise<StoredEntry | undefined>;
  // `entryId` and every later entry undone, newest first, and dropped; the undone entries newest first and the arrangement they
  // put back. Nothing when `entryId` is not in the history.
  undoThrough(entryId: string, then?: () => Promise<void>): Promise<{ readonly undone: readonly StoredEntry[]; readonly arrangement?: unknown }>;
  // the before-snapshots of `entryId` and every later entry, newest first, applied as one new entry; `arrangementNow` is the
  // window's arrangement, which that entry keeps when the restore puts an earlier one back. Returns the arrangement restored.
  restore(entryId: string, actor: ThemeActor, arrangementNow?: unknown): Promise<{ readonly arrangement?: unknown }>;
  // runs `transform` over every entry's projects.json snapshot, so a later undo restores looks and pins under keys that still
  // exist; a file of another version is left as it is
  mapProjects(transform: (text: string | null) => string | null): Promise<void>;
}

export interface ThemeHistoryOptions {
  // ~/.damocles/themes
  readonly root: string;
  readonly io: SnapshotIo;
  readonly writeText: (file: string, text: string) => Promise<void>;
  readonly newId?: () => string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  // the network rule the history file is judged by; absent: the root's own, with no notice
  readonly rule?: ThemePathRule;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): boolean => value === undefined || value === null || typeof value === 'string';

// A before-snapshot whose every value can be written back as it is; keys this version does not know are left alone.
function isSnapshot(raw: Record<string, unknown>): boolean {
  const { settings, themes, showWallpapers } = raw;
  if (settings !== undefined && !(isRecord(settings) && Object.entries(settings).every(([kind, value]) => (LOOK_KINDS as readonly string[]).includes(kind) && textOrNull(value)))) return false;
  if (themes !== undefined && !(isRecord(themes) && Object.entries(themes).every(([id, value]) => USER_THEME_ID.test(id) && textOrNull(value)))) return false;
  if (showWallpapers !== undefined && showWallpapers !== null && typeof showWallpapers !== 'boolean') return false;
  return textOrNull(raw['mode']) && textOrNull(raw['appearance']) && textOrNull(raw['projects']);
}

// A change of a kind a newer Damocles records, a Restore of one included.
const isForeign = (change: Record<string, unknown>): boolean =>
  (change['kind'] === 'restore' && isRecord(change['before']) ? !isChangeKind(change['before']['kind']) : !isChangeKind(change['kind']));

// An entry as the file holds it, within what the core protocol carries (src/shared/themes/changes.ts). An entry of a newer
// Damocles' change kind is kept and read as `other`; anything else it cannot read is dropped, since it cannot be undone.
function storedEntry(raw: unknown): StoredEntry | undefined {
  if (!isRecord(raw) || !isRecord(raw['change']) || !isRecord(raw['before'])) return undefined;
  const { id, at } = raw;
  if (typeof id !== 'string' || id === '' || id.length > MAX_CHANGE_ID_CHARS || typeof at !== 'number' || !Number.isFinite(at) || !parseThemeActor(raw['actor'])) return undefined;
  const applies = isSnapshot(raw['before']);
  if (parseThemeHistoryChange(raw['change'])) return applies ? (raw as unknown as StoredEntry) : undefined;
  if (!isForeign(raw['change'])) return undefined;
  return { ...raw, change: { kind: 'other' }, foreign: raw['change'], ...(applies ? {} : { cannotUndo: true }) } as unknown as StoredEntry;
}

// The entry as the file holds it: a newer Damocles' change goes back as it was written.
const fileEntry = ({ foreign, cannotUndo: _cannotUndo, ...entry }: StoredEntry): object => (foreign === undefined ? entry : { ...entry, change: foreign });

// A before-snapshot this Damocles cannot write back stops an undo or a restore that would reach it, before anything is written.
function reachable(entries: readonly StoredEntry[]): void {
  if (entries.some((entry) => entry.cannotUndo)) throw new LocalizedError(l('A newer Damocles made a theme change that this one cannot undo, so nothing was changed.'));
}

/**
 * The items a snapshot holds: each preferred-look setting, the mode, Show wallpapers, appearance.json, each theme file,
 * projects.json and the arrangement.
 */
export function touchedItems(before: Snapshot): string[] {
  return [
    ...Object.keys(before.settings ?? {}).map((kind) => `settings:${kind}`),
    ...(before.mode !== undefined ? ['mode'] : []),
    ...(before.showWallpapers !== undefined ? ['showWallpapers'] : []),
    ...(before.appearance !== undefined ? ['appearance'] : []),
    ...Object.keys(before.themes ?? {}).map((id) => `theme:${id}`),
    ...(before.projects !== undefined ? ['projects'] : []),
    ...(before.arrangement !== undefined ? ['arrangement'] : []),
  ];
}

/** The snapshot of everything `snapshots` touched, each item as the oldest of them had it. */
function combined(snapshots: readonly Snapshot[]): Snapshot {
  const settings: Partial<Record<LookKind, string | null>> = {};
  const themes: Record<string, string | null> = {};
  let appearance: string | null | undefined;
  let mode: string | null | undefined;
  let showWallpapers: boolean | null | undefined;
  let projects: string | null | undefined;
  let arrangement: unknown;
  // newest first, so each older value replaces a newer one
  for (const before of snapshots) {
    Object.assign(settings, before.settings ?? {});
    Object.assign(themes, before.themes ?? {});
    if (before.appearance !== undefined) appearance = before.appearance;
    if (before.mode !== undefined) mode = before.mode;
    if (before.showWallpapers !== undefined) showWallpapers = before.showWallpapers;
    if (before.projects !== undefined) projects = before.projects;
    if (before.arrangement !== undefined) arrangement = before.arrangement;
  }
  return {
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(showWallpapers !== undefined ? { showWallpapers } : {}),
    ...(appearance !== undefined ? { appearance } : {}),
    ...(Object.keys(themes).length > 0 ? { themes } : {}),
    ...(projects !== undefined ? { projects } : {}),
    ...(arrangement !== undefined ? { arrangement } : {}),
  };
}

export function createThemeHistory(options: ThemeHistoryOptions): ThemeHistory {
  const file = path.join(options.root, HISTORY_FOLDER, HISTORY_FILE);
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? Date.now;
  const { io } = options;
  const rule = options.rule ?? createThemePathRule(options.root);

  // oldest first; 'other' for a file that states another version
  const load = async (): Promise<StoredEntry[] | 'other'> => {
    // only a file that is not there, is past its writer's cap or is no history of any version starts empty: any other
    // failure may pass, and starting empty then would replace every entry with the next one
    await rule.readable(file);
    let text: string | null;
    try {
      text = await readCappedOrNull(file, MAX_HISTORY_BYTES);
    } catch (err) {
      if (!(err instanceof UnreadableFile) || err.reason !== 'tooLarge') throw err;
      options.log?.(`[themes] the theme history is larger than this Damocles writes it, so it starts empty: ${err.message}`);
      return [];
    }
    if (text === null) return [];
    const parsed = readVersioned(text, HISTORY_VERSION);
    if (parsed.kind === 'other') return 'other';
    const stored = parsed.kind === 'ok' ? parsed.json['entries'] : undefined;
    if (!Array.isArray(stored)) {
      options.log?.('[themes] the theme history is no JSON object stating its version and its entries, so it starts empty');
      return [];
    }
    return stored.flatMap((raw) => storedEntry(raw) ?? []);
  };
  const read = async (): Promise<StoredEntry[]> => {
    const entries = await load();
    return entries === 'other' ? [] : entries;
  };
  // oldest first, for a method that writes the file
  const editable = async (): Promise<StoredEntry[]> => {
    const entries = await load();
    if (entries === 'other') {
      throw new LocalizedError(l('{0} was written by a newer Damocles, so this one leaves it as it is. Update Damocles to change it.', `${HISTORY_FOLDER}/${HISTORY_FILE}`));
    }
    return entries;
  };

  const write = async (entries: readonly StoredEntry[]): Promise<void> => {
    let kept = entries.slice(-HISTORY_LIMIT);
    let text = `${JSON.stringify({ version: HISTORY_VERSION, entries: kept.map(fileEntry) })}\n`;
    while (kept.length > 1 && Buffer.byteLength(text) > MAX_HISTORY_BYTES) {
      kept = kept.slice(1);
      text = `${JSON.stringify({ version: HISTORY_VERSION, entries: kept.map(fileEntry) })}\n`;
    }
    await rule.writable(file);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await options.writeText(file, text);
  };

  // What `before` would undo, as it is now, so a restore can itself be undone.
  const current = async (before: Snapshot, arrangementNow: unknown): Promise<Snapshot> => {
    const settingsNow = before.settings ? await io.readSettings() : undefined;
    const settings = settingsNow ? Object.fromEntries(Object.keys(before.settings!).map((kind) => [kind, settingsNow[kind as LookKind]])) : undefined;
    const themes = before.themes ? Object.fromEntries(await Promise.all(Object.keys(before.themes).map(async (id) => [id, await io.readTheme(id)] as const))) : undefined;
    return {
      ...(settings ? { settings } : {}),
      ...(before.mode !== undefined ? { mode: await io.readMode() } : {}),
      ...(before.showWallpapers !== undefined ? { showWallpapers: await io.readShowWallpapers() } : {}),
      ...(before.appearance !== undefined ? { appearance: await io.readAppearance() } : {}),
      ...(themes ? { themes } : {}),
      ...(before.projects !== undefined ? { projects: await io.readProjects() } : {}),
      ...(before.arrangement !== undefined && arrangementNow !== undefined ? { arrangement: arrangementNow } : {}),
    };
  };

  const apply = async (before: Snapshot): Promise<void> => {
    for (const [id, text] of Object.entries(before.themes ?? {})) await io.writeTheme(id, text);
    if (before.appearance !== undefined) await io.writeAppearance(before.appearance);
    if (before.projects !== undefined) await io.writeProjects(before.projects);
    if (before.settings) await io.writeSettings(before.settings);
    if (before.mode !== undefined) await io.writeMode(before.mode);
    if (before.showWallpapers !== undefined) await io.writeShowWallpapers(before.showWallpapers);
  };

  const rollBack = async (taken: readonly Snapshot[]): Promise<void> => {
    const before = combined([...taken].reverse());
    const now = await current(before, undefined);
    // only what the failed change moved is written, so a file it never reached is not rewritten
    const moved = <V>(was: V | undefined, is: V | undefined): V | undefined => (was !== undefined && was !== is ? was : undefined);
    const settings = Object.fromEntries(Object.entries(before.settings ?? {}).filter(([kind, value]) => value !== now.settings?.[kind as LookKind]));
    const themes = Object.fromEntries(Object.entries(before.themes ?? {}).filter(([id, text]) => text !== now.themes?.[id]));
    const mode = moved(before.mode, now.mode);
    const showWallpapers = moved(before.showWallpapers, now.showWallpapers);
    const appearance = moved(before.appearance, now.appearance);
    const projects = moved(before.projects, now.projects);
    await apply({
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
      ...(Object.keys(themes).length > 0 ? { themes } : {}),
      ...(mode !== undefined ? { mode } : {}),
      ...(showWallpapers !== undefined ? { showWallpapers } : {}),
      ...(appearance !== undefined ? { appearance } : {}),
      ...(projects !== undefined ? { projects } : {}),
    });
  };

  // Applies `before`, writes the history as `next` and runs `then`. A failure at any step puts back the files it wrote and
  // the history as `entries`; when that fails too, the first failure is the one reported.
  const applyWhole = async (entries: readonly StoredEntry[], before: Snapshot, next: readonly StoredEntry[], then?: () => Promise<void>): Promise<void> => {
    const was = await current(before, undefined);
    let written = false;
    try {
      await apply(before);
      await write(next);
      written = true;
      await then?.();
    } catch (err) {
      try {
        await rollBack([was]);
        if (written) await write(entries);
      } catch (undoErr) {
        options.log?.(`[themes] an undo that failed could not be put back: ${undoErr instanceof Error ? undoErr.message : String(undoErr)}`);
      }
      throw err;
    }
  };

  return {
    entries: async () => (await read()).reverse(),
    editable: async () => (await editable()).reverse(),
    newId,
    async record(actor, change, before, recordOptions = {}) {
      const entries = recordOptions.from ? [...recordOptions.from].reverse() : await editable();
      const newest = entries.at(-1);
      const at = now();
      if (
        recordOptions.id === undefined && newest && actor.kind === 'user' && newest.actor.kind === 'user'
        && change.kind === 'schedule' && newest.change.kind === 'schedule' && at - newest.at <= SCHEDULE_FOLD_GAP_MS
      ) {
        // the run's entry says where it ended, and that it changed the mode when any of its edits did
        const mode = change.mode ?? newest.change.mode;
        const folded: StoredEntry = { ...newest, at, change: { ...change, ...(mode !== undefined ? { mode } : {}) }, before: combined([before, newest.before]) };
        await write([...entries.slice(0, -1), folded]);
        return newest.id;
      }
      const id = recordOptions.id ?? newId();
      await write([...entries, { id, at, actor, change, before }]);
      return id;
    },
    rollBack,
    async extend(entryId, change, before, from) {
      const entries = from ? [...from].reverse() : await editable();
      const index = entries.findIndex((entry) => entry.id === entryId);
      const target = entries[index];
      if (!target) throw new Error(`No theme history entry ${entryId}`);
      // newest first, so the entry's own older values win
      const merged = combined([before, target.before]);
      // the entry takes this Damocles' change, so a newer one's it was read from no longer stands for it
      const { foreign: _foreign, ...own } = target;
      await write(entries.map((entry, at) => (at === index ? { ...own, at: now(), change, before: merged } : entry)));
    },
    async revert(entryId, arrangementNow, taking) {
      const target = (await editable()).find((entry) => entry.id === entryId);
      if (!target) throw new Error(`No theme history entry ${entryId}`);
      reachable([target]);
      const before = await current(target.before, arrangementNow);
      taking?.(before);
      await apply(target.before);
      return { reverted: target, change: { kind: 'restore', before: restoredChange(target.change) }, before };
    },
    async undo(expected, then) {
      const entries = await editable();
      const newest = entries.at(-1);
      if (expected !== undefined && newest?.id !== expected) throw new LocalizedError(l('Another theme change was made after this one, so nothing was undone.'));
      if (!newest) return undefined;
      reachable([newest]);
      await applyWhole(entries, newest.before, entries.slice(0, -1), then && (() => then(newest)));
      return newest;
    },
    async undoThrough(entryId, then) {
      const entries = await editable();
      const index = entries.findIndex((entry) => entry.id === entryId);
      if (index < 0) return { undone: [] };
      const undone = entries.slice(index).reverse();
      reachable(undone);
      const before = combined(undone.map((entry) => entry.before));
      await applyWhole(entries, before, entries.slice(0, index), then);
      return { undone, ...(before.arrangement !== undefined ? { arrangement: before.arrangement } : {}) };
    },
    async restore(entryId, actor, arrangementNow) {
      const entries = await editable();
      const index = entries.findIndex((entry) => entry.id === entryId);
      const target = entries[index];
      if (!target) throw new Error(`No theme history entry ${entryId}`);
      reachable(entries.slice(index));
      const before = combined(entries.slice(index).reverse().map((entry) => entry.before));
      const undo = await current(before, arrangementNow);
      await applyWhole(entries, before, [...entries, { id: newId(), at: now(), actor, change: { kind: 'restore', before: restoredChange(target.change) }, before: undo }]);
      return before.arrangement !== undefined ? { arrangement: before.arrangement } : {};
    },
    async mapProjects(transform) {
      const entries = await load();
      if (entries === 'other') return;
      let changed = false;
      const mapped = entries.map((entry) => {
        if (entry.cannotUndo || entry.before.projects === undefined) return entry;
        const projects = transform(entry.before.projects);
        if (projects === entry.before.projects) return entry;
        changed = true;
        return { ...entry, before: { ...entry.before, projects } };
      });
      if (changed) await write(mapped);
    },
  };
}
