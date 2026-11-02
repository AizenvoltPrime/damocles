// The damocles command's arguments, shared by dist/cli.js (this computer) and dist/cli-remote.js (a target's terminals).
import type { CliOpenItem } from './cli-protocol';

export type CliSide = 'local' | 'remote';

export type ArgError =
  | { readonly kind: 'unknownOption'; readonly option: string }
  | { readonly kind: 'needsValue'; readonly option: string }
  | { readonly kind: 'twice'; readonly option: string }
  | { readonly kind: 'diffNeedsTwo' }
  | { readonly kind: 'diffWithPaths' }
  | { readonly kind: 'remoteHere' }
  | { readonly kind: 'remoteForm'; readonly value: string }
  | { readonly kind: 'remoteRelative'; readonly path: string }
  | { readonly kind: 'openExternalAlone' };

export type ParsedArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'error'; readonly error: ArgError }
  // paths empty: this computer starts or shows the app, passing it switches (unknown --options); a target's terminal prints the usage
  | { readonly kind: 'open'; readonly paths: readonly string[]; readonly wait: boolean; readonly remote?: string; readonly userDataDir?: string; readonly switches?: readonly string[] }
  | { readonly kind: 'diff'; readonly left: string; readonly right: string; readonly wait: boolean; readonly remote?: string; readonly userDataDir?: string }
  | { readonly kind: 'openExternal'; readonly url: string };

// wsl+<distro>, ssh+<host name, ssh alias or user@host[:port]>, or the loopback daemon (dev and e2e only)
const REMOTE_FORM = /^(?:(?:wsl|ssh)\+\S.*|loopback)$/;
const POSIX_ABSOLUTE = /^\//;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
// a canonical positive number, so a split path joins back to exactly what was typed
const POSITION = /^(.+?):([1-9]\d{0,8})(?::([1-9]\d{0,8}))?$/;
// the command's options, which never reach the app as a switch, even in a --name=value form the command does not read
const OWN_OPTIONS: ReadonlySet<string> = new Set(['--help', '--version', '--wait', '--diff', '--remote', '--open-external']);

/** Whether a --remote value has one of its forms; main checks it again, since any program can start the app with one. */
export const isRemoteForm = (value: string): boolean => REMOTE_FORM.test(value);

/** Whether a path is absolute in either target flavor, which --remote paths must be. */
export const isAbsoluteOnSomeHost = (value: string): boolean => POSIX_ABSOLUTE.test(value) || WINDOWS_ABSOLUTE.test(value);

/**
 * `file:line[:column]` split by its form alone; main reads it so only when the unsplit path does not exist, and joinPosition
 * gives that path back.
 */
export function openItem(path: string): CliOpenItem {
  const match = POSITION.exec(path);
  if (!match) return { path };
  return { path: match[1]!, line: Number(match[2]), ...(match[3] !== undefined ? { column: Number(match[3]) } : {}) };
}

/** The path as typed, before openItem split it. */
export function joinPosition(item: CliOpenItem): string {
  if (item.line === undefined) return item.path;
  return `${item.path}:${item.line}${item.column !== undefined ? `:${item.column}` : ''}`;
}

/**
 * The command line after the program: -h/--help, -v/--version, -w/--wait, -d/--diff <a> <b>, --remote <form> and
 * --user-data-dir <path> (or =<path>) on this computer, --open-external <url> on a target (its BROWSER helper), and `--` before
 * paths that start with a dash. On this computer a command with no path, --diff or --remote passes any other --option to the app
 * as a switch for Electron or Chromium, as VS Code's CLI does.
 */
export function parseArgs(argv: readonly string[], side: CliSide): ParsedArgs {
  const paths: string[] = [];
  let wait = false;
  let diff = false;
  let remote: string | undefined;
  let userDataDir: string | undefined;
  let openExternal: string | undefined;
  const switches: string[] = [];
  let help = false;
  let version = false;
  let options = true;
  const error = (value: ArgError): ParsedArgs => ({ kind: 'error', error: value });
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!options || arg === '-' || !arg.startsWith('-')) {
      paths.push(arg);
      continue;
    }
    if (arg === '--') {
      options = false;
      continue;
    }
    const value = (): string | undefined => {
      const next = argv[index + 1];
      if (next === undefined) return undefined;
      index++;
      return next;
    };
    const userDataDirValue = arg.startsWith('--user-data-dir=') ? arg.slice('--user-data-dir='.length) : undefined;
    switch (userDataDirValue === undefined ? arg : '--user-data-dir') {
      case '-h':
      case '--help':
        help = true;
        break;
      case '-v':
      case '--version':
        version = true;
        break;
      case '-w':
      case '--wait':
        wait = true;
        break;
      case '-d':
      case '--diff':
        diff = true;
        break;
      case '--remote': {
        if (side === 'remote') return error({ kind: 'remoteHere' });
        if (remote !== undefined) return error({ kind: 'twice', option: arg });
        const form = value();
        if (form === undefined) return error({ kind: 'needsValue', option: arg });
        if (!REMOTE_FORM.test(form)) return error({ kind: 'remoteForm', value: form });
        remote = form;
        break;
      }
      case '--user-data-dir': {
        if (side === 'remote') return error({ kind: 'unknownOption', option: arg });
        if (userDataDir !== undefined) return error({ kind: 'twice', option: '--user-data-dir' });
        userDataDir = userDataDirValue ?? value();
        if (!userDataDir) return error({ kind: 'needsValue', option: '--user-data-dir' });
        break;
      }
      case '--open-external': {
        if (side === 'local') return error({ kind: 'unknownOption', option: arg });
        openExternal = value();
        if (openExternal === undefined) return error({ kind: 'needsValue', option: arg });
        break;
      }
      default:
        if (side === 'remote' || !arg.startsWith('--') || OWN_OPTIONS.has(arg.split('=')[0]!)) return error({ kind: 'unknownOption', option: arg });
        switches.push(arg);
    }
  }
  if (help) return { kind: 'help' };
  if (version) return { kind: 'version' };
  if (openExternal !== undefined) {
    if (paths.length > 0 || wait || diff) return error({ kind: 'openExternalAlone' });
    return { kind: 'openExternal', url: openExternal };
  }
  // a request's own options are all known, so an unknown one there is a mistake rather than the app's switch
  if (switches.length > 0 && (paths.length > 0 || diff || remote !== undefined)) return error({ kind: 'unknownOption', option: switches[0]! });
  if (remote !== undefined) {
    const relative = paths.find((candidate) => !isAbsoluteOnSomeHost(candidate));
    if (relative !== undefined) return error({ kind: 'remoteRelative', path: relative });
  }
  const shared = { wait, ...(remote !== undefined ? { remote } : {}), ...(userDataDir !== undefined ? { userDataDir } : {}) };
  if (diff) {
    if (paths.length !== 2) return error({ kind: paths.length > 2 ? 'diffWithPaths' : 'diffNeedsTwo' });
    return { kind: 'diff', left: paths[0]!, right: paths[1]!, ...shared };
  }
  return { kind: 'open', paths, ...shared, ...(switches.length > 0 ? { switches } : {}) };
}

type Translate = (message: string, ...args: string[]) => string;

/** The warning for a switch passed to the app, as VS Code's CLI warns of one. */
export function switchWarningText(option: string, t: Translate): string {
  return t('damocles: {0} is not an option of the command, so it is passed to the app as it is.', option);
}

/** The usage, in the language t renders. */
export function usageText(t: Translate): string {
  return t('Usage: damocles [options] [paths...]\n\n  damocles .                 Open this folder\n  damocles file[:line[:col]] Open a file\n  damocles --diff a b        Compare two files\n  damocles --wait file       Wait until the tab closes\n  damocles --remote ssh+prod-1 /srv/app');
}

/** One line saying what is wrong with the arguments. */
export function argErrorText(error: ArgError, t: Translate): string {
  switch (error.kind) {
    case 'unknownOption':
      return t('damocles: unknown option {0}. Run damocles --help for the options.', error.option);
    case 'needsValue':
      return t('damocles: {0} needs a value.', error.option);
    case 'twice':
      return t('damocles: {0} is given more than once.', error.option);
    case 'diffNeedsTwo':
    case 'diffWithPaths':
      return t('damocles: --diff compares exactly two files.');
    case 'remoteHere':
      return t('damocles: --remote works only on this computer.');
    case 'remoteForm':
      return t('damocles: {0} names no host. Use wsl+<distro>, ssh+<host> or loopback.', error.value);
    case 'remoteRelative':
      return t('damocles: {0} is not an absolute path. With --remote, name paths as they are on the host.', error.path);
    case 'openExternalAlone':
      return t('damocles: --open-external takes one address and nothing else.');
  }
}
