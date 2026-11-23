// The app's own command line flags. A damocles:// link is untrusted text the OS appends to the registered command, so every
// flag is read only before the end-of-options marker that command puts ahead of the link (docs/invariants.md "Desktop
// packaging and updates").
import { COMMAND_LINE_SWITCH } from '../cli/cli-protocol';
import { SAFE_THEME_FLAG } from './themes/appearance';
import { isThemeLinkArg } from '../../shared/themes/theme-links';

// Must equal the argument registerThemeLinkScheme passes and the command build/win/installer.nsh compares.
export const END_OF_OPTIONS = '--';

/** The arguments a flag may be read from: those before the first `--`. */
export function optionArgs(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf(END_OF_OPTIONS);
  return end === -1 ? argv : argv.slice(0, end);
}

/** The arguments after the first `--`, where the registered command puts a link; undefined without the marker. */
export function operandArgs(argv: readonly string[]): readonly string[] | undefined {
  const end = argv.indexOf(END_OF_OPTIONS);
  return end === -1 ? undefined : argv.slice(end + 1);
}

/** `<flag> <value>` or `<flag>=<value>`. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const options = optionArgs(argv);
  for (let index = 0; index < options.length; index++) {
    const arg = options[index]!;
    if (arg === flag) return options[index + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/** `--user-data-dir <path>` or `--user-data-dir=<path>`. */
export function parseUserDataDir(argv: readonly string[]): string | undefined {
  return flagValue(argv, '--user-data-dir');
}

/** `--crash-reporter-directory <folder>`, VS Code's flag: the existing folder Electron writes every process's minidumps to, uploading none. */
export function parseCrashReporterDirectory(argv: readonly string[]): string | undefined {
  return flagValue(argv, '--crash-reporter-directory');
}

const CLI_PATH_FLAG = '--cli-path';

/** `--cli-path add|remove`, which the Windows installer and uninstaller run; invalid for any other value, undefined without one. */
export function parseCliPathAction(argv: readonly string[]): 'add' | 'remove' | 'invalid' | undefined {
  const options = optionArgs(argv);
  const at = options.indexOf(CLI_PATH_FLAG);
  if (at === -1) return undefined;
  const action = options[at + 1];
  return action === 'add' || action === 'remove' ? action : 'invalid';
}

/** Whether this run starts with the default theme (`--damocles-safe-theme`). */
export function isSafeThemeLaunch(argv: readonly string[]): boolean {
  return optionArgs(argv).includes(SAFE_THEME_FLAG);
}

/**
 * The arguments a relaunch passes on: the launch's own, without those that act once. A link, a damocles command's request and
 * the safe start flag would each act again in the next process.
 */
export function relaunchArgs(argv: readonly string[]): string[] {
  return optionArgs(argv).slice(1).filter((arg) => arg !== SAFE_THEME_FLAG && !arg.startsWith(`${COMMAND_LINE_SWITCH}=`) && !isThemeLinkArg(arg));
}

export interface LinkSchemeRun {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly argv: readonly string[];
  // an uninstaller sits beside the executable, which only the installer puts there; read only for a packaged Windows run
  readonly installed: () => Promise<boolean>;
}

/**
 * Whether this run registers the damocles:// scheme for its own executable: only the installed Windows app on its own user
 * data folder. An unpacked build and a run with `--user-data-dir` never take the scheme from the installed app.
 */
export async function registersLinkScheme(run: LinkSchemeRun): Promise<boolean> {
  return run.platform === 'win32' && run.packaged && parseUserDataDir(run.argv) === undefined && (await run.installed());
}
