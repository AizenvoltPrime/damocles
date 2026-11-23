// The System colors theme (docs/themes.md "The System colors theme"): this computer's colors as a built-in theme's two looks.
// Pure: main reads the OS and core takes the looks from main, so both build the same file from them.
import { BUILTIN_THEME, SYSTEM_THEME_ID } from './builtin';
import { parseHex } from './color';
import { backdropLabel, backdropTokens, checkPalette, contrastPairs, hasContrastError, kindOfBackground, type ContrastIssue } from './contrast';
import { deriveLook, deriveLookDetails } from './derive';
import { themeErrorEnglish, validateTheme, type Look, type LookColors, type ThemeFile } from './schema';
import { lookFromRoles, opaqueOver, type PaletteRoles } from './schemes/palette';
import { fillToken, isValidTokenValue, OVERRIDABLE_TOKENS, SEED_TONES, type LookKind, type TokenName } from './tokens';

// English, as every theme name is data; the views show their own text for SYSTEM_THEME_ID.
export const SYSTEM_THEME_NAME = 'System colors';
const SYSTEM_THEME_DESCRIPTION = "Follows this computer's colors";

/** What the computer gives: its accent, and the palette of each kind a desktop source covers. Colors are `#rrggbb` or `#rrggbbaa`. */
export interface SystemColors {
  readonly accent?: string;
  readonly palettes?: Partial<Record<LookKind, PaletteRoles>>;
}

// a System colors look holds seeds and token overrides only, as the core protocol carries it
export type SystemLook = Pick<Look, 'colors' | 'tokens'>;

export interface SystemLooks {
  readonly dark: SystemLook;
  readonly light: SystemLook;
}

export type SystemThemeFile = ThemeFile & { readonly looks: SystemLooks };

type Tokens = Partial<Record<TokenName, string>>;

/** A kind whose look does not show the palette the computer gives for it: `otherKind` keeps only its tones, `contrast` none of it. */
export interface SystemFallback {
  readonly kind: LookKind;
  readonly reason: 'otherKind' | 'contrast';
}

export interface SystemThemeDetails {
  readonly theme: SystemThemeFile;
  readonly fallbacks: readonly SystemFallback[];
}

const OVERRIDABLE: ReadonlySet<string> = new Set(OVERRIDABLE_TOKENS);
const damoclesSeeds = (kind: LookKind): LookColors => BUILTIN_THEME.looks[kind]!.colors;

/** `colors` with each seed fill where the derivation puts it at NON_TEXT on bg and panel with its label at AA, which deriveLook then keeps. */
function fitted(colors: LookColors, kind: LookKind): LookColors {
  const { derived } = deriveLookDetails(colors, kind, undefined, { nonTextFills: true });
  return { ...colors, ...Object.fromEntries(SEED_TONES.map((tone) => [tone, derived[fillToken(tone)]!])) };
}

// Trusted UI keeps only a palette with no contrast error (trustedPalette), and System colors keeps every fill at 3:1 too.
function sound(colors: LookColors, kind: LookKind): boolean {
  const palette = deriveLook(colors, kind);
  return !hasContrastError(palette, kind) && checkPalette(palette, kind).every((issue) => issue.rule !== 'fill');
}

// The tokens each contrast pair reads, by the rule, text and backdrop label its issue carries.
function namedBy(kind: LookKind): (issue: ContrastIssue) => readonly string[] {
  const pairs = new Map(contrastPairs(kind).map((pair) => [`${pair.rule}\n${pair.fg}\n${backdropLabel(pair.bg)}`, [pair.fg, ...backdropTokens(pair.bg)]]));
  return (issue) => pairs.get(`${issue.rule}\n${issue.fg}\n${issue.bg}`) ?? [issue.fg];
}

/** The overrides no contrast issue of the look names: the derivation holds the seeds at AA, and an override is exact. */
function keptOverrides(colors: LookColors, kind: LookKind, tokens: Tokens): Tokens {
  let kept = Object.entries(tokens).filter(([token, value]) => OVERRIDABLE.has(token) && value !== undefined && isValidTokenValue(token as TokenName, value));
  if (kept.length === 0) return {};
  const names = namedBy(kind);
  for (;;) {
    const named = new Set(checkPalette(deriveLook(colors, kind, Object.fromEntries(kept)), kind).flatMap(names));
    const next = kept.filter(([token]) => !named.has(token));
    if (next.length === kept.length) return Object.fromEntries(kept);
    kept = next;
  }
}

function lookOf(kind: LookKind, { accent, palettes }: SystemColors): { readonly look: SystemLook; readonly fallbacks: readonly SystemFallback[] } {
  const damocles = damoclesSeeds(kind);
  const osAccent = accent === undefined ? undefined : opaqueOver(parseHex(accent), damocles.background);
  const base: LookColors = osAccent === undefined ? damocles : { ...damocles, accent: osAccent };
  const defaults = fitted(base, kind);
  const roles = palettes?.[kind];
  if (roles === undefined) return { look: { colors: defaults }, fallbacks: [] };
  // the OS accent stands in for a palette accent before it is painted over the palette's background
  const made = lookFromRoles(accent === undefined ? roles : { ...roles, seeds: { accent, ...roles.seeds } }, base).look;
  // a palette whose background is of the other kind gives this look its tones only
  const otherKind = kindOfBackground(made.colors.background) !== kind;
  const own = fitted(otherKind ? { ...made.colors, background: base.background, panel: base.panel, text: base.text } : made.colors, kind);
  const fallbacks: SystemFallback[] = otherKind ? [{ kind, reason: 'otherKind' }] : [];
  if (!sound(own, kind)) return { look: { colors: defaults }, fallbacks: [...fallbacks, { kind, reason: 'contrast' }] };
  const tokens = otherKind ? {} : keptOverrides(own, kind, made.tokens ?? {});
  return { look: Object.keys(tokens).length > 0 ? { colors: own, tokens } : { colors: own }, fallbacks };
}

/** The System colors theme file of `looks`. */
export const systemThemeOf = (looks: SystemLooks): SystemThemeFile => ({
  schemaVersion: 1,
  id: SYSTEM_THEME_ID,
  name: SYSTEM_THEME_NAME,
  description: SYSTEM_THEME_DESCRIPTION,
  looks,
});

/** systemThemeOf(looks) once validateTheme passes it as the built-in, else systemTheme({}), with the reason told to `log`. */
export function checkedSystemTheme(looks: SystemLooks, log?: (line: string) => void): ThemeFile {
  const result = validateTheme(systemThemeOf(looks), { builtin: true, folder: SYSTEM_THEME_ID });
  if (result.ok) return result.theme;
  log?.(`[themes] the System colors are not a valid theme, so they are Damocles' seeds without its pinned token overrides: ${themeErrorEnglish(result.errors[0])}`);
  return systemTheme({});
}

/** systemTheme's file, and the kinds whose palette it does not show as given. */
export function systemThemeDetails(colors: SystemColors): SystemThemeDetails {
  const [dark, light] = [lookOf('dark', colors), lookOf('light', colors)];
  return { theme: systemThemeOf({ dark: dark.look, light: light.look }), fallbacks: [...dark.fallbacks, ...light.fallbacks] };
}

/**
 * System colors for what the computer gives. Each look takes its seeds from the palette of its kind, else Damocles' own with
 * the computer's accent, and never carries BUILTIN_THEME's pinned overrides. Its palette has no contrast error and every fill
 * reaches 3:1 on bg and panel, whatever the input.
 */
export function systemTheme(colors: SystemColors): SystemThemeFile {
  return systemThemeDetails(colors).theme;
}
