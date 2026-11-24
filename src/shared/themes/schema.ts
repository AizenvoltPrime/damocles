import { Type, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { englishText, l, type LocalizedText } from '../localized-text.ts';
import { FONT_NAME, MAX_FONT_BYTES, MAX_THEME_FONTS, reservedFontName } from './fonts.ts';
import {
  CHAT_COLUMN_RANGE, DENSITY_RANGE, DIM_RANGE, LINE_HEIGHT_RANGE, MAX_ANIMATION_FRAMES, MAX_ARRANGEMENT_COORDINATE, MAX_BLUR_PX, MAX_INSTANT_MS, MAX_MOVING_BYTES, MAX_STRIP_FRAMES,
  MAX_SET_CHARACTERS, MAX_THEME_ASSETS, MIN_ARRANGEMENT_SECTION,
  MAX_THEME_AUTHOR_CHARS, MAX_THEME_DESCRIPTION_CHARS, MAX_THEME_LICENSE_CHARS, MAX_THEME_NAME_CHARS, MAX_THEME_VERSION_CHARS, MAX_VIDEO_MS, MAX_WALLPAPER_SETS, ONE_LINE_NAME, RADIUS_RANGE, SURFACE_OPACITY_RANGE, USER_THEME_ID,
} from './limits.ts';
import { isValidTokenValue, OVERRIDABLE_TOKENS, SHADOW_TOKEN, type TokenName } from './tokens.ts';

// The theme file format, schemaVersion 1. The TypeBox schema is the one source of truth for the shape; the code checks
// below hold what a schema cannot say. ThemeFile mirrors the schema by hand (isolatedDeclarations); validateTheme's
// return statement fails to compile when the two drift apart.
export const THEME_SCHEMA_VERSION = 1;

export const PANELS = ['sidebar', 'chat', 'editor', 'terminal', 'titlebar'] as const;
export type Panel = (typeof PANELS)[number];
export const FITS = ['fill', 'fit', 'center', 'tile'] as const;
export type Fit = (typeof FITS)[number];
export const CSS_REGIONS = ['transcript', 'sidebar', 'editorChrome', 'terminalChrome', 'titlebar'] as const;
export type CssRegion = (typeof CSS_REGIONS)[number];
export const ASSET_KINDS = ['image', 'animated', 'video', 'font', 'sprite'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const ORIGIN_KINDS = ['created', 'duplicate', 'import', 'vscode', 'base16', 'gtk', 'kde', 'qt', 'link', 'store'] as const;
// Themes from outside this computer: every origin but one made here.
export const OUTSIDE_ORIGIN_KINDS: ReadonlySet<string> = new Set(ORIGIN_KINDS.filter((kind) => kind !== 'created' && kind !== 'duplicate'));
export const LOOK_SEEDS = ['background', 'panel', 'text', 'accent', 'success', 'warning', 'danger', 'info'] as const;
// Must match GRID_PANES and SIDEBAR_SECTIONS in src/desktop/preload/shell-channels.ts.
export const ARRANGEMENT_PANES = ['chat', 'editor', 'terminal'] as const;
export const ARRANGEMENT_SECTIONS = ['projects', 'chats', 'files', 'scm', 'graph', 'repos', 'search'] as const;
type ArrangementPane = (typeof ARRANGEMENT_PANES)[number];
export type ArrangementSection = (typeof ARRANGEMENT_SECTIONS)[number];

export type LookColors = Readonly<Record<(typeof LOOK_SEEDS)[number], string>>;
export type FontChoice = { readonly installed: string } | { readonly asset: string; readonly family: string };
export interface WallpaperPanel { readonly asset: string; readonly fit: Fit; readonly dim: number; readonly blur: number }
export interface WallpaperSet {
  readonly name?: string;
  readonly span?: { readonly asset: string; readonly panels: readonly Panel[]; readonly fit: Fit };
  readonly panels?: Partial<Record<Panel, WallpaperPanel>>;
  readonly spanLook?: Partial<Record<Panel, { readonly dim: number; readonly blur: number }>>;
}
export interface Look {
  readonly colors: LookColors;
  readonly tokens?: Partial<Record<TokenName, string>>;
  readonly wallpapers?: readonly WallpaperSet[];
  readonly cycle?: { readonly minutes: number | null };
  readonly surfaceOpacity?: number;
}
export interface AssetMeta {
  readonly kind: AssetKind;
  readonly mime: string;
  readonly bytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly frames?: number;
  readonly durationMs?: number;
  readonly family?: string;
  // The verdict of the check the import ran, kept for the file's record: nothing plays or stays still by it. The check that
  // decides, a later re-check and this computer's allowance included, is cache/<sha256>/flash.json.
  readonly flash?: { readonly flagged: boolean; readonly atMs?: number };
  readonly license: { readonly spdx?: string; readonly text?: string; readonly author?: string; readonly source?: string };
}
export type CharFrame = { readonly asset: string } | { readonly strip: { readonly asset: string; readonly frameWidth: number; readonly frameHeight: number; readonly frames: number; readonly fps: number } };
// How the selected project's character is marked: an outline along its opaque pixels, or nothing beyond its row's own selection.
export const CHARACTER_SELECTIONS = ['outline', 'none'] as const;
export type CharacterSelection = (typeof CHARACTER_SELECTIONS)[number];
export interface CharacterSet {
  readonly name: string;
  readonly characters: ReadonlyArray<{ readonly name: string; readonly alt?: string; readonly states: { readonly idle: CharFrame; readonly running?: CharFrame; readonly waiting?: CharFrame } }>;
  // absent: outline
  readonly selection?: CharacterSelection;
}
export interface Arrangement {
  readonly grid?: {
    readonly slots: { readonly main: ArrangementPane; readonly side: ArrangementPane; readonly bottom: ArrangementPane };
    readonly visible: { readonly editor: boolean; readonly terminal: boolean };
    readonly sideWidth: number;
    readonly bottomHeight: number;
  };
  readonly sidebarWidth?: number;
  readonly sectionOrder?: readonly ArrangementSection[];
  readonly sections?: Partial<Record<ArrangementSection, { readonly collapsed: boolean; readonly size?: number }>>;
}
export interface Origin {
  readonly kind: (typeof ORIGIN_KINDS)[number];
  readonly from?: string;
  readonly url?: string;
  readonly store?: { readonly entryId: string; readonly version: string; readonly sha256: string };
  readonly installedHash?: string;
  readonly layoutOptIn?: boolean;
  readonly installedAt: number;
  // a signed removed entry of the store list matched this store theme; reason is outside text
  readonly removedFromStore?: { readonly reason: string; readonly at: number };
}
export interface ThemeFile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly author?: string;
  readonly version?: string;
  readonly license?: string;
  readonly looks: { readonly dark?: Look; readonly light?: Look };
  readonly style?: {
    readonly fonts?: { readonly ui?: FontChoice; readonly mono?: FontChoice };
    readonly lineHeight?: number;
    readonly radius?: number;
    readonly density?: number;
    readonly chatColumn?: number | 'full';
  };
  readonly characters?: CharacterSet;
  readonly css?: Partial<Record<CssRegion, string>>;
  readonly layout?: Arrangement;
  readonly assets?: Readonly<Record<string, AssetMeta>>;
  readonly origin?: Origin;
}

const SHA256 = '^[0-9a-f]{64}$';
// The longest removed reason a theme keeps; the store install cuts a longer one to it.
export const MAX_REMOVED_REASON_CHARS = 500;
const sha256 = Type.String({ pattern: SHA256 });
const text = (maxLength: number) => Type.String({ maxLength });
const lineName = (maxLength: number) => Type.String({ maxLength, pattern: ONE_LINE_NAME });
const givenName = Type.String({ minLength: 1, maxLength: MAX_THEME_NAME_CHARS, pattern: ONE_LINE_NAME });
const literals = <T extends string>(values: readonly T[]) => Type.Union(values.map((value) => Type.Literal(value)));
const range = (minimum: number, maximum: number) => Type.Number({ minimum, maximum });
const within = (bounds: { readonly min: number; readonly max: number }) => range(bounds.min, bounds.max);
const instant = Type.Number({ minimum: 0, maximum: MAX_INSTANT_MS });
const count = (maximum: number) => Type.Integer({ minimum: 0, maximum });
const optional = <T extends TSchema>(schema: T) => Type.Optional(schema);
const partialOf = <T extends TSchema>(keys: readonly string[], value: T) => Type.Object(Object.fromEntries(keys.map((key) => [key, Type.Optional(value)])));

const opaqueHex = Type.String({ pattern: '^#[0-9a-fA-F]{6}$' });
export const MAX_TOKEN_VALUE_CHARS = 128;
const tokenValue = Type.String({ maxLength: MAX_TOKEN_VALUE_CHARS });
const fit = literals(FITS);
const panel = literals(PANELS);
const fontName = text(64);
const coordinate = range(0, MAX_ARRANGEMENT_COORDINATE);

const fontChoice = Type.Union([Type.Object({ installed: fontName }), Type.Object({ asset: sha256, family: fontName })]);
const dimBlur = { dim: within(DIM_RANGE), blur: range(0, MAX_BLUR_PX) };
const wallpaperSet = Type.Object({
  name: optional(lineName(MAX_THEME_NAME_CHARS)),
  span: optional(Type.Object({ asset: sha256, panels: Type.Array(panel, { minItems: 1, maxItems: PANELS.length }), fit })),
  panels: optional(partialOf(PANELS, Type.Object({ asset: sha256, fit, ...dimBlur }))),
  spanLook: optional(partialOf(PANELS, Type.Object(dimBlur))),
});
const look = Type.Object({
  colors: Type.Object({ background: opaqueHex, panel: opaqueHex, text: opaqueHex, accent: opaqueHex, success: opaqueHex, warning: opaqueHex, danger: opaqueHex, info: opaqueHex }),
  tokens: optional(partialOf(OVERRIDABLE_TOKENS, tokenValue)),
  wallpapers: optional(Type.Array(wallpaperSet, { maxItems: MAX_WALLPAPER_SETS })),
  cycle: optional(Type.Object({ minutes: Type.Union([range(1, 1440), Type.Null()]) })),
  surfaceOpacity: optional(within(SURFACE_OPACITY_RANGE)),
});
const charFrame = Type.Union([
  Type.Object({ asset: sha256 }),
  Type.Object({ strip: Type.Object({ asset: sha256, frameWidth: Type.Integer({ minimum: 1, maximum: 256 }), frameHeight: Type.Integer({ minimum: 1, maximum: 256 }), frames: Type.Integer({ minimum: 1, maximum: MAX_STRIP_FRAMES }), fps: range(1, 60) }) }),
]);
const characterSet = Type.Object({
  name: givenName,
  characters: Type.Array(Type.Object({
    name: givenName,
    alt: optional(text(200)),
    states: Type.Object({ idle: charFrame, running: optional(charFrame), waiting: optional(charFrame) }),
  }), { maxItems: MAX_SET_CHARACTERS }),
  selection: optional(literals(CHARACTER_SELECTIONS)),
});
const arrangement = Type.Object({
  grid: optional(Type.Object({
    slots: Type.Object({ main: literals(ARRANGEMENT_PANES), side: literals(ARRANGEMENT_PANES), bottom: literals(ARRANGEMENT_PANES) }),
    visible: Type.Object({ editor: Type.Boolean(), terminal: Type.Boolean() }),
    sideWidth: coordinate,
    bottomHeight: coordinate,
  })),
  sidebarWidth: optional(coordinate),
  sectionOrder: optional(Type.Array(literals(ARRANGEMENT_SECTIONS), { minItems: ARRANGEMENT_SECTIONS.length - 1, maxItems: ARRANGEMENT_SECTIONS.length, uniqueItems: true })),
  sections: optional(partialOf(ARRANGEMENT_SECTIONS, Type.Object({ collapsed: Type.Boolean(), size: optional(range(MIN_ARRANGEMENT_SECTION, MAX_ARRANGEMENT_COORDINATE)) }))),
});
const side = Type.Integer({ minimum: 1, maximum: 8192 });
const assetMeta = Type.Object({
  kind: literals(ASSET_KINDS),
  mime: text(100),
  bytes: count(MAX_MOVING_BYTES),
  width: optional(side),
  height: optional(side),
  frames: optional(count(MAX_ANIMATION_FRAMES)),
  durationMs: optional(count(MAX_VIDEO_MS)),
  family: optional(fontName),
  // an animated image has a frame cap and no duration cap, so its flash may start at any time
  flash: optional(Type.Object({ flagged: Type.Boolean(), atMs: optional(count(Number.MAX_SAFE_INTEGER)) })),
  license: Type.Object({ spdx: optional(text(64)), text: optional(text(20_000)), author: optional(text(200)), source: optional(text(2048)) }),
});
const origin = Type.Object({
  kind: literals(ORIGIN_KINDS),
  from: optional(text(200)),
  url: optional(text(2048)),
  store: optional(Type.Object({ entryId: text(200), version: text(64), sha256 })),
  installedHash: optional(sha256),
  layoutOptIn: optional(Type.Boolean()),
  installedAt: instant,
  removedFromStore: optional(Type.Object({ reason: text(MAX_REMOVED_REASON_CHARS), at: instant })),
});

// Text size is the user's own setting: a theme naming any size is refused, never read.
const NO_SIZE = { propertyNames: { not: { pattern: '[Ss][Ii][Zz][Ee]' } } };

const ThemeSchema = Type.Object({
  schemaVersion: Type.Literal(THEME_SCHEMA_VERSION),
  id: text(64),
  name: lineName(256),
  description: optional(text(MAX_THEME_DESCRIPTION_CHARS)),
  author: optional(text(MAX_THEME_AUTHOR_CHARS)),
  version: optional(text(MAX_THEME_VERSION_CHARS)),
  license: optional(Type.String({ pattern: '^(?:LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.+-]*)$', maxLength: MAX_THEME_LICENSE_CHARS })),
  looks: Type.Object({ dark: optional(look), light: optional(look) }),
  style: optional(Type.Object({
    fonts: optional(Type.Object({ ui: optional(fontChoice), mono: optional(fontChoice) }, NO_SIZE)),
    lineHeight: optional(within(LINE_HEIGHT_RANGE)),
    radius: optional(within(RADIUS_RANGE)),
    density: optional(within(DENSITY_RANGE)),
    chatColumn: optional(Type.Union([within(CHAT_COLUMN_RANGE), Type.Literal('full')])),
  }, NO_SIZE)),
  characters: optional(characterSet),
  css: optional(partialOf(CSS_REGIONS, text(65_536))),
  layout: optional(arrangement),
  assets: optional(Type.Record(Type.String({ pattern: SHA256 }), assetMeta, { additionalProperties: false, maxProperties: MAX_THEME_ASSETS })),
  origin: optional(origin),
}, NO_SIZE);

/** The JSON schema of a theme file, for `npm run generate:theme-schema`. */
export const themeSchema: TSchema = ThemeSchema;

export type SchemaVersionCheck = { readonly kind: 'supported' } | { readonly kind: 'needsNewer'; readonly version: number } | { readonly kind: 'invalid' };

/** Whether this app reads the file's schemaVersion; a newer one is listed "Needs a newer Damocles", never shown as broken. */
export function checkSchemaVersion(json: unknown): SchemaVersionCheck {
  const version = isRecord(json) ? json['schemaVersion'] : undefined;
  if (version === THEME_SCHEMA_VERSION) return { kind: 'supported' };
  // a safe integer, the most a list entry carries on the wire; a larger number is no version
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > THEME_SCHEMA_VERSION) return { kind: 'needsNewer', version };
  return { kind: 'invalid' };
}

/** One thing wrong with a theme file: where, as a JSON Pointer, and what, as text a view renders in its own language. */
export interface ThemeError {
  readonly path: string;
  readonly text: LocalizedText;
}

// never empty: a refused theme names at least one error
export type ThemeErrors = readonly [ThemeError, ...ThemeError[]];

export type ThemeValidation =
  | { readonly ok: true; readonly theme: ThemeFile; readonly unknownKeys: readonly string[] }
  | { readonly ok: false; readonly needsNewer?: number; readonly errors: ThemeErrors };

/** The first error as view-facing text, its path before it. */
export const themeErrorText = (errors: ThemeErrors): LocalizedText => l('{0}: {1}', errors[0].path, errors[0].text);

/** An error in English, as the model and a log line read it. */
export const themeErrorEnglish = (error: ThemeError): string => `${error.path}: ${englishText(error.text)}`;

const RESERVED_ID = /^damocles(?:-[a-z0-9]+)*$/;

/**
 * Checks a parsed theme.json. `builtin` allows (and requires) a reserved `damocles` or `damocles-*` id; `folder` is
 * the name of the folder the file was read from, which must equal the id. Keys the format does not know are dropped
 * from the returned theme and listed.
 */
export function validateTheme(json: unknown, options: { readonly builtin?: boolean; readonly folder?: string } = {}): ThemeValidation {
  const version = checkSchemaVersion(json);
  if (version.kind === 'needsNewer') return { ok: false, needsNewer: version.version, errors: [{ path: '/schemaVersion', text: l('format version {0} needs a newer Damocles', String(version.version)) }] };
  if (!Value.Check(ThemeSchema, json)) {
    const errors = new Map<string, ThemeError>();
    for (const found of Value.Errors(ThemeSchema, json)) {
      const error = { path: found.instancePath || '/', text: schemaMessage(found) };
      if (!errors.has(themeErrorEnglish(error))) errors.set(themeErrorEnglish(error), error);
    }
    const [first = { path: '/', text: l('does not match the theme format') }, ...rest] = errors.values();
    return { ok: false, errors: [first, ...rest] };
  }
  const shaped: ThemeFile = json;
  const unknownKeys: string[] = [];
  const kept = known(ThemeSchema as unknown as JsonSchema, shaped, '', unknownKeys) as ThemeFile;
  const [first, ...rest] = codeChecks(kept, options);
  if (first) return { ok: false, errors: [first, ...rest] };
  const sectionOrder = parseSectionOrder(kept.layout?.sectionOrder);
  const theme = kept.layout && sectionOrder ? { ...kept, layout: { ...kept.layout, sectionOrder } } : kept;
  return { ok: true, theme, unknownKeys };
}

/**
 * The sidebar's section order, or undefined unless it names every section exactly once. An order 3.9.0 saved names every
 * section but the Graph, which goes right after Source control, as in the default order.
 */
export function parseSectionOrder(raw: unknown): readonly ArrangementSection[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const order = raw.filter((name): name is ArrangementSection => (ARRANGEMENT_SECTIONS as readonly unknown[]).includes(name));
  if (order.length !== raw.length || new Set(order).size !== order.length) return undefined;
  if (order.length === ARRANGEMENT_SECTIONS.length) return order;
  if (order.length !== ARRANGEMENT_SECTIONS.length - 1 || order.includes('graph')) return undefined;
  const scm = order.indexOf('scm');
  return [...order.slice(0, scm + 1), 'graph', ...order.slice(scm + 1)];
}

// The two schema failures whose own message does not say what is wrong: a one-line name, and a key the closed `assets` refuses.
function schemaMessage(error: { readonly keyword: string; readonly params: object; readonly message: string }): LocalizedText {
  if (error.keyword === 'pattern' && 'pattern' in error.params && error.params.pattern === ONE_LINE_NAME) return l('must be one line, with no control or text direction characters');
  // any other failure is worded by the schema library, in its own words
  return error.keyword === 'boolean' ? l('is not a sha256') : l('{0}', error.message);
}

const NAME_RULE: LocalizedText = l('must be 1 to {0} characters, not only spaces', String(MAX_THEME_NAME_CHARS));
const nameHolds = (name: string): boolean => {
  const length = [...name].length;
  return length >= 1 && length <= MAX_THEME_NAME_CHARS && name.trim() !== '';
};

function codeChecks(theme: ThemeFile, options: { readonly builtin?: boolean; readonly folder?: string }): ThemeError[] {
  const errors: ThemeError[] = [];
  const fail = (path: string, text: LocalizedText): void => {
    errors.push({ path, text });
  };
  if (options.builtin === true ? !RESERVED_ID.test(theme.id) : !USER_THEME_ID.test(theme.id)) {
    if (RESERVED_ID.test(theme.id)) fail('/id', l('{0} is reserved for built-in themes', theme.id));
    else fail('/id', options.builtin === true ? l('{0} is not damocles or damocles-*', theme.id) : l('{0} is not a lowercase UUID', theme.id));
  }
  if (options.folder !== undefined && options.folder !== theme.id) fail('/id', l('{0} does not match its folder {1}', theme.id, options.folder));
  if (!nameHolds(theme.name)) fail('/name', NAME_RULE);
  if (!theme.looks.dark && !theme.looks.light) fail('/looks', l('needs a dark or a light look'));
  for (const [kind, look] of Object.entries(theme.looks)) {
    for (const [token, value = ''] of Object.entries(look?.tokens ?? {})) {
      if (isValidTokenValue(token as TokenName, value.toLowerCase())) continue;
      fail(`/looks/${kind}/tokens/${token}`, token === SHADOW_TOKEN ? l('{0} is not two to four px lengths and a #rrggbb or #rrggbbaa color', value) : l('{0} is not a #rrggbb or #rrggbbaa color', value));
    }
    (look?.wallpapers ?? []).forEach((set, i) => {
      if (set.span && new Set(set.span.panels).size !== set.span.panels.length) fail(`/looks/${kind}/wallpapers/${i}/span/panels`, l('names a panel twice'));
    });
  }
  const fonts = theme.style?.fonts;
  for (const [role, font] of Object.entries(fonts ?? {})) {
    const name = font && ('installed' in font ? font.installed : font.family);
    if (name !== undefined && !FONT_NAME.test(name)) fail(`/style/fonts/${role}`, l('{0} is not a font name', name));
    else if (font && 'installed' in font && reservedFontName(font.installed)) fail(`/style/fonts/${role}`, l('{0} is a name Damocles keeps for its own fonts', font.installed));
  }
  const fontAssets = Object.entries(theme.assets ?? {}).filter(([, asset]) => asset.kind === 'font');
  if (fontAssets.length > MAX_THEME_FONTS) fail('/assets', l('holds {0} fonts, more than {1}', String(fontAssets.length), String(MAX_THEME_FONTS)));
  for (const [sha, asset] of fontAssets) if (asset.bytes > MAX_FONT_BYTES) fail(`/assets/${sha}`, l('a font larger than {0} MB', String(MAX_FONT_BYTES / 1024 / 1024)));
  const grid = theme.layout?.grid;
  if (grid && new Set(Object.values(grid.slots)).size !== ARRANGEMENT_PANES.length) fail('/layout/grid/slots', l('must place each pane in exactly one slot'));
  const order = theme.layout?.sectionOrder;
  if (order && !parseSectionOrder(order)) fail('/layout/sectionOrder', l('must name every section once'));
  for (const ref of assetRefs(theme)) {
    const asset = theme.assets?.[ref.sha];
    if (!asset) fail(ref.path, l('asset {0} is not in assets', ref.sha));
    else if (!ASSET_USES[ref.use].kinds.includes(asset.kind)) fail(ref.path, ASSET_USES[ref.use].wrong(ref.sha, ASSET_NOUNS[asset.kind]));
  }
  errors.push(...characterChecks(theme));
  return errors;
}

export type StripRefusal = 'kind' | 'animated' | 'cut';

/**
 * Why `asset` cannot be cut into a strip of `frames`: a strip is one still sprite image, and a flash check ran on one cut
 * only. An asset of more than one frame with no durationMs moves on its own.
 */
export function stripRefusal(asset: Pick<AssetMeta, 'kind' | 'frames' | 'durationMs'>, frames: number): StripRefusal | undefined {
  if (asset.kind !== 'sprite') return 'kind';
  if (asset.frames === undefined) return undefined;
  if (asset.frames > 1 && asset.durationMs === undefined) return 'animated';
  return asset.frames === frames ? undefined : 'cut';
}

// A strip must cut its image into whole frames, and step no faster than the rate its import's flash check ran at (the asset's
// durationMs is one loop at that rate). Pins name a character by its name, so names are unique in a set.
function characterChecks(theme: ThemeFile): ThemeError[] {
  const errors: ThemeError[] = [];
  const fail = (path: string, text: LocalizedText): void => {
    errors.push({ path, text });
  };
  if (theme.characters && !nameHolds(theme.characters.name)) fail('/characters/name', NAME_RULE);
  const characters = theme.characters?.characters ?? [];
  if (new Set(characters.map((character) => character.name)).size !== characters.length) fail('/characters/characters', l('names a character twice'));
  characters.forEach((character, i) => {
    if (!nameHolds(character.name)) fail(`/characters/characters/${i}/name`, NAME_RULE);
    for (const [state, frame] of Object.entries(character.states)) {
      const asset = frame && 'strip' in frame ? theme.assets?.[frame.strip.asset] : undefined;
      if (!frame || !('strip' in frame) || !asset) continue;
      const { frameWidth, frameHeight, frames, fps } = frame.strip;
      const at = `/characters/characters/${i}/states/${state}/strip`;
      const refusal = stripRefusal(asset, frames);
      // assetRefs reports an asset of another kind
      if (refusal === 'kind') continue;
      if (refusal === 'animated') fail(at, l('a strip is one still image, and this one is animated already'));
      if (refusal === 'cut') fail(at, l('{0} frames is not the {1} its image\'s flash check ran on', String(frames), String(asset.frames)));
      if (asset.width !== undefined && asset.width !== frameWidth * frames) fail(at, l('{0} frames of {1} px do not make the image\'s {2} px width', String(frames), String(frameWidth), String(asset.width)));
      if (asset.height !== undefined && asset.height !== frameHeight) fail(at, l('frames {0} px high do not match the image\'s {1} px height', String(frameHeight), String(asset.height)));
      if (asset.durationMs !== undefined && Math.round((frames * 1000) / fps) < asset.durationMs) fail(at, l('{0} fps steps faster than the rate its flash check ran at', String(fps)));
    }
  });
  return errors;
}

type AssetUse = 'wallpaper' | 'sprite' | 'font';
interface AssetRef { readonly path: string; readonly sha: string; readonly use: AssetUse }

const ASSET_NOUNS: Readonly<Record<AssetKind, LocalizedText>> = {
  image: l('a still image'), animated: l('an animated image'), video: l('a video'), font: l('a font'), sprite: l('a character sprite'),
};
// The kinds each use takes, and its refusal of another kind as one whole message.
const ASSET_USES: Readonly<Record<AssetUse, { readonly kinds: readonly AssetKind[]; wrong(sha: string, is: LocalizedText): LocalizedText }>> = {
  wallpaper: { kinds: ['image', 'animated', 'video'], wrong: (sha, is) => l('asset {0} is {1}, not an image or a video', sha, is) },
  sprite: { kinds: ['sprite'], wrong: (sha, is) => l('asset {0} is {1}, not a character sprite', sha, is) },
  font: { kinds: ['font'], wrong: (sha, is) => l('asset {0} is {1}, not a font', sha, is) },
};

function assetRefs(theme: ThemeFile): AssetRef[] {
  const frame = (path: string, f: CharFrame | undefined): AssetRef[] => (f === undefined ? [] : [{ path, sha: 'asset' in f ? f.asset : f.strip.asset, use: 'sprite' }]);
  const fonts = Object.entries(theme.style?.fonts ?? {}).flatMap(([role, font]): AssetRef[] => (font && 'asset' in font ? [{ path: `/style/fonts/${role}`, sha: font.asset, use: 'font' }] : []));
  const wallpapers = Object.entries(theme.looks).flatMap(([kind, look]) => (look?.wallpapers ?? []).flatMap((set, i): AssetRef[] => [
    ...(set.span ? [{ path: `/looks/${kind}/wallpapers/${i}/span`, sha: set.span.asset, use: 'wallpaper' as const }] : []),
    ...Object.entries(set.panels ?? {}).map(([name, p]) => ({ path: `/looks/${kind}/wallpapers/${i}/panels/${name}`, sha: p!.asset, use: 'wallpaper' as const })),
  ]));
  const characters = (theme.characters?.characters ?? []).flatMap((character, i) =>
    Object.entries(character.states).flatMap(([state, f]) => frame(`/characters/characters/${i}/states/${state}`, f)));
  return [...fonts, ...wallpapers, ...characters];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type JsonSchema = Record<string, unknown>;

// An unknown key's path is a JSON Pointer (RFC 6901), so a key may hold a slash.
const pointerSegment = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');

/** The keys an unknown-key path of validateTheme names, in order. */
export const pointerSegments = (path: string): string[] => path.split('/').slice(1).map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

/** A copy of `value` holding only the keys `schema` names, each unknown key's path pushed to `unknown`; `value` already passed Check. */
function known(schema: JsonSchema, value: unknown, path: string, unknown: string[]): unknown {
  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    const branch = (anyOf as JsonSchema[]).find((option) => Value.Check(option as TSchema, value));
    return branch ? known(branch, value, path, unknown) : value;
  }
  if (Array.isArray(value)) {
    const items = schema['items'];
    return isRecord(items) ? value.map((item, i) => known(items, item, `${path}/${i}`, unknown)) : value;
  }
  if (!isRecord(value)) return value;
  const properties = isRecord(schema['properties']) ? schema['properties'] : undefined;
  const patterns = isRecord(schema['patternProperties']) ? Object.values(schema['patternProperties']) : [];
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    // an own property only: an inherited name such as __proto__ is a key the format does not know
    const childSchema = properties === undefined ? patterns[0] : Object.hasOwn(properties, key) ? properties[key] : undefined;
    const at = `${path}/${pointerSegment(key)}`;
    if (!isRecord(childSchema)) {
      unknown.push(at);
      return [];
    }
    return [[key, known(childSchema, child, at, unknown)]];
  }));
}
