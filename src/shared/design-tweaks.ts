// Tweaks (PD-13; docs/invariants.md "Design mode"): the limits core's DeclareTweaks and main's insertCSS both hold.

/** A token name as tweaks and the preview's insertCSS take it: a custom property, never any other text. */
export const TWEAK_TOKEN_NAME: RegExp = /^--[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
export const TWEAK_ID: RegExp = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const MIN_TWEAK_CONTROLS = 2;
export const MAX_TWEAK_CONTROLS = 5;
export const MIN_TWEAK_STOPS = 2;
export const MAX_TWEAK_STOPS = 8;
export const MAX_TWEAK_LABEL_CHARS = 80;
export const MAX_TWEAK_VALUE_CHARS = 200;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_FUNCTION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([0-9a-zA-Z.%\s,/+-]{1,80}\)$/;

/** A literal CSS color a swatch can show: hex or a color function of numbers, never a var(), url() or keyword. */
export function isTweakColor(value: string): boolean {
  return HEX_COLOR.test(value) || COLOR_FUNCTION.test(value);
}

/** The one sheet a tweak inserts: both names must pass TWEAK_TOKEN_NAME, which the caller checks first. */
export function tweakCss(property: string, token: string): string {
  if (!TWEAK_TOKEN_NAME.test(property) || !TWEAK_TOKEN_NAME.test(token)) throw new Error('A tweak names only tokens');
  // inserted as an author sheet, whose !important outranks the page's own :root declaration of the token
  return `:root { ${property}: var(${token}) !important; }`;
}
