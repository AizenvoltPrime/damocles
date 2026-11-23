// Project characters on this computer (docs/invariants.md "Desktop themes"): a sprite's checks before it is stored, and
// projects.json's pins, which core writes inside the write lane and main reads.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  EMPTY_PROJECTS, frameAssets, parseProjectsFile, PROJECTS_FILE, PROJECTS_FILE_VERSION, type EveryThemePin, type PinEdit, type ProjectPins, type ProjectsFile,
} from '../../shared/themes/characters';

export type { PinEdit } from '../../shared/themes/characters';
import { LocalizedError } from '../../shared/localized-text';
import type { AssetMeta, ThemeFile } from '../../shared/themes/schema';
import { parseStoredJson } from '../../shared/themes/stored-json';
import { l } from '../l10n';
import { createThemePathRule, type ThemePathRule } from './network-rule';
import { editableState, MAX_STATE_FILE_BYTES, readCappedOrNull } from './state-file';
import { checkSpriteCaps, readSpriteHeader, SpriteHeaderError, type SpriteFormat, type SpriteHeader, type StripCut } from './sprite-header';

// The extensions each format may carry; a file named otherwise is refused.
const EXTENSIONS: Readonly<Record<SpriteFormat, readonly string[]>> = { png: ['png', 'apng'], gif: ['gif'], webp: ['webp'], svg: ['svg'] };

/** A sprite's header as checked, and the strip it is cut into when it is one. */
export interface CheckedSprite extends SpriteHeader {
  readonly strip?: StripCut;
}

/** A sprite's header checked against the caps, as one image or cut into `strip`; throws a LocalizedError naming what is refused. */
export function checkSprite(bytes: Uint8Array, name: string | undefined, strip?: StripCut): CheckedSprite {
  let header: SpriteHeader;
  try {
    header = readSpriteHeader(bytes);
    checkSpriteCaps(header, strip);
  } catch (err) {
    if (err instanceof SpriteHeaderError) throw new LocalizedError(err.text);
    throw err;
  }
  const extension = name === undefined ? '' : path.extname(name).slice(1).toLowerCase();
  if (extension !== '' && !EXTENSIONS[header.format].includes(extension)) throw new LocalizedError(l('This file is named .{0} but holds a {1} file.', extension, header.format.toUpperCase()));
  return { ...header, ...(strip !== undefined && strip.frames > 1 ? { strip } : {}) };
}

/** The asset entry of a checked sprite: a strip's durationMs is one loop at the rate its flash check ran at. */
export function spriteAsset(bytes: Uint8Array, sprite: CheckedSprite): AssetMeta {
  const frames = sprite.strip?.frames ?? sprite.frames;
  return {
    kind: 'sprite',
    mime: sprite.mime,
    bytes: bytes.length,
    width: sprite.width,
    height: sprite.height,
    ...(frames !== undefined && frames > 1 ? { frames } : {}),
    ...(sprite.strip ? { durationMs: Math.round((sprite.strip.frames * 1000) / sprite.strip.fps) } : {}),
    license: {},
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `theme`'s character as an every-theme pin, with the asset entries its frames name. */
function everyThemePin(theme: ThemeFile, name: string): EveryThemePin | undefined {
  const character = theme.characters?.characters.find((candidate) => candidate.name === name);
  if (!character) return undefined;
  const named = new Set(frameAssets(character.states));
  const assets = Object.fromEntries(Object.entries(theme.assets ?? {}).filter(([sha]) => named.has(sha)));
  return { ...character, assets };
}

/**
 * projects.json's object with `edits` applied for `theme`: a name its set lacks is ignored. Keys of the file this version does
 * not read are kept.
 */
export function applyPinEdits(raw: unknown, theme: ThemeFile, edits: readonly PinEdit[]): Record<string, unknown> {
  // a Map, never property writes, so a key such as __proto__ stays an own key of the file
  const pins = new Map<string, ProjectPins>(Object.entries(parseProjectsFile(raw).pins));
  const names = new Set((theme.characters?.characters ?? []).map((character) => character.name));
  for (const edit of edits) {
    if (edit.projectKey === '') continue;
    const before = pins.get(edit.projectKey) ?? {};
    const byTheme: Record<string, string> = { ...before.byTheme };
    if (edit.character === null) delete byTheme[theme.id];
    else if (edit.character !== undefined && names.has(edit.character)) byTheme[theme.id] = edit.character;
    let everyTheme = before.everyTheme;
    if (edit.everyTheme === null) everyTheme = undefined;
    else if (edit.everyTheme !== undefined) everyTheme = everyThemePin(theme, edit.everyTheme) ?? everyTheme;
    const next: ProjectPins = { ...(Object.keys(byTheme).length > 0 ? { byTheme } : {}), ...(everyTheme ? { everyTheme } : {}) };
    if (Object.keys(next).length > 0) pins.set(edit.projectKey, next);
    else pins.delete(edit.projectKey);
  }
  const kept = isRecord(raw) && raw['version'] === PROJECTS_FILE_VERSION ? raw : {};
  return { ...kept, version: PROJECTS_FILE_VERSION, pins: Object.fromEntries(pins) };
}

export interface ProjectsStore {
  readText(): Promise<string | null>;
  // null removes the file; call inside the write lane
  writeText(text: string | null): Promise<void>;
  // The file's object for a look or pin change, inside the write lane: undefined for a file to start again (a missing one, and
  // one that is no JSON, copied to projects.json.bad first); a file of another version is a newer Damocles' and is refused.
  editable(): Promise<Record<string, unknown> | undefined>;
  read(): Promise<ProjectsFile>;
}

export function createProjectsStore(
  root: string,
  writeFile: (file: string, text: string) => Promise<void>,
  rule: ThemePathRule = createThemePathRule(root),
  log?: (line: string) => void,
): ProjectsStore {
  const file = path.join(root, PROJECTS_FILE);
  const readText = async (): Promise<string | null> => {
    await rule.readable(file);
    return readCappedOrNull(file, MAX_STATE_FILE_BYTES);
  };
  return {
    readText,
    editable: () => editableState(file, PROJECTS_FILE_VERSION, rule, log),
    async writeText(text) {
      await rule.writable(file);
      if (text === null) {
        await fs.rm(file, { force: true });
        return;
      }
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(file, text);
    },
    async read() {
      const text = await readText();
      if (text === null) return EMPTY_PROJECTS;
      try {
        return parseProjectsFile(parseStoredJson(text));
      } catch {
        return EMPTY_PROJECTS;
      }
    },
  };
}
