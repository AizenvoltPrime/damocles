import type { ITerminalOptions } from '@xterm/xterm';
import type { ShellPlatform } from '../../preload/shell-channels';
import type { TerminalSettings } from '../../preload/terminal-channels';

// var(), env() and attr() make any value parse, and a CSS-wide keyword parses as a font-family; neither names a font, and
// document.fonts.load rejects either.
const SUBSTITUTION = /\b(?:var|env|attr)\s*\(/i;

/** Whether `family` is a font list xterm can measure: it parses within the font shorthand and substitutes nothing. */
export function isFontList(family: string, supports: (property: string, value: string) => boolean): boolean {
  return !SUBSTITUTION.test(family) && supports('font', `1px ${family}`);
}

export type LiveOptions = Required<Pick<ITerminalOptions, 'fontFamily' | 'fontSize' | 'lineHeight' | 'scrollback' | 'cursorStyle' | 'cursorBlink' | 'macOptionIsMeta'>>;

/**
 * The xterm options Settings › Terminal sets, which apply to open terminals at once: an empty font family, or one CSS cannot
 * parse (`validFamily`), is the app's mono font (`mono`, --d-mono); `fontSize` is already in px at the root font size, and
 * Option is Meta only on macOS.
 */
export function liveOptions(settings: TerminalSettings, platform: ShellPlatform, mono: string, fontSize: number, validFamily: (family: string) => boolean): LiveOptions {
  const family = settings.fontFamily.trim();
  return {
    fontFamily: family !== '' && validFamily(family) ? family : mono,
    fontSize,
    lineHeight: settings.lineHeight,
    scrollback: settings.scrollback,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlinking,
    macOptionIsMeta: platform === 'darwin' && settings.macOptionIsMeta,
  };
}
