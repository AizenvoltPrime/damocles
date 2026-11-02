// LANG detection adapted from VS Code's shouldSetLangEnvVariable and getLangEnvVariable
// (src/vs/workbench/contrib/terminal/common/terminalEnvironment.ts, MIT), as terminal.integrated.detectLocale `auto` does.
import { hostEnvironment } from '../../local-services/host-environment';
import { SCRIPT_STATE_ENV } from './shell-integration-injection';

// The damocles command's socket in a target's user terminal; never in agent shells, hooks or MCP servers.
export const CLI_HOOK_ENV = 'DAMOCLES_CLI_HOOK';

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
  // only the terminal's own CLI socket may be named, which cliTerminalEnvironment adds for a target's user terminal; Windows
  // names variables in any case
  for (const key of Object.keys(result)) if (key.toUpperCase() === CLI_HOOK_ENV) delete result[key];
  if (result['ZDOTDIR'] === options.zshDotDir) delete result['ZDOTDIR'];
  if (!isUtf8Lang(result['LANG'])) result['LANG'] = langFromLocale(options.locale);
  return { ...result, COLORTERM: 'truecolor' };
}

// One string value of a Windows environment key in the registry.
export interface EnvironmentValue {
  readonly name: string;
  readonly type: 'REG_SZ' | 'REG_EXPAND_SZ';
  readonly data: string;
}

const PATH_NAME = 'PATH';

/**
 * env with the machine's environment values, then the user's, over it, as Windows builds a new logon's environment and Windows
 * Terminal rebuilds one for each new tab (reloadEnvironmentVariables): each key's REG_SZ values first, then its REG_EXPAND_SZ
 * values with %NAME% expanded against what is set so far (an unknown name stays as written), and Path the machine's with the
 * user's appended, both expanded. Windows names variables in any case, so a value replaces the variable of its name in any case.
 */
export function registryEnvironment(env: Readonly<Record<string, string | undefined>>, machine: readonly EnvironmentValue[], user: readonly EnvironmentValue[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) result[key] = value;
  const keyOf = (name: string): string | undefined => Object.keys(result).find((key) => key.toUpperCase() === name.toUpperCase());
  const set = (name: string, value: string): void => {
    const existing = keyOf(name);
    result[existing ?? name] = value;
  };
  const expand = (value: string): string => value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = keyOf(name);
    return key === undefined ? whole : result[key]!;
  });
  let machinePath: string | undefined;
  for (const [values, isUser] of [[machine, false], [user, true]] as const) {
    for (const type of ['REG_SZ', 'REG_EXPAND_SZ'] as const) {
      for (const value of values) {
        if (value.type !== type) continue;
        const isPath = value.name.toUpperCase() === PATH_NAME;
        const text = type === 'REG_EXPAND_SZ' || isPath ? expand(value.data) : value.data;
        if (!isPath) set(value.name, text);
        else if (!isUser) set(value.name, (machinePath = text));
        else set(value.name, machinePath === undefined || machinePath === '' ? text : `${machinePath}${machinePath.endsWith(';') ? '' : ';'}${text}`);
      }
    }
  }
  return result;
}

export interface CliTerminalOptions {
  // the terminal's CLI socket (a socket path, or a named pipe on Windows)
  readonly hook: string;
  // the server package's bin/remote-cli folder, put first on PATH
  readonly remoteCliDir: string;
  // the server package's bin/helpers/browser.sh, or browser.exe on Windows
  readonly browser: string;
  readonly platform: NodeJS.Platform;
}

/**
 * A target's user terminal's environment with the damocles command: its socket in DAMOCLES_CLI_HOOK, bin/remote-cli first on
 * PATH, and BROWSER sending URLs to this computer, as VS Code's server sets PATH and BROWSER. Windows names a variable in any
 * case, so there each replaces the one it finds whatever its case.
 */
export function cliTerminalEnvironment(env: Readonly<Record<string, string>>, options: CliTerminalOptions): Record<string, string> {
  const result = { ...env };
  const keyOf = (name: string, fallback: string): string => (options.platform === 'win32' ? (Object.keys(result).find((key) => key.toUpperCase() === name) ?? fallback) : name);
  const pathKey = keyOf('PATH', 'Path');
  const delimiter = options.platform === 'win32' ? ';' : ':';
  const current = result[pathKey];
  result[pathKey] = current ? `${options.remoteCliDir}${delimiter}${current}` : options.remoteCliDir;
  result[keyOf(CLI_HOOK_ENV, CLI_HOOK_ENV)] = options.hook;
  result[keyOf('BROWSER', 'BROWSER')] = options.browser;
  return result;
}
