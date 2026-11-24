// Animated project characters (docs/themes.md "Characters"): which character a project shows, its pins, the sprite caps and what
// a renderer draws. Pure: core, main and the renderers import it.
import { l, type LocalizedText } from '../localized-text';
import { MAX_TRANSITIONS_PER_WINDOW } from './flash';
import { stripRefusal, validateTheme, type AssetMeta, type CharFrame, type CharacterSelection, type CharacterSet, type ThemeFile } from './schema';
import { flashPlayable, stillUrl, type FlashRecord } from './wallpapers';

export const CHARACTER_STATES = ['idle', 'running', 'waiting'] as const;
export type CharacterState = (typeof CHARACTER_STATES)[number];
export type CharacterStates = CharacterSet['characters'][number]['states'];
export type Character = CharacterSet['characters'][number];

// damocles.desktop.themes.characterMotion; 'still' is what main sends while nothing may move.
// Must match CHARACTER_MOTIONS in src/desktop/local-services/desktop-configuration.ts, which imports nothing.
export const CHARACTER_MOTIONS = ['always', 'hover', 'active'] as const;
export type CharacterMotion = (typeof CHARACTER_MOTIONS)[number];
export type ShownCharacterMotion = CharacterMotion | 'still';

// A sprite's caps, checked from its header before anything decodes it: its bytes, each frame's sides, and a strip's whole image.
export const MAX_SPRITE_BYTES: number = 256 * 1024;
export const MAX_SPRITE_SIDE = 256;
export const MAX_SPRITE_PIXELS: number = 1024 * 1024;
export const MAX_SPRITE_FPS = 60;
export const SVG_MIME = 'image/svg+xml';
export const SPRITE_MIMES: readonly string[] = ['image/png', 'image/gif', 'image/webp', SVG_MIME];
// A strip steps at most this many times a second, so it shows at most three flashes in any second (WCAG 2.3.1) and needs no
// flash check to move.
export const SAFE_STRIP_FPS: number = MAX_TRANSITIONS_PER_WINDOW;

// The elements an SVG sprite may hold, by local name: plain shapes, their paint and their grouping. A name outside this list
// is refused under any namespace prefix, so no script, style, embedded resource or animation element passes.
const SVG_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask',
]);
// What a refused element is called; any other is an element a sprite may not hold.
const SVG_REFUSED_ELEMENTS: ReadonlyArray<readonly [RegExp, LocalizedText]> = [
  [/^script$/i, l('The SVG holds a script.')],
  [/^(?:animate\w*|set|discard)$/i, l('The SVG holds an animation.')],
  [/^(?:foreignObject|image|iframe|embed|object|audio|video|style|link)$/i, l('The SVG holds an embedded resource or style.')],
];

// XML's own white space only, so a name reads here as an XML parser reads it. Each pattern is sticky and holds no quantified
// group, so reading a sprite takes time linear in its length.
const XML_SPACE = /[ \t\r\n]*/y;
// The declaration, never another instruction whose target starts with xml (xml-stylesheet loads a style sheet).
const XML_DECLARATION = /<\?xml[ \t\r\n]/y;
const XML_NAME = /[^ \t\r\n<>/="'!?]+/y;
const XML_ATTRIBUTE = /[ \t\r\n]+([^ \t\r\n<>/="']+)[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')/y;
const XML_TAG_END = /[ \t\r\n]*\/?>/y;
const XML_CLOSE_TAG = /<\/[^ \t\r\n<>/="']+[ \t\r\n]*>/y;
const OTHER_ENCODING = /encoding[ \t\r\n]*=[ \t\r\n]*["'](?!utf-8["'])/i;
const OUTSIDE_URL = /url\(\s*["']?(?!#)/;
const PRINTABLE_NAME = /^[A-Za-z][\w:.-]{0,31}$/;

const NO_SVG_ROOT = l('The SVG does not start with an <svg> element.');
const NOT_XML = l('The SVG is not well-formed XML.');

function elementRefusal(name: string): LocalizedText | undefined {
  const colon = name.indexOf(':');
  if (colon !== name.lastIndexOf(':')) return NOT_XML;
  const local = name.slice(colon + 1);
  if (SVG_ELEMENTS.has(local)) return undefined;
  const known = SVG_REFUSED_ELEMENTS.find(([pattern]) => pattern.test(local))?.[1];
  if (known !== undefined) return known;
  return PRINTABLE_NAME.test(name) ? l('The SVG holds an element a sprite may not hold ({0}).', name) : l('The SVG holds an element a sprite may not hold.');
}

// Character references and CSS escapes are refused in every value, so the checks below read the text a renderer reads.
function attributeRefusal(name: string, value: string): LocalizedText | undefined {
  const local = name.slice(name.indexOf(':') + 1).toLowerCase();
  if (local.startsWith('on')) return l('The SVG holds an event handler.');
  if (value.includes('&#') || value.includes('\\')) return l('The SVG holds an escaped character in an attribute.');
  const lower = value.toLowerCase();
  if ((local === 'href' || local === 'src') && !lower.trimStart().startsWith('#')) return l('The SVG holds a link.');
  if (OUTSIDE_URL.test(lower)) return l('The SVG holds a link.');
  if (local === 'style' && /@import|@keyframes|animation/.test(lower)) return l('The SVG holds a style rule.');
  return undefined;
}

/** The root element's attributes of an SVG that holds only what a sprite may, or why it is refused. One pass over the text. */
function scanSvg(text: string): { readonly root: ReadonlyMap<string, string> } | { readonly refused: LocalizedText } {
  let at = 0;
  let root: Map<string, string> | undefined;
  const take = (pattern: RegExp): RegExpExecArray | null => {
    pattern.lastIndex = at;
    const found = pattern.exec(text);
    if (found) at = pattern.lastIndex;
    return found;
  };
  take(XML_SPACE);
  const declaration = at;
  if (take(XML_DECLARATION)) {
    const end = text.indexOf('?>', at);
    if (end < 0) return { refused: NO_SVG_ROOT };
    if (OTHER_ENCODING.test(text.slice(declaration, end))) return { refused: l('The SVG declares an encoding other than UTF-8.') };
    at = end + 2;
  }
  for (;;) {
    if (root === undefined) {
      take(XML_SPACE);
      if (text[at] !== '<') return { refused: NO_SVG_ROOT };
    } else {
      at = text.indexOf('<', at);
      if (at < 0) return { root };
    }
    if (text.startsWith('<!--', at)) {
      const end = text.indexOf('-->', at + 4);
      if (end < 0) return { refused: root === undefined ? NO_SVG_ROOT : NOT_XML };
      at = end + 3;
    } else if (text.startsWith('<![CDATA[', at)) {
      const end = text.indexOf(']]>', at);
      if (end < 0 || root === undefined) return { refused: root === undefined ? NO_SVG_ROOT : NOT_XML };
      at = end + 3;
    } else if (text.startsWith('<!', at)) {
      return { refused: l('The SVG holds a DOCTYPE or ENTITY.') };
    } else if (text.startsWith('<?', at)) {
      return { refused: l('The SVG holds a processing instruction.') };
    } else if (text.startsWith('</', at)) {
      if (root === undefined) return { refused: NO_SVG_ROOT };
      if (!take(XML_CLOSE_TAG)) return { refused: NOT_XML };
    } else {
      at += 1;
      const name = take(XML_NAME)?.[0];
      if (name === undefined) return { refused: root === undefined ? NO_SVG_ROOT : NOT_XML };
      if (root === undefined && name.slice(name.indexOf(':') + 1) !== 'svg') return { refused: NO_SVG_ROOT };
      const refused = elementRefusal(name);
      if (refused !== undefined) return { refused };
      const attributes = new Map<string, string>();
      for (let attribute = take(XML_ATTRIBUTE); attribute; attribute = take(XML_ATTRIBUTE)) {
        const value = attribute[2] ?? attribute[3] ?? '';
        const why = attributeRefusal(attribute[1]!, value);
        if (why !== undefined) return { refused: why };
        attributes.set(attribute[1]!, value);
      }
      if (!take(XML_TAG_END)) return { refused: NOT_XML };
      root ??= attributes;
    }
  }
}

const svgLength = (raw: string | undefined): number | undefined => {
  const match = raw === undefined ? null : /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/.exec(raw);
  return match ? Math.round(Number(match[1])) : undefined;
};

/**
 * An SVG sprite's size from its root element's width and height (or its viewBox), and why it is refused if it is: it must be a
 * plain still drawing of shapes. Pure text checks; nothing renders it here.
 */
export function svgHeader(bytes: Uint8Array): { readonly width: number; readonly height: number } | { readonly refused: LocalizedText } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { refused: l('The SVG is not UTF-8 text.') };
  }
  const scanned = scanSvg(text);
  if ('refused' in scanned) return scanned;
  let width = svgLength(scanned.root.get('width'));
  let height = svgLength(scanned.root.get('height'));
  const box = scanned.root.get('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if ((width === undefined || height === undefined) && box?.length === 4 && box.every(Number.isFinite)) {
    width ??= Math.round(box[2]!);
    height ??= Math.round(box[3]!);
  }
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return { refused: l('The SVG names no size in px.') };
  return { width, height };
}

/** A project's state as its loaded chats give it: one waiting on the user, else one running, else idle. */
export function characterState(project: { readonly running: number; readonly waiting: number }): CharacterState {
  if (project.waiting > 0) return 'waiting';
  return project.running > 0 ? 'running' : 'idle';
}

/** The character a project gets without a pin: FNV-1a of its key, so it keeps one across restarts and windows. */
export function characterIndex(projectKey: string, count: number): number {
  let hash = 0x811c9dc5;
  for (const char of projectKey) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return count > 0 ? hash % count : 0;
}

/** A character kept in every theme: its states and the asset entry of every sprite they name, whose blobs stay referenced. */
export interface EveryThemePin extends Character {
  readonly assets: Readonly<Record<string, AssetMeta>>;
}

export interface ProjectPins {
  // theme id → the name of a character of that theme's set
  readonly byTheme?: Readonly<Record<string, string>>;
  readonly everyTheme?: EveryThemePin;
}

/** One project's pins as the theme editor's Save changes them for the theme it saves; undefined leaves a field as it is. */
export interface PinEdit {
  readonly projectKey: string;
  // a character of the theme's set by name; null: the project key's hash again
  readonly character?: string | null;
  // a character of the theme's set kept in every theme; null: none
  readonly everyTheme?: string | null;
}

// ~/.damocles/themes/projects.json, which only this computer's core writes; machine-local, never exported.
export const PROJECTS_FILE = 'projects.json';
export const PROJECTS_FILE_VERSION = 1;
export const MAX_PINNED_PROJECTS = 1000;
export interface ProjectsFile {
  readonly version: 1;
  // by project key
  readonly pins: Readonly<Record<string, ProjectPins>>;
}

export const EMPTY_PROJECTS: ProjectsFile = { version: PROJECTS_FILE_VERSION, pins: {} };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// A fixed theme id the pin's own check validates under; it names no installed theme.
const PIN_CHECK_ID = '00000000-0000-4000-8000-000000000000';
const PIN_CHECK_COLORS = { background: '#000000', panel: '#000000', text: '#ffffff', accent: '#ffffff', success: '#ffffff', warning: '#ffffff', danger: '#ffffff', info: '#ffffff' };

/** An every-theme pin checked as a one-character theme would be: its frames, their caps and the asset entries they name. */
export function checkEveryThemePin(value: unknown): EveryThemePin | undefined {
  if (!isRecord(value) || !isRecord(value['assets']) || !isRecord(value['states']) || typeof value['name'] !== 'string') return undefined;
  const character = { name: value['name'], ...(typeof value['alt'] === 'string' ? { alt: value['alt'] } : {}), states: value['states'] };
  const result = validateTheme({ schemaVersion: 1, id: PIN_CHECK_ID, name: 'pin', looks: { dark: { colors: PIN_CHECK_COLORS } }, characters: { name: 'pin', characters: [character] }, assets: value['assets'] });
  if (!result.ok) return undefined;
  const checked = result.theme.characters!.characters[0]!;
  const named = new Set(frameAssets(checked.states));
  const assets = Object.fromEntries(Object.entries(result.theme.assets ?? {}).filter(([sha]) => named.has(sha)));
  return { ...checked, assets };
}

/** One sprite's asset entry checked as a theme's assets are; undefined unless it holds up and is a sprite. */
export function checkSpriteAsset(sha256: string, value: unknown): AssetMeta | undefined {
  const result = validateTheme({ schemaVersion: 1, id: PIN_CHECK_ID, name: 'pin', looks: { dark: { colors: PIN_CHECK_COLORS } }, assets: { [sha256]: value } });
  const asset = result.ok ? result.theme.assets?.[sha256] : undefined;
  return asset?.kind === 'sprite' ? asset : undefined;
}

/** projects.json as read: an entry that does not check is dropped, never thrown. */
export function parseProjectsFile(json: unknown): ProjectsFile {
  if (!isRecord(json) || json['version'] !== PROJECTS_FILE_VERSION || !isRecord(json['pins'])) return EMPTY_PROJECTS;
  const pins: Record<string, ProjectPins> = {};
  for (const [key, raw] of Object.entries(json['pins']).slice(0, MAX_PINNED_PROJECTS)) {
    if (!isRecord(raw) || key === '' || key === '__proto__') continue;
    const byTheme = isRecord(raw['byTheme'])
      ? Object.fromEntries(Object.entries(raw['byTheme']).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length <= 64))
      : {};
    const everyTheme = raw['everyTheme'] === undefined ? undefined : checkEveryThemePin(raw['everyTheme']);
    if (Object.keys(byTheme).length === 0 && !everyTheme) continue;
    pins[key] = { ...(Object.keys(byTheme).length > 0 ? { byTheme } : {}), ...(everyTheme ? { everyTheme } : {}) };
  }
  return { version: PROJECTS_FILE_VERSION, pins };
}

/** The blob each frame names. */
export function frameAssets(states: CharacterStates): string[] {
  return CHARACTER_STATES.flatMap((state) => {
    const frame = states[state];
    return frame === undefined ? [] : [frameAsset(frame)];
  });
}

export const frameAsset = (frame: CharFrame): string => ('asset' in frame ? frame.asset : frame.strip.asset);

/** Every sprite a theme's character set names, each once. */
export const characterAssets = (theme: Pick<ThemeFile, 'characters'>): string[] => [...new Set((theme.characters?.characters ?? []).flatMap((character) => frameAssets(character.states)))];

// A renderer's view

export interface CharacterStrip {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frames: number;
  readonly fps: number;
}

/** One state's image as a renderer draws it; main builds it, so trusted UI draws only main's data. */
export interface CharacterFrameView {
  readonly url: string;
  // the first frame, shown while it does not move: an animated image's or an SVG's, drawn by the theme renderer
  readonly still?: string;
  readonly strip?: CharacterStrip;
  // the image moves on its own (an animated image) or steps through a strip of more than one frame
  readonly moves: boolean;
  // its flash check lets it move: unflagged, allowed on this computer, or a strip too slow to flash
  readonly playable: boolean;
}

export interface CharacterView {
  readonly name: string;
  readonly states: Readonly<Partial<Record<CharacterState, CharacterFrameView>>> & { readonly idle: CharacterFrameView };
}

/** A sprite core stored for a theme's character to name: its blob, its asset entry, its strip cut and its flash check. */
export interface SpriteImport {
  readonly sha256: string;
  readonly asset: AssetMeta;
  readonly strip?: CharacterStrip;
  // the flash check of a sprite that moves, with this computer's allowance
  readonly flash?: FlashRecord;
}

/** A sprite asset's strip cut, as core wrote it: frames side by side, and one loop at the rate its flash check ran at. */
export function spriteStrip(asset: Pick<AssetMeta, 'kind' | 'width' | 'height' | 'frames' | 'durationMs'>): CharacterStrip | undefined {
  const { width, height, frames, durationMs } = asset;
  if (asset.kind !== 'sprite' || width === undefined || height === undefined || frames === undefined || frames < 2 || !durationMs) return undefined;
  // rounded down, so the rate is never above the one durationMs was rounded from
  return { frameWidth: width / frames, frameHeight: height, frames, fps: Math.min(MAX_SPRITE_FPS, Math.floor(((frames * 1000) / durationMs) * 100) / 100) };
}

/** Whether a sprite asset is an animated image: more than one frame, and no strip cut from it. */
export const spriteIsAnimated = (asset: Pick<AssetMeta, 'kind' | 'width' | 'height' | 'frames' | 'durationMs'>): boolean => spriteStrip(asset) === undefined && (asset.frames ?? 1) > 1;

/**
 * What the theme renderer is needed for: the still frame of an animated image or an SVG, and the flash check of anything that
 * moves faster than a strip that cannot flash. A still raster image and a slow strip need neither.
 */
export function spriteNeedsAnalysis(asset: Pick<AssetMeta, 'kind' | 'mime' | 'width' | 'height' | 'frames' | 'durationMs'>): boolean {
  const strip = spriteStrip(asset);
  return strip ? strip.fps > SAFE_STRIP_FPS : asset.mime === SVG_MIME || (asset.frames ?? 1) > 1;
}

/** The frame a stored sprite gives a state: its strip, or the image itself. */
export const spriteFrame = (sprite: Pick<SpriteImport, 'sha256' | 'strip'>): CharFrame => (sprite.strip ? { strip: { asset: sprite.sha256, ...sprite.strip } } : { asset: sprite.sha256 });

/** The characters a window shows: the shown theme's set, each pinned project's own, and how they may move. */
export interface ShownCharacters {
  readonly characters: readonly CharacterView[];
  // project key → an index into characters (a pin of the shown theme) or the project's every-theme character
  readonly pins: Readonly<Record<string, number | CharacterView>>;
  readonly motion: ShownCharacterMotion;
  // the shown set's mark of the selected project's character; outline when the shown theme has no set
  readonly selection: CharacterSelection;
}

export interface FrameSources {
  readonly url: (sha256: string) => string;
  // a sprite's flash check with this computer's allowance, as core's cache holds it; undefined before its analysis
  readonly flash: (sha256: string) => FlashRecord | undefined;
}

/**
 * A state's image as drawn, or undefined when nothing safe can show: an animated image with no still frame yet, or a strip
 * over an image that is not the still sprite cut it names.
 */
export function frameView(frame: CharFrame, assets: Readonly<Record<string, AssetMeta>>, sources: FrameSources): CharacterFrameView | undefined {
  const sha = frameAsset(frame);
  const asset = assets[sha];
  if (!asset) return undefined;
  const record = sources.flash(sha);
  if ('strip' in frame) {
    if (stripRefusal(asset, frame.strip.frames) !== undefined) return undefined;
    const strip = { frameWidth: frame.strip.frameWidth, frameHeight: frame.strip.frameHeight, frames: frame.strip.frames, fps: frame.strip.fps };
    const moves = strip.frames > 1;
    // a flash check counts only for the cut it ran on: the asset's frames, no faster than one loop in its durationMs
    const checked = asset.frames === strip.frames && asset.durationMs !== undefined && Math.round((strip.frames * 1000) / strip.fps) >= asset.durationMs;
    return { url: sources.url(sha), strip, moves, playable: moves && (strip.fps <= SAFE_STRIP_FPS || (checked && flashPlayable(record))) };
  }
  const svg = asset.mime === SVG_MIME;
  const animated = !svg && (asset.frames ?? 1) > 1;
  const still = record !== undefined && (animated || svg) ? stillUrl(sha) : undefined;
  if (animated && still === undefined) return undefined;
  return { url: sources.url(sha), ...(still !== undefined ? { still } : {}), moves: animated, playable: animated && flashPlayable(record) };
}

/** A character as drawn; undefined when its idle state cannot show. */
export function characterView(character: Character, assets: Readonly<Record<string, AssetMeta>>, sources: FrameSources): CharacterView | undefined {
  const idle = frameView(character.states.idle, assets, sources);
  if (!idle) return undefined;
  const states: Partial<Record<CharacterState, CharacterFrameView>> = { idle };
  for (const state of ['running', 'waiting'] as const) {
    const frame = character.states[state];
    const view = frame ? frameView(frame, assets, sources) : undefined;
    if (view) states[state] = view;
  }
  return { name: character.name, states: states as CharacterView['states'] };
}

/**
 * The characters of `set` (undefined: the shown theme has none) and of every project's pins. A pin of the set's own theme
 * (`set.themeId`) wins, then a character kept in every theme, then the project key's hash over the set.
 */
export function shownCharacters(
  set: { readonly themeId: string; readonly characters?: CharacterSet; readonly assets?: Readonly<Record<string, AssetMeta>> } | undefined,
  projects: ProjectsFile,
  sources: FrameSources,
  motion: ShownCharacterMotion,
): ShownCharacters | undefined {
  const named = (set?.characters?.characters ?? []).map((character) => ({ character, view: characterView(character, set?.assets ?? {}, sources) }));
  const shown = named.flatMap((entry) => (entry.view ? [entry] : []));
  const characters = shown.map((entry) => entry.view!);
  const pins: Record<string, number | CharacterView> = {};
  for (const [key, pin] of Object.entries(projects.pins)) {
    const name = set ? pin.byTheme?.[set.themeId] : undefined;
    const index = name === undefined ? -1 : shown.findIndex((entry) => entry.character.name === name);
    if (index >= 0) {
      pins[key] = index;
      continue;
    }
    const every = pin.everyTheme ? characterView(pin.everyTheme, pin.everyTheme.assets, sources) : undefined;
    if (every) pins[key] = every;
  }
  if (characters.length === 0 && Object.keys(pins).length === 0) return undefined;
  return { characters, pins, motion, selection: set?.characters?.selection ?? 'outline' };
}

/** The character a project shows; undefined: its letter. */
export function characterFor(shown: ShownCharacters | undefined, projectKey: string | undefined): CharacterView | undefined {
  return projectKey === undefined ? undefined : characterChoice(shown, projectKey)?.view;
}

/** Why a project shows its character: a pin of the shown theme, a character kept in every theme, or its key's hash. */
export const CHARACTER_CHOICE_BY = ['themePin', 'everyTheme', 'projectKey'] as const;
export type CharacterChoiceBy = (typeof CHARACTER_CHOICE_BY)[number];

/** The character a project shows and what decided it; undefined: its letter. */
export function characterChoice(shown: ShownCharacters | undefined, projectKey: string): { readonly view: CharacterView; readonly by: CharacterChoiceBy } | undefined {
  if (!shown) return undefined;
  const pin = Object.hasOwn(shown.pins, projectKey) ? shown.pins[projectKey] : undefined;
  if (typeof pin === 'object') return { view: pin, by: 'everyTheme' };
  const pinned = typeof pin === 'number' ? shown.characters[pin] : undefined;
  if (pinned) return { view: pinned, by: 'themePin' };
  const hashed = shown.characters.length > 0 ? shown.characters[characterIndex(projectKey, shown.characters.length)] : undefined;
  return hashed ? { view: hashed, by: 'projectKey' } : undefined;
}

/** The state's image, falling back to idle for a state the character does not draw. */
export const frameFor = (character: CharacterView, state: CharacterState): CharacterFrameView => character.states[state] ?? character.states.idle;
