// The drawn miniature of a theme (ThemeMiniature.vue): a 320 x 200 window of fixed sample content, painted only from the
// --m-* properties set on its own groups from the theme's data, never from the page's tokens. Pure: no DOM, no Vue.
import { BUILTIN_PALETTES, BUILTIN_THEME_ID } from '@shared/themes/builtin';
import { deriveLook } from '@shared/themes/derive';
import { fontStack } from '@shared/themes/fonts';
import { LOOK_SEEDS, type Fit, type Look, type Panel, type ThemeFile } from '@shared/themes/schema';
import { DEFAULT_CHAT_COLUMN, type ThemeStyle } from '@shared/themes/style';
import { panelWallpapers, shownSet, stillUrl, surfaceOpacityOf, themeBlobUrl, thumbUrl } from '@shared/themes/wallpapers';
import type { LookKind, ThemePalette, TokenName } from '@shared/themes/tokens';

export type MiniatureMode = 'dark' | 'light' | 'split';

export interface MiniNode {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string | number>>;
  readonly children?: readonly MiniNode[];
  readonly text?: string;
}

// The miniature's own properties and the palette token each one takes.
const VARS: ReadonlyArray<readonly [string, TokenName]> = [
  ['bg', '--d-bg'], ['panel', '--d-panel'], ['card', '--d-card'], ['hover', '--d-hover'], ['border', '--d-border'],
  ['text', '--d-text'], ['muted', '--d-muted'], ['faint', '--d-faint'], ['accent', '--d-accent-fill'], ['on-accent', '--d-on-accent'],
  ['success', '--d-success-fill'], ['warning', '--d-warning-fill'], ['danger', '--d-danger-fill'], ['info', '--d-info-fill'],
  ['code', '--d-code'], ['input', '--d-input'],
  ['kw', '--s-kw'], ['str', '--s-str'], ['num', '--s-num'], ['com', '--s-com'], ['fn', '--s-fn'], ['type', '--s-type'],
  ['a1', '--d-ansi-1'], ['a2', '--d-ansi-2'], ['a3', '--d-ansi-3'], ['a4', '--d-ansi-4'],
];
// a derived palette's colors are lowercase
const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;
// a theme's own seed, as the format takes it
const SEED = /^#[0-9a-fA-F]{6}$/;
/** Whether `value` is a #rrggbb or #rrggbbaa color, the only thing a card paints a swatch from. */
export const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value);

const palettes = new Map<string, ThemePalette>();
const MAX_PALETTES = 128;

/** Every token of a theme's look, derived once per look's content; none for a look whose seeds are not all colors. */
export function lookPalette(theme: ThemeFile, kind: LookKind): ThemePalette | undefined {
  const look = theme.looks[kind];
  if (!look || !LOOK_SEEDS.every((seed) => SEED.test(look.colors[seed]))) return undefined;
  if (theme.id === BUILTIN_THEME_ID) return BUILTIN_PALETTES[kind];
  const key = `${kind}\n${JSON.stringify(look.colors)}\n${JSON.stringify(look.tokens ?? {})}`;
  const known = palettes.get(key);
  if (known) return known;
  const palette = deriveLook(look.colors, kind, look.tokens);
  if (palettes.size >= MAX_PALETTES) palettes.clear();
  palettes.set(key, palette);
  return palette;
}

/** The style of one window group: each --m-* property from the look's palette; a value that is not a hex color is left out. */
export function miniatureStyle(palette: ThemePalette): Record<string, string> {
  return Object.fromEntries(VARS.flatMap(([name, token]) => {
    const value = palette[token];
    return value !== undefined && HEX.test(value) ? [[`--m-${name}`, value]] : [];
  }));
}

/** The kinds a miniature of `mode` draws, given the looks the theme has. */
export function shownKinds(theme: ThemeFile, mode: MiniatureMode): LookKind[] {
  const has = (kind: LookKind): boolean => theme.looks[kind] !== undefined;
  if (mode === 'split' && has('dark') && has('light')) return ['dark', 'light'];
  if (mode !== 'split' && has(mode)) return [mode];
  return has('dark') ? ['dark'] : ['light'];
}

// Fill classes: Tailwind utilities reading the miniature's own properties, so the page's tokens never reach it.
const FILL: Readonly<Record<string, string>> = {
  bg: 'fill-(--m-bg)', panel: 'fill-(--m-panel)', card: 'fill-(--m-card)', hover: 'fill-(--m-hover)', text: 'fill-(--m-text)',
  muted: 'fill-(--m-muted)', faint: 'fill-(--m-faint)', accent: 'fill-(--m-accent)', success: 'fill-(--m-success)',
  warning: 'fill-(--m-warning)', code: 'fill-(--m-code)', input: 'fill-(--m-input)', kw: 'fill-(--m-kw)', str: 'fill-(--m-str)',
  num: 'fill-(--m-num)', com: 'fill-(--m-com)', fn: 'fill-(--m-fn)', type: 'fill-(--m-type)', a1: 'fill-(--m-a1)',
  a2: 'fill-(--m-a2)', a3: 'fill-(--m-a3)', a4: 'fill-(--m-a4)',
};
const STROKE = 'fill-none stroke-(--m-border)';
// The theme's mono stack, set on each window group as --m-mono; its UI stack is the group's own font-family.
const MONO = 'font-(family-name:--m-mono)';
// Below 34rem of the miniature's own width it draws bars; from 34rem the sample text.
const TEXT_ONLY = 'hidden @min-[34rem]/mini:inline';
const BAR_ONLY = '@min-[34rem]/mini:hidden';

const node = (tag: string, attrs: Record<string, string | number>, children?: readonly MiniNode[], text?: string): MiniNode =>
  ({ tag, attrs, ...(children ? { children } : {}), ...(text !== undefined ? { text } : {}) });
const rect = (x: number, y: number, width: number, height: number, cls: string, extra: Record<string, string | number> = {}): MiniNode =>
  node('rect', { x, y, width, height, class: cls, ...extra });
const bar = (x: number, y: number, width: number, height: number, fill: string): MiniNode =>
  rect(x, y, width, height, `${BAR_ONLY} ${FILL[fill]}`, { rx: height / 2 });
const label = (x: number, y: number, size: number, fill: string, body: string, extra: Record<string, string | number> = {}): MiniNode =>
  node('text', { x, y, 'font-size': size, class: `${TEXT_ONLY} ${FILL[fill]}`, ...extra }, undefined, body);
const line = (x1: number, y1: number, x2: number, y2: number, width: number): MiniNode =>
  node('line', { x1, y1, x2, y2, class: STROKE, 'stroke-width': width });

type Segment = readonly [fill: string, body: string];

// Mono runs laid out at a fixed advance, so bars and glyphs line up.
function monoLine(x: number, y: number, size: number, segments: readonly Segment[]): MiniNode[] {
  const advance = size * 0.6;
  let column = 0;
  const bars: MiniNode[] = [];
  const spans: MiniNode[] = [];
  for (const [fill, body] of segments) {
    const lead = body.length - body.trimStart().length;
    const word = body.trim();
    if (word) {
      const at = x + (column + lead) * advance;
      bars.push(bar(at, y - size * 0.62, word.length * advance, size * 0.55, fill));
      spans.push(node('tspan', { x: at, class: FILL[fill]! }, undefined, word));
    }
    column += body.length + 1;
  }
  return [...bars, node('text', { y, 'font-size': size, class: `${TEXT_ONLY} ${MONO}` }, spans)];
}

const PROJECTS = [
  { name: 'api-server', branch: 'main', tint: 'accent' },
  { name: 'website', branch: 'feat/nav', tint: 'kw', state: 'running' },
  { name: 'infra', branch: 'main', tint: 'str', state: 'waiting' },
  { name: 'notes', branch: 'drafts', tint: 'type' },
] as const;

const CODE: ReadonlyArray<readonly Segment[]> = [
  [['kw', 'import'], ['text', '{ load }'], ['kw', 'from'], ['str', '"./theme";']],
  [],
  [['com', '// pick the look for tonight']],
  [['kw', 'export'], ['kw', 'function'], ['fn', 'pick(hour:'], ['type', 'number)'], ['text', '{']],
  [['kw', '  const'], ['text', 'dark = hour >'], ['num', '19;']],
  [['kw', '  return'], ['fn', 'load(dark ?'], ['str', '"night"'], ['text', ':'], ['str', '"day");']],
  [['text', '}']],
  [],
  [['kw', 'type'], ['type', 'Look'], ['text', '='], ['str', '"dark"'], ['text', '|'], ['str', '"light";']],
  [['kw', 'const'], ['text', 'MAX ='], ['num', '8;']],
  [['com', '// sets a look may cycle']],
  [['kw', 'export'], ['text', '{ pick, MAX };']],
];

const TERMINAL: ReadonlyArray<readonly Segment[]> = [
  [['a2', '$'], ['text', 'npm test']],
  [['a2', 'ok 42 passed'], ['muted', '(1.8s)']],
  [['a3', 'warn'], ['text', 'unused import']],
  [['a1', 'fail'], ['text', 'lint: 1 error']],
  [['a4', '->'], ['a4', 'localhost:5173']],
];

// The chat column's centre and its width at the default 50rem, in viewBox units; the chat slot holds at most CHAT_FULL.
const CHAT_CENTER = 136;
const CHAT_DEFAULT = 128;
const CHAT_FULL = 136;

/** The chat column's width in viewBox units for a theme's chatColumn, as `.chat-column` lays it out against a 50rem default. */
export function miniChatColumn(chatColumn: ThemeStyle['chatColumn']): number {
  if (chatColumn === 'full') return CHAT_FULL;
  return Math.min(CHAT_FULL, ((chatColumn ?? DEFAULT_CHAT_COLUMN) * CHAT_DEFAULT) / DEFAULT_CHAT_COLUMN);
}

// The chat's messages and composer drawn at `scale` around the column's centre, the messages from the top and the composer
// from the bottom, so a narrower column draws narrower and smaller, never cut or condensed.
const scaledFrom = (scale: number, y: number, children: readonly MiniNode[]): MiniNode =>
  node('g', { transform: `matrix(${scale} 0 0 ${scale} ${CHAT_CENTER * (1 - scale)} ${y * (1 - scale)})` }, children);

// Each panel's rectangle in the window, x y width height, and the fill it paints.
const MINI_PANES: Readonly<Record<Panel, readonly [number, number, number, number]>> = {
  titlebar: [0, 0, 320, 12], sidebar: [0, 12, 64, 188], chat: [64, 12, 144, 188], editor: [208, 12, 112, 112], terminal: [208, 124, 112, 76],
};
const PANE_FILL: Readonly<Record<Panel, string>> = { titlebar: 'panel', sidebar: 'panel', chat: 'bg', editor: 'code', terminal: 'bg' };
// The miniature draws a 1280 px window 320 units wide, so a blur's px are a quarter of its units.
const MINI_SCALE = 320 / 1280;
const ASPECT: Readonly<Record<Fit, string>> = { fill: 'xMidYMid slice', fit: 'xMidYMid meet', center: 'xMidYMid meet', tile: 'xMidYMid slice' };

/** What a look's wallpapers add to its window: the images under the panes, each pane's dim and the surface opacity. */
export interface MiniWall {
  readonly under: readonly MiniNode[];
  // a wallpapered pane's own fill takes its dim as opacity over the image, which is the window's dim overlay in the pane's color
  readonly dims: Partial<Record<Panel, number>>;
  readonly surface: number;
}

/** Where a wallpaper asset's thumbnail is: an installed theme's cache, or a URL the page holds for an asset key; '' when it holds none. */
export type MiniThumbs = (asset: string) => string;

/**
 * The wallpapers of `look` as the miniature draws them: each panel's 480 px thumbnail, clipped to the panel and blurred. A
 * panel whose thumbnail the page does not hold draws as a plain pane; none when no panel has one. `id` prefixes the ids it defines.
 */
export function miniWall(look: Look, id: string, thumbs: MiniThumbs = thumbUrl): MiniWall | undefined {
  const wallpapers = panelWallpapers(shownSet(look)).flatMap((wallpaper) => {
    const href = thumbs(wallpaper.asset);
    return href === '' ? [] : [{ ...wallpaper, href }];
  });
  if (wallpapers.length === 0) return undefined;
  const under = wallpapers.flatMap((wallpaper): MiniNode[] => {
    const [x, y, width, height] = MINI_PANES[wallpaper.panel];
    const spanned = (wallpaper.span ?? []).map((panel) => MINI_PANES[panel]);
    const left = Math.min(x, ...spanned.map((r) => r[0]));
    const top = Math.min(y, ...spanned.map((r) => r[1]));
    const right = Math.max(x + width, ...spanned.map((r) => r[0] + r[2]));
    const bottom = Math.max(y + height, ...spanned.map((r) => r[1] + r[3]));
    const clip = `${id}-wall-${wallpaper.panel}`;
    const blur = `${id}-blur-${wallpaper.panel}`;
    return [
      node('defs', {}, [
        node('clipPath', { id: clip }, [node('rect', { x, y, width, height })]),
        ...(wallpaper.blur > 0 ? [node('filter', { id: blur }, [node('feGaussianBlur', { stdDeviation: wallpaper.blur * MINI_SCALE })])] : []),
      ]),
      node('g', { 'clip-path': `url(#${clip})` }, [node('image', {
        href: wallpaper.href, x: left, y: top, width: right - left, height: bottom - top, preserveAspectRatio: ASPECT[wallpaper.fit],
        ...(wallpaper.blur > 0 ? { filter: `url(#${blur})` } : {}),
      })]),
    ];
  });
  // only a panel that draws its image is dimmed and see-through
  return { under, dims: Object.fromEntries(wallpapers.map((wallpaper) => [wallpaper.panel, wallpaper.dim])), surface: surfaceOpacityOf(look) };
}

/** A character's idle frame as the miniature draws it: one frame of `frames` side by side in the image at `href`. */
export interface MiniCharacter {
  readonly href: string;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
}

/** The first characters of a theme's set, one per sample project, each its idle state's first frame; none without a set. */
export function miniCharacters(theme: Pick<ThemeFile, 'characters' | 'assets'>): MiniCharacter[] {
  return (theme.characters?.characters ?? []).slice(0, PROJECTS.length).flatMap((character): MiniCharacter[] => {
    const frame = character.states.idle;
    const sha = 'asset' in frame ? frame.asset : frame.strip.asset;
    const asset = theme.assets?.[sha];
    if (!asset) return [];
    if ('strip' in frame) return [{ href: themeBlobUrl(sha), width: frame.strip.frameWidth, height: frame.strip.frameHeight, frames: frame.strip.frames }];
    const animated = asset.mime !== 'image/svg+xml' && (asset.frames ?? 1) > 1;
    return [{ href: animated ? stillUrl(sha) : themeBlobUrl(sha), width: asset.width ?? 1, height: asset.height ?? 1, frames: 1 }];
  });
}

// A character in an 8-unit square at (x, y), its first frame clipped by a nested viewport, its pixels kept square.
const characterNode = (x: number, y: number, character: MiniCharacter): MiniNode => node('svg', { x, y, width: 8, height: 8, viewBox: `0 0 ${character.width} ${character.height}`, preserveAspectRatio: 'xMidYMid meet' }, [
  node('image', { href: character.href, x: 0, y: 0, width: character.width * character.frames, height: character.height, preserveAspectRatio: 'none', style: 'image-rendering:pixelated', 'data-testid': 'mini-character' }),
]);

/**
 * One window of fixed sample content; `radius` scales every corner, `column` is the chat column's width (miniChatColumn), and
 * `wall` draws the look's wallpapers under see-through panes and surfaces. `characters` replace the projects' letters, the
 * running project's lifted a unit.
 */
export function windowNodes(radius: number, column: number = CHAT_DEFAULT, wall?: MiniWall, characters: readonly MiniCharacter[] = []): MiniNode[] {
  const r = (n: number): number => n * radius;
  const pane = (panel: Panel): MiniNode => {
    const [x, y, width, height] = MINI_PANES[panel];
    const dim = wall?.dims[panel];
    return rect(x, y, width, height, FILL[PANE_FILL[panel]]!, dim === undefined ? {} : { 'fill-opacity': dim });
  };
  // bubbles, cards, code blocks and the composer let the wallpaper through at the look's surface opacity
  const surface = wall && wall.surface < 1 ? { 'fill-opacity': wall.surface } : {};
  const out: MiniNode[] = [
    ...(wall?.under ?? []),
    pane('titlebar'), pane('sidebar'), pane('chat'), pane('editor'), pane('terminal'),
    // title bar
    line(0, 12, 320, 12, 0.6),
    rect(4, 3, 6, 6, FILL['accent']!, { rx: r(1.6) }),
    bar(14, 4.8, 20, 2.4, 'text'), bar(37, 4.8, 30, 2.4, 'muted'),
    label(14, 8.3, 4.8, 'text', 'Damocles', { 'font-weight': 600 }), label(39.5, 8.3, 4.8, 'muted', '/  api-server'),
    ...[300, 306, 312].map((cx) => node('circle', { cx, cy: 6, r: 1.3, class: FILL['faint']! })),
    // sidebar
    line(64, 12, 64, 200, 0.6),
    bar(6, 17, 18, 1.8, 'faint'), label(6, 19.6, 3.6, 'faint', 'PROJECTS', { 'letter-spacing': 0.3, 'font-weight': 600 }),
  ];
  PROJECTS.forEach((project, i) => {
    const y = 23 + i * 15;
    if (i === 0) out.push(rect(3, y, 58, 13, FILL['accent']!, { rx: r(2.5), 'fill-opacity': 0.16 }));
    const character = characters[i];
    if (character) out.push(characterNode(6, y + 2.5 - ('state' in project && project.state === 'running' ? 1 : 0), character));
    else {
      out.push(
        rect(6, y + 2.5, 8, 8, FILL[project.tint]!, { rx: r(1.6), 'fill-opacity': 0.22 }),
        rect(8.6, y + 5.1, 2.8, 2.8, `${BAR_ONLY} ${FILL[project.tint]}`, { rx: 0.6 }),
        label(10, y + 8.6, 5, project.tint, project.name[0]!.toUpperCase(), { 'text-anchor': 'middle', 'font-weight': 700 }),
      );
    }
    out.push(
      bar(17, y + 3.4, 24 + (i % 2) * 6, 2.4, 'text'), bar(17, y + 7.8, 13, 1.8, 'faint'),
      label(17, y + 6.6, 4.6, 'text', project.name, i === 0 ? { 'font-weight': 600 } : {}),
      node('text', { x: 17, y: y + 11, 'font-size': 3.3, class: `${TEXT_ONLY} ${MONO} ${FILL['faint']}` }, undefined, project.branch),
    );
    if ('state' in project) {
      const tone = project.state === 'running' ? 'accent' : 'warning';
      out.push(rect(51, y + 4, 8, 5, FILL[tone]!, { rx: 2.5, 'fill-opacity': 0.22 }), node('circle', { cx: 53.4, cy: y + 6.5, r: 1, class: FILL[tone]! }));
    }
  });
  const scale = column / CHAT_DEFAULT;
  // chat: a user bubble, an answer, a tool card, a code block and the composer
  const messages: MiniNode[] = [
    rect(128, 20, 72, 16, FILL['hover']!, { rx: r(4), ...surface }),
    bar(133, 25, 58, 2.2, 'text'), bar(133, 29.5, 38, 2.2, 'text'),
    label(133, 26.6, 4.2, 'text', 'Make the sidebar calmer and'), label(133, 31.8, 4.2, 'text', 'use a warmer accent.'),
    bar(72, 44, 118, 2.2, 'text'), bar(72, 49, 124, 2.2, 'text'), bar(72, 54, 76, 2.2, 'muted'),
    label(72, 46, 4.2, 'text', 'Done. I softened the panels and moved the'), label(72, 51.2, 4.2, 'text', 'accent to amber. Contrast stays at AA.'),
    label(72, 56.4, 4.2, 'muted', 'Two tokens were nudged to pass.'),
    rect(72, 62, 128, 15, FILL['card']!, { rx: r(3), ...surface }), rect(72, 62, 128, 15, STROKE, { rx: r(3), 'stroke-width': 0.6 }),
    rect(75, 64.5, 10, 10, FILL['accent']!, { rx: r(2), 'fill-opacity': 0.18 }), rect(78, 67.5, 4, 4, FILL['accent']!, { rx: 0.8 }),
    bar(89, 68.4, 20, 2.4, 'text'), bar(112, 68.6, 44, 2, 'muted'),
    label(89, 71.2, 4.2, 'text', 'ThemeSet', { 'font-weight': 600 }),
    node('text', { x: 112, y: 71.2, 'font-size': 3.8, class: `${TEXT_ONLY} ${MONO} ${FILL['muted']}` }, undefined, 'amber, dark look'),
    node('circle', { cx: 193, cy: 69.5, r: 2.4, class: FILL['success']! }),
    bar(72, 86, 110, 2.2, 'text'), bar(72, 91, 92, 2.2, 'text'),
    label(72, 88, 4.2, 'text', 'Want the terminal colors to match too?'), label(72, 93.2, 4.2, 'muted', 'I can preview them first.'),
    rect(72, 99, 128, 22, FILL['code']!, { rx: r(3), ...surface }), rect(72, 99, 128, 22, STROKE, { rx: r(3), 'stroke-width': 0.6 }),
    ...monoLine(76, 106.5, 3.8, [['kw', 'accent:'], ['str', '"amber"']]),
    ...monoLine(76, 113, 3.8, [['kw', 'radius:'], ['num', '0.6'], ['com', '// softer']]),
  ];
  const composer: MiniNode[] = [
    rect(70, 172, 132, 22, FILL['input']!, { rx: r(5), ...surface }), rect(70, 172, 132, 22, STROKE, { rx: r(5), 'stroke-width': 0.6 }),
    bar(76, 179, 46, 2.2, 'faint'), label(76, 181, 4.2, 'faint', 'Ask Damocles…'),
    rect(186, 182, 11, 9, FILL['accent']!, { rx: r(2.5) }),
    node('path', { d: 'M189.5 186.5h4m-1.6-1.6 1.6 1.6-1.6 1.6', class: 'fill-none stroke-(--m-on-accent)', 'stroke-width': 0.7 }),
  ];
  out.push(
    node('g', { 'data-chat-column': Math.round(column * 100) / 100 }, [scaledFrom(scale, 20, messages), scaledFrom(scale, 194, composer)]),
    // editor
    rect(208, 12, 112, 10, FILL['panel']!), rect(208, 12, 38, 10, FILL['code']!),
    line(208, 22, 320, 22, 0.5), line(208, 12, 208, 200, 0.6),
    rect(208, 12, 38, 0.8, FILL['accent']!),
    bar(213, 16.2, 20, 2, 'text'), bar(251, 16.2, 18, 2, 'muted'),
    label(213, 18.6, 3.8, 'text', 'theme.ts'), label(251, 18.6, 3.8, 'muted', 'app.vue'),
  );
  CODE.forEach((segments, i) => {
    const y = 30 + i * 7.2;
    out.push(bar(211, y - 2.2, 3, 1.8, 'faint'), node('text', { x: 215, y, 'font-size': 3.3, 'text-anchor': 'end', class: `${TEXT_ONLY} ${MONO} ${FILL['faint']}` }, undefined, String(i + 1)));
    if (segments.length > 0) out.push(...monoLine(219, y, 3.6, segments));
  });
  out.push(
    // terminal
    line(208, 124, 320, 124, 0.6),
    bar(213, 129, 22, 1.8, 'faint'), label(213, 131.4, 3.4, 'faint', 'TERMINAL', { 'letter-spacing': 0.3, 'font-weight': 600 }),
  );
  TERMINAL.forEach((segments, i) => out.push(...monoLine(213, 141 + i * 8.6, 3.6, segments)));
  out.push(...monoLine(213, 141 + 5 * 8.6, 3.6, [['a2', '$']]), rect(219, 141 + 5 * 8.6 - 3, 2.2, 3.6, FILL['accent']!));
  return out;
}

/**
 * The miniature's SVG content: one window, or a diagonal split with the dark look top-left and the light look bottom-right.
 * `id` is unique to the miniature in its page and prefixes every id the content defines.
 */
export function miniatureNodes(theme: ThemeFile, mode: MiniatureMode, id: string, thumbs?: MiniThumbs): MiniNode[] {
  const radius = theme.style?.radius ?? 1;
  const column = miniChatColumn(theme.style?.chatColumn);
  const kinds = shownKinds(theme, mode);
  const characters = miniCharacters(theme);
  // font stacks come from fontStack, which checks each family name and bundled asset key and quotes the family, so they hold no ';'
  const fonts = `font-family:${fontStack(theme.style?.fonts?.ui, 'ui')};--m-mono:${fontStack(theme.style?.fonts?.mono, 'mono')}`;
  const group = (kind: LookKind, extra: Record<string, string> = {}): MiniNode | undefined => {
    const palette = lookPalette(theme, kind);
    if (!palette) return undefined;
    const style = [...Object.entries(miniatureStyle(palette)).map(([name, value]) => `${name}:${value}`), fonts].join(';');
    return node('g', { style, ...extra }, windowNodes(radius, column, miniWall(theme.looks[kind]!, `${id}-${kind}`, thumbs), characters));
  };
  if (kinds.length === 1) return [group(kinds[0]!)].filter((n): n is MiniNode => n !== undefined);
  const clip = `${id}-split`;
  return [
    group('dark'),
    node('defs', {}, [node('clipPath', { id: clip }, [node('polygon', { points: '320,0 320,200 0,200' })])]),
    group('light', { 'clip-path': `url(#${clip})` }),
    // the divider takes the built-in light card color, as on every card
    node('line', { x1: 320, y1: 0, x2: 0, y2: 200, stroke: BUILTIN_PALETTES.light['--d-card']!, 'stroke-width': 1.6 }),
  ].filter((n): n is MiniNode => n !== undefined);
}
