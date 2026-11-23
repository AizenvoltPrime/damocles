// The theme files of this computer's desktop core (docs/invariants.md "Desktop themes"): core alone writes them, through one
// write lane, and main reads and validates them again before it paints.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { copiedLayoutOptIn } from '../../shared/themes/arrangement';
import { BUILTIN_THEME, BUILTIN_THEME_ID, BUILTIN_THEME_NAMES, isBuiltinThemeId, SYSTEM_THEME_ID } from '../../shared/themes/builtin';
import { portableBuiltinTheme } from '../../shared/themes/portable-builtin';
import { checkedSystemTheme, systemTheme, type SystemLooks } from '../../shared/themes/system-theme';
import { eachLimited } from '../../shared/each-limited';
import { READ_CONCURRENCY, USER_THEME_ID } from '../../shared/themes/limits';
import { checkSchemaVersion, pointerSegments, validateTheme, type Origin, type ThemeFile, themeErrorText } from '../../shared/themes/schema';
import { parseStoredJson } from '../../shared/themes/stored-json';
import { sanitizeThemeCss, themeCssFamilies } from '../../shared/themes/css-sanitizer';
import type { LookKind } from '../../shared/themes/tokens';
import { LocalizedError, type LocalizedText } from '../../shared/localized-text';
import type { Disposable } from '../../platform/disposable';
import { renameWithRetry, writeFlushed } from '../config/json-config-write';
import { errorTextOf, l, verbatim } from '../l10n';
import type { BuiltinExample } from './builtins';
import { createThemePathRule, type ThemePathRule } from './network-rule';
import { readCapped, UnreadableFile } from './state-file';
import { createWriteLane, type WriteLane } from './write-lane';

export const THEMES_FOLDER = 'themes';
export const THEME_FILE = 'theme.json';
// A theme.json is text: colors, names and at most 64 KB of CSS per region; images and fonts are blobs beside it.
export const MAX_THEME_FILE_BYTES: number = 4 * 1024 * 1024;

export type ThemeListEntry =
  | { readonly status: 'ok'; readonly id: string; readonly builtin: boolean; readonly name: string; readonly theme: ThemeFile }
  | { readonly status: 'broken'; readonly id: string; readonly name?: string; readonly reason: LocalizedText }
  | { readonly status: 'needsNewer'; readonly id: string; readonly name?: string; readonly version: number };

export const isUserThemeId = (id: string): boolean => USER_THEME_ID.test(id);

export const noLook = (name: string, kind: LookKind): LocalizedText =>
  kind === 'dark' ? l('The theme {0} has no dark look.', name) : l('The theme {0} has no light look.', name);

export interface ThemeStoreOptions {
  // ~/.damocles/themes (THEMES_DIR)
  readonly root: string;
  readonly lane?: WriteLane;
  // the network rule every path is judged by; absent: the root's own, with no notice
  readonly rule?: ThemePathRule;
  // replaces a file whole; a failure must leave the previous file as it was
  readonly writeText?: (file: string, text: string) => Promise<void>;
  readonly newId?: () => string;
  readonly now?: () => number;
  // the built-in example themes; none when absent
  readonly examples?: () => Promise<readonly BuiltinExample[]>;
  // the looks of System colors as the app last read them off this computer; absent: the Damocles seeds
  readonly system?: () => SystemLooks;
  readonly log?: (line: string) => void;
}

// The writes themselves, for a caller already inside the write lane; each returns the theme's name before the change.
export interface ThemeWrites {
  // replaces a user theme with `theme`, validated; keys the file has that this format does not know and its origin are kept
  saveTheme(id: string, theme: unknown): Promise<string>;
  // an editable copy of a theme, built-in or user, under `copyId`; Damocles' and System colors' copy is portableBuiltinTheme's
  duplicate(id: string, name: string, copyId: string): Promise<string>;
  // a new user theme, validated, under its own id, which no folder holds yet; core gives it `origin`
  create(theme: unknown, origin: Origin): Promise<string>;
  // `theme`, validated, written over the theme its id names; a failed write leaves that theme as it was
  replace(theme: unknown, origin: Origin): Promise<string>;
  rename(id: string, name: string): Promise<string>;
  remove(id: string): Promise<string>;
  // theme.json's text as it is on disk; null when the theme has no file
  readText(id: string): Promise<string | null>;
  // puts theme.json back as `text`, or removes the theme's folder for null; for undo, so the text is not checked again
  writeText(id: string, text: string | null): Promise<void>;
}

// It offers no write of its own: every change goes through the theme service, which records its history entry.
export interface ThemeStore {
  // the built-in theme first, then System colors, the built-in examples, and every theme folder under themes/, broken ones included, by name
  list(): Promise<ThemeListEntry[]>;
  readonly lane: WriteLane;
  readonly unlocked: ThemeWrites;
  readonly newId: () => string;
  // tells the listeners a write was made
  changed(): void;
  onDidChange(listener: () => void): Disposable;
}

export { eachLimited } from '../../shared/each-limited';
export { READ_CONCURRENCY } from '../../shared/themes/limits';

export interface AtomicWriteOptions {
  // the new file's mode before the umask; the store's own files are the user's alone
  readonly mode?: number;
  // the write lane's check, run before each rename attempt, so a writer that lost the store's lock replaces nothing
  readonly held?: () => void;
}

/**
 * Replaces `file` through a temporary file beside it, flushed and then renamed, so a reader sees the old file or the new one,
 * never part of one, and a crash leaves no empty file under its name. A failure removes the temporary file.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFlushed(temp, data, options.mode ?? 0o600);
    await renameWithRetry(temp, file, async () => options.held?.());
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
  // Windows opens no folder to flush; elsewhere the rename is in place either way, and this only makes it outlive a power loss
  if (process.platform !== 'win32') await syncFolder(path.dirname(file)).catch(() => undefined);
}

async function syncFolder(dir: string): Promise<void> {
  const handle = await fs.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const TEMP_FILE = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
// themes/<id>/, cache/<sha256>/ and the store list's folders
const TEMP_SWEEP_DEPTH = 3;

/**
 * Removes the temporary files of writeFileAtomic under `root` last written before `before`, which a crash between a write and
 * its rename left; how many went. Call inside the write lane: only its holder writes one.
 */
export async function removeOrphanedTemps(root: string, before: number, rule: ThemePathRule): Promise<number> {
  let removed = 0;
  const sweep = async (dir: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
      throw err;
    });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < TEMP_SWEEP_DEPTH) await sweep(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !TEMP_FILE.test(entry.name)) continue;
      const stat = await fs.stat(full).catch(() => undefined);
      if (!stat || stat.mtimeMs >= before) continue;
      await rule.writable(full);
      await fs.rm(full, { force: true });
      removed++;
    }
  };
  await rule.readable(root);
  await sweep(root, 1);
  return removed;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// undefined for no name and for one that is empty or only spaces, which no list entry carries
const nameOf = (json: unknown): string | undefined => {
  if (!isRecord(json) || typeof json['name'] !== 'string') return undefined;
  // 128 UTF-16 units hold at least 64 characters, so a name of megabytes is never spread whole
  const name = [...json['name'].slice(0, 128)].slice(0, 64).join('');
  return name.trim() === '' ? undefined : name;
};

type Read = { readonly entry: ThemeListEntry; readonly raw?: Record<string, unknown> };

/** Copies the value at `pointer` (a validateTheme unknown-key path) from `from` into `into`, when its parent is still there. */
function keepUnknown(into: Record<string, unknown>, from: Record<string, unknown>, pointer: string): void {
  const keys = pointerSegments(pointer);
  const last = keys.pop();
  if (last === undefined) return;
  let source: unknown = from;
  let target: unknown = into;
  for (const key of keys) {
    source = isRecord(source) || Array.isArray(source) ? (source as Record<string, unknown>)[key] : undefined;
    target = isRecord(target) || Array.isArray(target) ? (target as Record<string, unknown>)[key] : undefined;
  }
  if (!isRecord(source) || !isRecord(target) || !Object.hasOwn(source, last) || Object.hasOwn(target, last)) return;
  // defined, not assigned: assigning the key __proto__ would set the prototype
  Object.defineProperty(target, last, { value: source[last], enumerable: true, writable: true, configurable: true });
}

/** One theme folder's entry: never applied unless ok, and a broken file is never rewritten. It never throws, so one folder's failure is that folder listed broken. */
export async function readThemeFolder(themesDir: string, id: string, rule: ThemePathRule): Promise<Read> {
  const file = path.join(themesDir, id, THEME_FILE);
  let json: unknown;
  try {
    await rule.readable(file);
    json = parseStoredJson(await readCapped(file, MAX_THEME_FILE_BYTES));
  } catch (err) {
    return { entry: { status: 'broken', id, reason: err instanceof UnreadableFile ? err.text : l('theme.json could not be read: {0}', errorTextOf(err)) } };
  }
  const name = nameOf(json);
  const named = name !== undefined ? { name } : {};
  try {
    const version = checkSchemaVersion(json);
    if (version.kind === 'needsNewer') return { entry: { status: 'needsNewer', id, ...named, version: version.version } };
    const result = validateTheme(json, { folder: id });
    if (!result.ok) return { entry: { status: 'broken', id, ...named, reason: l('theme.json is not a valid theme: {0}', themeErrorText(result.errors)) } };
    return { entry: { status: 'ok', id, builtin: false, name: result.theme.name, theme: result.theme }, raw: json as Record<string, unknown> };
  } catch (err) {
    return { entry: { status: 'broken', id, ...named, reason: l('theme.json is not a valid theme: {0}', errorTextOf(err)) } };
  }
}

export function createThemeStore(options: ThemeStoreOptions): ThemeStore {
  const themesDir = path.join(options.root, THEMES_FOLDER);
  const lane = options.lane ?? createWriteLane(options.root, options.log);
  const rule = options.rule ?? createThemePathRule(options.root);
  const writeText = options.writeText ?? ((file: string, text: string) => writeFileAtomic(file, text, { held: lane.held }));
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  const changed = (): void => {
    for (const listener of [...listeners]) listener();
  };
  // the packed examples never change during a run, so they are read once
  let examples: Promise<readonly BuiltinExample[]> | undefined;
  const readExamples = (): Promise<readonly BuiltinExample[]> => {
    examples ??= options.examples ? options.examples() : Promise.resolve([]);
    return examples;
  };
  const systemLooks = options.system ?? ((): SystemLooks => systemTheme({}).looks);
  // checked once per value `system` gives, so a value that fails is logged once
  let systemFile: { readonly looks: SystemLooks; readonly theme: ThemeFile } | undefined;
  const system = (): ThemeFile => {
    const looks = systemLooks();
    if (systemFile?.looks !== looks) systemFile = { looks, theme: checkedSystemTheme(looks, options.log) };
    return systemFile.theme;
  };
  // the text each view words in its own language
  const builtinName = (id: string): string | LocalizedText => (isBuiltinThemeId(id) ? l(BUILTIN_THEME_NAMES[id]) : id);
  // the folders told once per run as no theme's
  const skipped = new Set<string>();

  // The folders a user theme can be in: a folder of any other name (a copy, a backup, a built-in's id) is no theme and is left alone.
  const folders = async (): Promise<string[]> => {
    let entries;
    try {
      await rule.readable(themesDir);
      entries = await fs.readdir(themesDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    for (const name of names) {
      if (isUserThemeId(name) || skipped.has(name)) continue;
      skipped.add(name);
      options.log?.(`[themes] the folder ${JSON.stringify(name)} under ${themesDir} is not named by a theme id, so it is not listed`);
    }
    return names.filter(isUserThemeId);
  };

  const notUserTheme = (id: string, builtin: LocalizedText): LocalizedError => new LocalizedError(isBuiltinThemeId(id) ? builtin : l('{0} is not the id of a theme.', id));

  const userTheme = async (id: string): Promise<{ name: string; raw: Record<string, unknown> }> => {
    if (!isUserThemeId(id)) throw notUserTheme(id, l('{0} is a built-in theme, which cannot be changed. Duplicate it to edit a copy.', builtinName(id)));
    const { entry, raw } = await readThemeFolder(themesDir, id, rule);
    if (entry.status !== 'ok' || raw === undefined) throw new LocalizedError(l('The theme {0} cannot be changed: its file is missing, broken or needs a newer Damocles.', entry.name || id));
    return { name: entry.name, raw };
  };

  // theme.json of `id` replaced by `text`; a folder this call made does not outlive a write that failed
  const put = async (id: string, text: string): Promise<void> => {
    const dir = path.join(themesDir, id);
    const made = await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await writeText(path.join(dir, THEME_FILE), text);
    } catch (err) {
      if (made !== undefined) await fs.rmdir(dir).catch(() => undefined);
      throw err;
    }
  };

  // Writes `raw` as the theme `id`, after the same checks a reader makes, with its custom CSS as the sanitizer keeps it (main
  // lists a theme whose CSS its own sanitizer pass would cut as broken); the previous file stays on any failure.
  const write = async (id: string, name: string, raw: Record<string, unknown>): Promise<void> => {
    const result = validateTheme(raw, { folder: id });
    if (!result.ok) throw new LocalizedError(l('The theme {0} was not saved: {1}', name, themeErrorText(result.errors)));
    const { kept } = sanitizeThemeCss(result.theme.css ?? {}, { families: themeCssFamilies(result.theme) });
    const next: Record<string, unknown> = { ...raw };
    if (Object.keys(kept).length > 0) next['css'] = kept;
    else delete next['css'];
    await rule.writable(path.join(themesDir, id, THEME_FILE));
    try {
      await put(id, `${JSON.stringify(next, null, 2)}\n`);
    } catch (err) {
      throw new LocalizedError(l('Damocles could not save the theme {0}: {1}', name, errorTextOf(err)), { cause: err });
    }
  };

  // `theme` validated as a theme under its own id, with core's `origin`
  const incomingTheme = (theme: unknown, origin: Origin): { readonly id: string; readonly name: string; readonly raw: Record<string, unknown> } => {
    const incoming = validateTheme(theme);
    if (!incoming.ok) throw new LocalizedError(l('The theme was not saved: {0}', themeErrorText(incoming.errors)));
    const { id, name } = incoming.theme;
    if (!isUserThemeId(id)) throw new Error(`${id} is not a user theme id`);
    return { id, name, raw: { ...(JSON.parse(JSON.stringify(incoming.theme)) as Record<string, unknown>), origin } };
  };

  const unlocked: ThemeWrites = {
    async saveTheme(id, theme) {
      const { name, raw } = await userTheme(id);
      const incoming = validateTheme(theme, { folder: id });
      if (!incoming.ok) throw new LocalizedError(l('The theme {0} was not saved: {1}', name, themeErrorText(incoming.errors)));
      // only core writes the origin
      const next = JSON.parse(JSON.stringify(incoming.theme)) as Record<string, unknown>;
      delete next['origin'];
      const before = validateTheme(raw, { folder: id });
      // a flash allowance is this computer's, in cache/<sha256>/flash.json, and never kept from a theme file
      for (const key of before.ok ? before.unknownKeys : []) if (!/\/flash\/allowed$/.test(key)) keepUnknown(next, raw, key);
      if (raw['origin'] !== undefined) next['origin'] = raw['origin'];
      await write(id, incoming.theme.name, next);
      return name;
    },
    async duplicate(id, name, copyId) {
      const origin = { kind: 'duplicate', from: id, installedAt: now() };
      let copy: Record<string, unknown>;
      const portable = id === BUILTIN_THEME_ID ? portableBuiltinTheme(BUILTIN_THEME) : id === SYSTEM_THEME_ID ? portableBuiltinTheme(system()) : undefined;
      if (portable) {
        copy = { ...portable, id: copyId, name, origin };
      } else if (!isUserThemeId(id)) {
        const example = (await readExamples()).find((candidate) => candidate.id === id);
        if (!example || !('theme' in example)) throw new LocalizedError(l('The theme {0} is missing, broken or needs a newer Damocles.', id));
        const raw = JSON.parse(JSON.stringify(example.theme)) as Record<string, unknown>;
        copy = { ...raw, id: copyId, name, origin };
      } else {
        const { raw } = await userTheme(id);
        const source = validateTheme(raw, { folder: id });
        copy = { ...raw, id: copyId, name, origin: { ...origin, ...copiedLayoutOptIn(source.ok ? source.theme.origin : undefined) } };
      }
      await write(copyId, name, copy);
      return name;
    },
    async create(theme, origin) {
      const { id, name, raw } = incomingTheme(theme, origin);
      await rule.writable(path.join(themesDir, id, THEME_FILE));
      if (await fs.stat(path.join(themesDir, id)).then(() => true, (err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? false : Promise.reject(err)))) {
        throw new LocalizedError(l('The theme {0} was not saved: a theme folder of its id is already there.', name));
      }
      await write(id, name, raw);
      return name;
    },
    async replace(theme, origin) {
      const { id, name, raw } = incomingTheme(theme, origin);
      await write(id, name, raw);
      return name;
    },
    async rename(id, name) {
      const { name: was, raw } = await userTheme(id);
      await write(id, name, { ...raw, name });
      return was;
    },
    async remove(id) {
      if (!isUserThemeId(id)) throw notUserTheme(id, l('{0} is a built-in theme, which cannot be deleted.', builtinName(id)));
      const { entry } = await readThemeFolder(themesDir, id, rule);
      await rule.writable(path.join(themesDir, id));
      try {
        lane.held();
        await fs.rm(path.join(themesDir, id), { recursive: true, force: true });
      } catch (err) {
        throw new LocalizedError(l('Damocles could not delete the theme {0}: {1}', entry.name || id, errorTextOf(err)), { cause: err });
      }
      return entry.name || id;
    },
    async readText(id) {
      if (!isUserThemeId(id)) return null;
      await rule.readable(path.join(themesDir, id, THEME_FILE));
      try {
        return await fs.readFile(path.join(themesDir, id, THEME_FILE), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async writeText(id, text) {
      if (!isUserThemeId(id)) throw new Error(`${id} is not a user theme id`);
      if (text === null) {
        await rule.writable(path.join(themesDir, id));
        lane.held();
        await fs.rm(path.join(themesDir, id), { recursive: true, force: true });
        return;
      }
      await rule.writable(path.join(themesDir, id, THEME_FILE));
      await put(id, text);
    },
  };

  return {
    lane,
    unlocked,
    newId,
    changed,
    async list() {
      const user = await eachLimited(await folders(), READ_CONCURRENCY, async (id) => (await readThemeFolder(themesDir, id, rule)).entry);
      user.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id) || a.id.localeCompare(b.id));
      const builtins = (await readExamples()).map((example): ThemeListEntry => ('theme' in example
        ? { status: 'ok', id: example.id, builtin: true, name: example.theme.name, theme: example.theme }
        : { status: 'broken', id: example.id, reason: l('theme.json is not a valid theme: {0}', verbatim(example.error)) }));
      const systemColors = system();
      return [
        { status: 'ok', id: BUILTIN_THEME_ID, builtin: true, name: BUILTIN_THEME.name, theme: BUILTIN_THEME },
        { status: 'ok', id: SYSTEM_THEME_ID, builtin: true, name: systemColors.name, theme: systemColors },
        ...builtins,
        ...user,
      ];
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}
