import { isTokenName, isValidTokenValue, type LookKind, type ThemePalette } from './tokens';

/** The rule a palette paints; throws on a token name or value outside its strict format, since these reach CSS text. */
export function paletteCss(palette: ThemePalette, kind: LookKind, selector: ':root' | '[data-trusted]' = ':root'): string {
  const declarations = Object.entries(palette).map(([name, value]) => {
    if (!isTokenName(name) || !isValidTokenValue(name, value)) throw new Error(`${name}: ${JSON.stringify(value)} is not a valid token value`);
    return `${name}: ${value};`;
  });
  return `${selector} { color-scheme: ${kind === 'dark' ? 'dark' : 'light'}; ${declarations.join(' ')} }`;
}
