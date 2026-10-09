// LANG detection adapted from VS Code's shouldSetLangEnvVariable and getLangEnvVariable
// (src/vs/workbench/contrib/terminal/common/terminalEnvironment.ts, MIT), as terminal.integrated.detectLocale `auto` does.
import { hostEnvironment } from '../formatting/formatter-process';
import { SCRIPT_STATE_ENV } from './shell-integration-injection';

export interface TerminalEnvironmentOptions {
  // the app's locale (app.getLocale()), which LANG follows when the inherited one is missing or not UTF-8
  readonly locale: string;
  // zsh's ZDOTDIR for integrated shells; an inherited ZDOTDIR naming it came from one of the app's own terminals
  readonly zshDotDir: string;
}

// The region VS Code picks for a locale that names only its language; from `locale -a` on macOS.
const LANGUAGE_REGIONS: Readonly<Record<string, string>> = {
  af: 'ZA', am: 'ET', be: 'BY', bg: 'BG', ca: 'ES', cs: 'CZ', da: 'DK', de: 'DE', el: 'GR', en: 'US', es: 'ES', et: 'EE',
  eu: 'ES', fi: 'FI', fr: 'FR', he: 'IL', hr: 'HR', hu: 'HU', hy: 'AM', is: 'IS', it: 'IT', ja: 'JP', kk: 'KZ', ko: 'KR',
  lt: 'LT', nl: 'NL', no: 'NO', pl: 'PL', pt: 'BR', ro: 'RO', ru: 'RU', sk: 'SK', sl: 'SI', sr: 'YU', sv: 'SE', tr: 'TR',
  uk: 'UA', zh: 'CN',
};

/** A UTF-8 LANG value for a BCP 47 locale such as `en-GB` or `el`; en_US.UTF-8 when the locale is unknown. */
export function langFromLocale(locale: string): string {
  const parts = locale ? locale.split('-') : [];
  if (parts.length === 0) return 'en_US.UTF-8';
  if (parts.length === 1) {
    const region = Object.hasOwn(LANGUAGE_REGIONS, parts[0]!) ? LANGUAGE_REGIONS[parts[0]!] : undefined;
    if (region !== undefined) parts.push(region);
  } else {
    parts[1] = parts[1]!.toUpperCase();
  }
  return `${parts.join('_')}.UTF-8`;
}

const isUtf8Lang = (lang: string | undefined): boolean => !!lang && (/\.UTF-8$/.test(lang) || /\.utf8$/.test(lang) || /\.euc.+/.test(lang));

/**
 * A terminal's environment: the login environment main merged at startup (shell-env.ts) without Electron's own ELECTRON_*
 * variables, which would turn a node or electron the user runs into Electron's mode, and without the integration scripts'
 * state. A Damocles opened from the macOS Dock or Finder inherits no LANG, so a missing or non-UTF-8 one follows the app
 * locale. xterm renders 24-bit color.
 */
export function terminalEnvironment(env: NodeJS.ProcessEnv, options: TerminalEnvironmentOptions): Record<string, string> {
  const result = hostEnvironment(env);
  for (const key of SCRIPT_STATE_ENV) delete result[key];
  if (result['ZDOTDIR'] === options.zshDotDir) delete result['ZDOTDIR'];
  if (!isUtf8Lang(result['LANG'])) result['LANG'] = langFromLocale(options.locale);
  return { ...result, COLORTERM: 'truecolor' };
}
