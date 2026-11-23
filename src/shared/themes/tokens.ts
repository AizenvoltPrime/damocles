// Token names and value formats of a desktop palette. Pure: core, main and the renderers import it.
export type LookKind = 'dark' | 'light';
export const LOOK_KINDS: readonly LookKind[] = ['dark', 'light'];

export type TokenName = `--d-${string}` | `--s-${string}`;
// Every --d-* the renderers read plus the desktop-only --s-* and --d-ansi-* (theme-parity.test.ts).
export type ThemePalette = Readonly<Record<TokenName, string>>;

// The seeds a look names besides its surfaces and text; HOST_TONES (src/shared/host-colors.ts) is the same list.
export const SEED_TONES = ['accent', 'success', 'warning', 'danger', 'info'] as const;
export type SeedTone = (typeof SEED_TONES)[number];
export type Tone = SeedTone | 'design';
export const TONES: readonly Tone[] = [...SEED_TONES, 'design'];

export const toneToken = (tone: Tone): TokenName => `--d-${tone}`;
export const fillToken = (tone: Tone): TokenName => `--d-${tone}-fill`;
export const onToken = (tone: Tone): TokenName => `--d-on-${tone}`;
export const toneTextToken = (tone: Tone): TokenName => `--d-${tone}-text`;
export const safetyToken = (tone: SeedTone): TokenName => `--d-safety-${tone}`;
export const safetyOnToken = (tone: SeedTone): TokenName => `--d-safety-on-${tone}`;
export const safetyTextToken = (tone: SeedTone): TokenName => `--d-safety-${tone}-text`;

export const SURFACE_TOKENS = ['--d-bg', '--d-panel', '--d-card', '--d-hover', '--d-border', '--d-border2', '--d-input', '--d-code'] as const;
export const SYNTAX_TOKENS = ['--s-kw', '--s-str', '--s-num', '--s-com', '--s-fn', '--s-type'] as const;
export const ANSI_TOKENS: readonly TokenName[] = Array.from({ length: 16 }, (_, i): TokenName => `--d-ansi-${i}`);
export const FONT_TOKENS = ['--d-font', '--d-mono', '--d-font-size', '--d-mono-size'] as const;
// A theme's style (style.ts): line spacing, corner radius and density multipliers, the chat column's maximum width, and the
// least size of a control, which a density below 1 raises to 1.5rem.
export const STYLE_TOKENS = ['--d-line-scale', '--d-radius-scale', '--d-density', '--d-chat-column', '--d-hit-min'] as const;
export const SHADOW_TOKEN = '--d-shadow';
export const OPACITY_TOKEN = '--d-opacity-disabled';
// What each window panel paints its background with: its opaque color, or that color at alpha 00 while the panel shows a
// wallpaper (wallpapers.ts), so a contrast check that ignores alpha still reads the right color. Must match PANELS in schema.ts.
type PanePanel = 'sidebar' | 'chat' | 'editor' | 'terminal' | 'titlebar';
export const PANE_TOKENS: Readonly<Record<PanePanel, TokenName>> = {
  sidebar: '--d-pane-sidebar',
  chat: '--d-pane-chat',
  editor: '--d-pane-editor',
  terminal: '--d-pane-terminal',
  titlebar: '--d-pane-titlebar',
};
// The surface each panel's pane token takes its color from: the sidebar and title bar are panel, the rest background.
export const PANE_SURFACES: Readonly<Record<PanePanel, '--d-panel' | '--d-bg'>> = {
  sidebar: '--d-panel',
  chat: '--d-bg',
  editor: '--d-bg',
  terminal: '--d-bg',
  titlebar: '--d-panel',
};
// The background alpha of bubbles, the composer, code blocks and cards over a wallpaper, 0.6 to 1; never an `opacity`.
export const SURFACE_ALPHA_TOKEN = '--d-surface-alpha';
export const WALLPAPER_TOKENS: readonly TokenName[] = [...Object.values(PANE_TOKENS), SURFACE_ALPHA_TOKEN];

// The tokens a look's Advanced table may override: every color plus the shadow; never fonts, sizes or safety tokens.
export const OVERRIDABLE_TOKENS: readonly TokenName[] = [
  ...SURFACE_TOKENS,
  '--d-text', '--d-muted', '--d-faint', '--d-faint-text',
  ...TONES.flatMap((tone) => [toneToken(tone), fillToken(tone), onToken(tone), toneTextToken(tone)]),
  '--d-accent-soft', '--d-add', '--d-del', '--d-scrim', SHADOW_TOKEN,
  ...SYNTAX_TOKENS,
  ...ANSI_TOKENS,
];

export const SAFETY_TOKENS: readonly TokenName[] = SEED_TONES.flatMap((tone) => [safetyToken(tone), safetyOnToken(tone), safetyTextToken(tone)]);

// Every token a palette carries, in no particular order.
export const PALETTE_TOKENS: readonly TokenName[] = [...FONT_TOKENS, ...STYLE_TOKENS, OPACITY_TOKEN, ...OVERRIDABLE_TOKENS, ...SAFETY_TOKENS, ...WALLPAPER_TOKENS];

const COLOR_TOKENS: ReadonlySet<string> = new Set([...OVERRIDABLE_TOKENS.filter((token) => token !== SHADOW_TOKEN), ...SAFETY_TOKENS, ...Object.values(PANE_TOKENS)]);
/** Whether a palette token's value is a color: never a font, a size, a style multiplier, the shadow or an alpha. */
export const isColorToken = (name: string): boolean => COLOR_TOKENS.has(name);

const TOKEN_NAME = /^--[ds]-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;
const LENGTH = '(?:0|-?\\d{1,3}(?:\\.\\d{1,3})?px)';
const SHADOW = new RegExp(`^${LENGTH} ${LENGTH} ${LENGTH}(?: ${LENGTH})? #[0-9a-f]{6}(?:[0-9a-f]{2})?$`);
const OPACITY = /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/;
const FONT_SIZE = /^(?:[89]|[12]\d|3[0-2])(?:\.\d{1,2})?px$/;
// A font stack: quoted family names (an apostrophe escaped) and bare one-word names or generic keywords, comma separated.
const FONT_STACK = /^(?:'(?:[\p{L}\p{N} ._&-]|\\'){1,80}'|[A-Za-z][A-Za-z0-9-]{0,31})(?:, (?:'(?:[\p{L}\p{N} ._&-]|\\'){1,80}'|[A-Za-z][A-Za-z0-9-]{0,31})){0,9}$/u;
const SCALE = /^\d(?:\.\d{1,3})?$/;
const CHAT_COLUMN = /^(?:[3-8]\d(?:\.\d{1,3})?rem|100%)$/;

export const isTokenName = (name: string): name is TokenName => TOKEN_NAME.test(name);

/** The strict format of each token's value: lowercase hex for colors; these values reach CSS text. */
export function isValidTokenValue(name: TokenName, value: string): boolean {
  if (name === '--d-font' || name === '--d-mono') return FONT_STACK.test(value);
  if (name === '--d-font-size' || name === '--d-mono-size') return FONT_SIZE.test(value);
  if (name === '--d-chat-column') return CHAT_COLUMN.test(value);
  if (name === '--d-hit-min') return value === 'auto' || value === '1.5rem';
  if ((STYLE_TOKENS as readonly string[]).includes(name)) return SCALE.test(value);
  if (name === SHADOW_TOKEN) return SHADOW.test(value);
  if (name === OPACITY_TOKEN || name === SURFACE_ALPHA_TOKEN) return OPACITY.test(value);
  return COLOR.test(value);
}
