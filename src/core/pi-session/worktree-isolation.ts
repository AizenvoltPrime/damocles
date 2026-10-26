// D62: a worktree chat stays inside its worktree. The gate blocks, in every mode, writes and working directories in the
// project folder or another worktree of the project, and git commands aimed there. It reads paths and command text, so it is
// a guard against wrong-copy mistakes, not a sandbox (docs/worktree-isolation.md).
import * as path from 'node:path';
import { canonicalPath, rememberedPathQueries, spelledPath } from '../canonical-path';
import { TOOL_BASH, TOOL_POWERSHELL, WRITE_TOOLS } from '../../shared/tool-names';
import { folderContains } from '../worktrees/records';
import { COMPUTED_TEXT, DECLARATION_BUILTINS, MAX_COMMAND_LENGTH, parseShellStructure, type ShellLoop, type ShellPart, type ShellSegment, type ShellStructure } from './readonly-shell';
import { resolveToCwd } from './tools/search-tools';
import { pathCombine, posixBasename, posixDirname, psJoinPath, psSplitPath } from './path-functions';
import { CMD_DELIMITER, CMD_SPACE, cmdCommands, cmdSegments, cmdSwitches, cmdTokens, parseCmdLine, type CmdBlocked, type CmdCommand, type CmdLine, type CmdSegment, type CmdStart, type CmdVariable } from './cmd-structure';
import { allRead, type LoopRange, PS_ALIAS, PS_ASSIGNMENT_OPERATOR, PS_COMBINE, PS_COMMAND_DRIVE, PS_CREATE_CALL, PS_DASHES, PS_DEFAULT_PARAMETERS, PS_ENV_MENTION, PS_FRESH_ENVIRONMENT, PS_IEX_PARAMETERS, PS_IMPORT_MODULE, PS_INVOKE_METHOD, PS_ITEM_PARAMETERS, PS_ITEM_TRANSFER, PS_ITEM_WRITE, PS_JOB_PARAMETERS, PS_JOIN_PARAMETERS, PS_JUMPS, PS_LINK_CALL, PS_LOCATION, PS_LOCATION_PARAMETERS, PS_NATIVE_PASSING, PS_NEW_DRIVE, PS_NEW_ITEM_PARAMETERS, PS_PROCESS_CLASS, PS_QUOTED_TOKEN, PS_REDIRECTION, PS_RUNS_TEXT, PS_SESSION_LOCATION, PS_SET_ENVIRONMENT, PS_SET_ENVIRONMENT_NAME, PS_SPLAT, PS_SPLIT_PARAMETERS, PS_START_JOB, PS_START_PARAMETERS, PS_START_PROCESS, PS_TEE, PS_TRAP, PS_VARIABLE_CMDLETS, PS_VARIABLE_TOKEN, PS_WILDCARD, psBind, type PsBound, psCommandLines, psCommandTokens, psExpression, type PsFunction, psLinkKinds, psOperand, psOutVariable, type PsParameterKind, type PsPart, type PsRange, psReference, type PsSegment, psSiteKey, type PsText, psTextScan, psUnescape, psValue, psVariable, scanPowershell, siteKey, type TextScan, worded, type Worded } from './ps-structure';

/** A.5's reason; the gate adds the working folder. */
export const WORKTREE_ISOLATION_REASON = 'This chat works in its worktree. Edits and commands aimed at the project folder are blocked in every mode.';

export interface WorktreeIsolation {
  /** The chat's working folder; tools resolve relative paths and start shells here. */
  readonly workingFolder: string;
  readonly projectPath: string;
  /** The project's repository top level; a git target there acts on the project folder's checkout. */
  readonly repositoryRoot: string;
  /** The other live worktrees of the project. */
  readonly otherWorktrees: readonly string[];
  readonly homeDir: string;
  /** pi's shell command prefix, which its bash tool runs before every command, joined by a newline. */
  readonly commandPrefix?: string;
  /** pi's `shellPath` setting, the shell its bash tool runs; absent for the default bash. */
  readonly shellPath?: string;
  /**
   * The environment both shell tools start their shell with (docs/worktree-isolation.md "Starting environment"); a name
   * whose value is undefined gets one the tool sets per call, which reads as computed. It may hold secrets, so nothing
   * logs or quotes it.
   */
  readonly environment: Readonly<Record<string, string | undefined>>;
}

const PROJECT_FOLDER = 'the project folder';
const OTHER_WORKTREE = 'another worktree of the project';
const PROJECT_REPOSITORY = "the project's repository";

interface Area {
  readonly name: string;
  readonly roots: readonly string[];
}

/**
 * A shell path as Windows sees it: `~` in `homeDir`, and the `/c/...`, `/cygdrive/c/...` and `/mnt/c/...` drive forms of
 * Git Bash and WSL. Without `homeDir`, `~` is a folder name, as it is in a path bash already expanded.
 */
function shellPathText(text: string, homeDir: string | undefined, platform: NodeJS.Platform): string {
  let p = text;
  if (homeDir !== undefined && (p === '~' || p.startsWith('~/') || p.startsWith('~\\'))) p = pathFor(platform).join(homeDir, p.slice(1));
  if (platform === 'win32') {
    const drive = /^\/(?:cygdrive\/|mnt\/)?([A-Za-z])(?:\/|$)(.*)$/.exec(p);
    if (drive) p = `${drive[1]!.toUpperCase()}:\\${drive[2]!.replace(/\//g, '\\')}`;
  }
  return p;
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** A shell path resolved against `cwd` with `..` taken lexically, as `cd` without -P does. */
export function nativeShellPath(text: string, cwd: string, homeDir: string | undefined, platform: NodeJS.Platform = process.platform): string {
  return pathFor(platform).resolve(cwd, shellPathText(text, homeDir, platform));
}

function reason(iso: WorktreeIsolation, detail: string): string {
  return `${WORKTREE_ISOLATION_REASON} ${detail} Work in ${iso.workingFolder} instead.`;
}

/**
 * Each argument as written, which a reason names instead of a value read from it; an element is undefined where the
 * word came from text the command built, and a reason then names no word.
 */
type Spelled = ReadonlyArray<string | undefined>;

/** Argument `k` as written: from `spelled` when given, else the word, which is then as written. */
function spelling(args: ReadonlyArray<string | undefined>, spelled: Spelled | undefined, k: number): string | undefined {
  return spelled === undefined ? args[k] : spelled[k];
}

function inArea(spelled: string | undefined, area: string): string | Worded {
  return worded(spelled, (word) => `${word} is in ${area}.`, `A path the command builds is in ${area}.`);
}

function pointed(subject: string, target: string | undefined, area: string): string | Worded {
  return worded(target, (word) => `${subject} is pointed at ${word}, in ${area}.`, `${subject} is pointed at ${area}.`);
}

/** The block reason for a call of the chat, its subagents or team, or undefined when isolation lets it through. */
export function worktreeIsolationBlock(toolName: string, input: Record<string, unknown>, iso: WorktreeIsolation): string | undefined {
  if (WRITE_TOOLS.has(toolName)) {
    const target = input['file_path'] ?? input['path'];
    if (typeof target !== 'string' || target === '') return undefined;
    // Resolved as the tools resolve it: `@`, `~`, `file://` and Git Bash drive forms included.
    const area = new IsolationRun(iso).landsEdit(resolveToCwd(target, iso.workingFolder));
    return area === undefined ? undefined : reason(iso, `${target} is in ${area}.`);
  }
  if (toolName !== TOOL_BASH && toolName !== TOOL_POWERSHELL) return undefined;
  const command = typeof input['command'] === 'string' ? input['command'] : undefined;
  if (command === undefined) return undefined;
  if (toolName === TOOL_POWERSHELL) {
    if (command.length > MAX_COMMAND_LENGTH) return tooLong(iso, false);
    const run = new IsolationRun(iso, command);
    return run.check(() => run.powershell(command, run.initialState('powershell')));
  }
  const shell = toolShell(iso.shellPath);
  if (shell === undefined) {
    return reason(iso, `The Bash tool runs ${commandName(iso.shellPath!)}, whose commands this check cannot read. Use the PowerShell tool, or set shellPath to bash.`);
  }
  // pi's bash tool runs `${commandPrefix}\n${command}` when the prefix is set.
  const script = iso.commandPrefix ? `${iso.commandPrefix}\n${command}` : command;
  if (script.length > MAX_COMMAND_LENGTH) return tooLong(iso, Boolean(iso.commandPrefix));
  const structure = parseShellStructure(script);
  const run = new IsolationRun(iso, script);
  return run.check(() => run.script(structure, run.initialState(shell), script));
}

function tooLong(iso: WorktreeIsolation, prefixed: boolean): string {
  return reason(
    iso,
    `The command${prefixed ? ' with the command prefix' : ''} is longer than ${MAX_COMMAND_LENGTH} characters, more than this check reads, so its git target cannot be read. Write long file contents with the Write tool.`,
  );
}

/** How the tool's own shell starts. */
type ToolShell = 'bash' | 'wsl';

/**
 * The start of the shell pi's bash tool runs: `shellPath` with -c, or WSL's System32 bash.exe with the command on stdin, in
 * the distribution's environment; undefined for a shell whose text this check does not read as bash.
 */
function toolShell(shellPath: string | undefined): ToolShell | undefined {
  if (shellPath === undefined) return 'bash';
  const name = commandName(shellPath);
  // pi tells WSL's bash by %SystemRoot%; any System32 or Sysnative folder counts here, which can only block more.
  if (name === 'bash' && /^(?:system32|sysnative)$/i.test(path.win32.basename(path.win32.dirname(shellPath)))) return 'wsl';
  return BASH_READ_SHELLS.has(name) ? 'bash' : undefined;
}

const GIT_PATH_ENV: ReadonlySet<string> = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']);
// Variables whose text git runs through a shell, its PAGER, EDITOR and VISUAL fallbacks included.
const COMMAND_ENV: ReadonlySet<string> = new Set(['GIT_SSH_COMMAND', 'GIT_PAGER', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_EXTERNAL_DIFF', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND', 'PAGER', 'EDITOR', 'VISUAL']);
// Configuration keys whose value git runs through a shell (a credential helper after its `!`).
const GIT_COMMAND_CONFIG = /^(core\.(sshcommand|pager|editor|askpass|fsmonitor|gitproxy)|sequence\.editor|diff\.external|interactive\.difffilter|pager\.[^=]+|filter\.[^=]+\.(clean|smudge|process)|diff\.[^=]+\.(command|textconv)|merge\.[^=]+\.driver|credential(\.[^=]+)?\.helper|gpg(\.[^=]+)?\.program|remote\.[^=]+\.(uploadpack|receivepack))=/i;
// Variables through which git takes configuration (core.worktree among it) from the environment.
const GIT_CONFIG_ENV = /^GIT_CONFIG(_PARAMETERS|_COUNT|_KEY_\d+|_VALUE_\d+|_GLOBAL|_SYSTEM)?$/;
// Those that name a configuration file: from the starting environment it is the user's own, unread as ~/.gitconfig is.
const GIT_CONFIG_FILE_ENV: ReadonlySet<string> = new Set(['GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']);

/** A variable whose computed value hides where git or a cd goes. */
function targetVariable(name: string): boolean {
  return GIT_PATH_ENV.has(name) || COMMAND_ENV.has(name) || GIT_CONFIG_ENV.test(name) || name === 'CDPATH';
}

/** The name a bash variable is checked and kept under: git on Windows reads its environment without case, bash reads CDPATH and HOME with case. */
function envName(name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return name;
  const upper = name.toUpperCase();
  return upper === 'CDPATH' || upper === 'HOME' ? name : upper;
}

// Variables bash sets itself, some from text the command chose (`read` sets REPLY, `cd` PWD).
const SHELL_SET_VARIABLE = /^(_|REPLY|MAPFILE|OPTARG|OPTIND|PWD|OLDPWD|DIRSTACK|COPROC|FUNCNAME|HISTCMD|BASH\w*|COMP\w*|READLINE\w*)$/;

// Variables bash sets or reads in its own way, which never read as a defined value; HOME and PWD read from the shell's state.
const BASH_UNREAD = /^(UID|EUID|PPID|SHELLOPTS|BASHOPTS|GROUPS|RANDOM|SRANDOM|SECONDS|LINENO|EPOCHSECONDS|EPOCHREALTIME|HISTCMD|IFS|HOME|PWD)$/;
const IFS_KEY = 'ifs';
// Marks a read of HOME's possible values, so a later poison invalidates the pass; no variable's site key is `~`.
const HOME_READ = '~';
// `${HOME:=v}` and `${HOME=v}`, which may set HOME wherever the text holds them.
const HOME_DEFAULT = /\$\{HOME:?=/;
// The places that can set a variable: an assignment, `${NAME:=}` or `${NAME=}`, and a `{NAME}>` redirection.
const BASH_SITE = /(?<![\w$\\])([A-Za-z_]\w*)(?:\[[^\][]*\])?\+?=|\$\{([A-Za-z_]\w*):?=|\{([A-Za-z_]\w*)\}[<>]/g;
// Arithmetic, which assigns names held in values, and the forms that set a variable by a name the text does not show.
// Each inner run stops where another match of its form could start, which keeps a scan linear in the text's length.
const BASH_POISON =
  /\$\[|\(\(|(?<![\w$-])let\s|\$\{(?:[^$}]|\$(?!\{))*\[|\$\{(?:[^$}:]|\$(?!\{))*:(?![-=?+])|[A-Za-z_]\d*\[[^\][]*\]\+?=|\$\{!(?:[^$}]|\$(?!\{!))*=|-v\s+\S*\[|(?<![\w-])(?:declare|typeset|local|readonly|export)\s+[-+]/;
const ARITHMETIC_COMPARISON = /\s-(?:eq|ne|lt|le|gt|ge)\b/;
const ARITHMETIC_TEST = /^-(?:eq|ne|lt|le|gt|ge)$/;

/** Whether a bash variable can read as a value. */
function bashReadable(name: string): boolean {
  return !BASH_UNREAD.test(name) && !SHELL_SET_VARIABLE.test(name);
}

// cmd's `set`, with its name quoted or after /p; carets can hide one, so the interpreter adds each set it runs too.
const CMD_SITE = new RegExp(`(?<![\\w-])set(?=${CMD_DELIMITER}|[/"])${CMD_DELIMITER}*(?:/p${CMD_DELIMITER}*)?"?([^="&|<>\\r\\n]+)=`, 'gi');
// `set /a` assigns the names its expression holds.
const CMD_POISON = new RegExp(`(?<![\\w-])set${CMD_DELIMITER}*/a`, 'i');
const CMD_DELIMITERS = new RegExp(`^${CMD_DELIMITER}+`);
const CMD_CD_SWITCH = new RegExp(`^${CMD_DELIMITER}*/d`, 'i');
const CMD_TRAILING_SPACE = new RegExp(`${CMD_SPACE}+$`);
// Names cmd gives a value itself when the environment lacks them, and the `=C:` drive directories only cmd holds.
const CMD_DYNAMIC = /^(?:CD|DATE|TIME|RANDOM|ERRORLEVEL|CMDEXTVERSION|CMDCMDLINE|HIGHESTNUMANODENUMBER|__CD__|__APPDIR__|=.*)$/i;
const START_SWITCHES: ReadonlySet<string> = new Set(['/i', '/min', '/max', '/separate', '/shared', '/low', '/normal', '/high', '/realtime', '/abovenormal', '/belownormal', '/wait', '/b']);

/** A cmd text's sites and whether it poisons. */
function cmdTextScan(text: string): TextScan {
  return { sites: [...text.matchAll(CMD_SITE)].map((m) => ({ key: siteKey(m[1]!), offset: m.index })), poisoned: CMD_POISON.test(text) };
}

/** A bash text's sites and whether it poisons; quotes and comments count too, which only adds sites. */
function bashTextScan(text: string): TextScan {
  const sites = [...text.matchAll(BASH_SITE)].map((m) => ({ key: siteKey(m[1] ?? m[2] ?? m[3]!), offset: m.index }));
  return { sites, poisoned: BASH_POISON.test(text) || (text.includes('[[') && ARITHMETIC_COMPARISON.test(text)) };
}

/**
 * The text a command variable's written value gives the shell git starts, each `$name` or `${name}` as `reference` gives
 * it; undefined when that is undefined or another part is computed. That shell parses the expanded text again.
 */
function outsideValueText(raw: string, reference: (name: string) => string | undefined): string | undefined {
  let text = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '\\') {
      const next = raw[++i];
      if (next === undefined) return undefined;
      if (next !== '\n') text += !quoted || '$`"\\'.includes(next) ? next : `\\${next}`;
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "'" && !quoted) {
      const end = raw.indexOf("'", i + 1);
      if (end < 0) return undefined;
      text += raw.slice(i + 1, end);
      i = end;
      continue;
    }
    if (ch === '$') {
      const variable = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/.exec(raw.slice(i));
      if (variable) {
        const value = reference(variable[1] ?? variable[2]!);
        if (value === undefined) return undefined;
        text += value;
        i += variable[0].length - 1;
        continue;
      }
      if (/[A-Za-z0-9_{(@*#?!$'"-]/.test(raw[i + 1] ?? '')) return undefined;
    }
    // An array assignment, or an expansion this reading does not take.
    if (ch === '`' || (ch === '(' && !quoted)) return undefined;
    text += ch;
  }
  return quoted ? undefined : text;
}

type OptionArgument = 'none' | 'required' | 'optional';

interface WrapperOption {
  readonly short?: string;
  readonly long?: string;
  readonly argument: OptionArgument;
  /** What the option does, when it matters to the check. */
  readonly role?: 'chdir' | 'split' | 'replace' | 'chroot' | 'login' | 'noCommand' | 'script' | 'exec';
}

const option = (short: string | undefined, long?: string, argument: OptionArgument = 'none', role?: WrapperOption['role']): WrapperOption => ({
  ...(short !== undefined ? { short } : {}),
  ...(long !== undefined ? { long } : {}),
  argument,
  ...(role !== undefined ? { role } : {}),
});
const HELP = [option(undefined, 'help'), option(undefined, 'version')];

/** The replace string the last replace option given sets, `{}` for one that takes none; undefined without one. */
function replaceString(given: ReadonlyArray<{ readonly option: WrapperOption; readonly value: string | undefined }>): string | undefined {
  const replacing = given.filter((g) => g.option.role === 'replace').at(-1);
  return replacing === undefined ? undefined : replacing.value ?? '{}';
}
// util-linux su; runuser adds -u. `-` alone is -l.
const SU_OPTIONS = [
  option('m', 'preserve-environment'), option('p'), option('w', 'whitelist-environment', 'required'), option('g', 'group', 'required'),
  option('G', 'supp-group', 'required'), option('l', 'login', 'none', 'login'), option('c', 'command', 'required', 'script'),
  option(undefined, 'session-command', 'required', 'script'), option('f', 'fast'), option('s', 'shell', 'required'), option('P', 'pty'),
  option('h', 'help'), option('V', 'version'),
];

// Every option each wrapper accepts (GNU coreutils and findutils, sudo 1.9, bash builtins); any other option blocks.
const WRAPPERS: ReadonlyMap<string, readonly WrapperOption[]> = new Map([
  ['env', [
    option('i', 'ignore-environment'), option('0', 'null'), option('u', 'unset', 'required'), option('C', 'chdir', 'required', 'chdir'),
    option('S', 'split-string', 'required', 'split'), option('a', 'argv0', 'required'), option('v', 'debug'),
    option(undefined, 'block-signal', 'optional'), option(undefined, 'default-signal', 'optional'), option(undefined, 'ignore-signal', 'optional'),
    option(undefined, 'list-signal-handling'), ...HELP,
  ]],
  ['command', [option('p'), option('v'), option('V')]],
  ['builtin', []],
  ['exec', [option('a', undefined, 'required'), option('c'), option('l')]],
  ['nohup', HELP],
  ['nice', [option('n', 'adjustment', 'required'), ...HELP]],
  ['time', [option('f', 'format', 'required'), option('o', 'output', 'required'), option('a', 'append'), option('p', 'portability'), option('v', 'verbose'), option('q', 'quiet'), option('V', 'version'), option(undefined, 'help')]],
  ['timeout', [option('s', 'signal', 'required'), option('k', 'kill-after', 'required'), option('v', 'verbose'), option(undefined, 'preserve-status'), option(undefined, 'foreground'), ...HELP]],
  ['sudo', [
    option('A', 'askpass'), option('b', 'background'), option('B', 'bell'), option('C', 'close-from', 'required'), option('D', 'chdir', 'required', 'chdir'),
    option('E'), option(undefined, 'preserve-env', 'optional'), option('e', 'edit', 'none', 'noCommand'), option('g', 'group', 'required'), option('H', 'set-home'),
    option('h', undefined, 'optional'), option(undefined, 'host', 'required'), option(undefined, 'help'), option('i', 'login', 'none', 'login'),
    option('K', 'remove-timestamp'), option('k', 'reset-timestamp'), option('l', 'list'), option('N', 'no-update'), option('n', 'non-interactive'),
    option('P', 'preserve-groups'), option('p', 'prompt', 'required'), option('R', 'chroot', 'required', 'chroot'), option('r', 'role', 'required'),
    option('S', 'stdin'), option('s', 'shell'), option('T', 'command-timeout', 'required'), option('t', 'type', 'required'),
    option('U', 'other-user', 'required'), option('u', 'user', 'required'), option('V', 'version'), option('v', 'validate'),
  ]],
  ['stdbuf', [option('i', 'input', 'required'), option('o', 'output', 'required'), option('e', 'error', 'required'), ...HELP]],
  ['xargs', [
    option('0', 'null'), option('a', 'arg-file', 'required'), option('d', 'delimiter', 'required'), option('E', undefined, 'required'),
    option('e', 'eof', 'optional'), option('I', undefined, 'required', 'replace'), option('i', 'replace', 'optional', 'replace'),
    option('L', undefined, 'required'), option('l', 'max-lines', 'optional'), option('n', 'max-args', 'required'), option('o', 'open-tty'),
    option('P', 'max-procs', 'required'), option('p', 'interactive'), option('r', 'no-run-if-empty'), option('s', 'max-chars', 'required'),
    option('t', 'verbose'), option('x', 'exit'), option(undefined, 'process-slot-var', 'required'), option(undefined, 'show-limits'), ...HELP,
  ]],
  ['setsid', [option('c', 'ctty'), option('f', 'fork'), option('w', 'wait'), option('h', 'help'), option('V', 'version')]],
  ['doas', [option('C', undefined, 'required', 'noCommand'), option('L'), option('n'), option('s'), option('u', undefined, 'required')]],
  ['flock', [
    option('s', 'shared'), option('x', 'exclusive'), option('e'), option('u', 'unlock'), option('n', 'nonblock'), option(undefined, 'nb'),
    option('w', 'timeout', 'required'), option(undefined, 'wait', 'required'), option('E', 'conflict-exit-code', 'required'), option('o', 'close'),
    option('F', 'no-fork'), option('c', 'command', 'required', 'script'), option(undefined, 'verbose'), option('h', 'help'), option('V', 'version'),
  ]],
  ['watch', [
    option('n', 'interval', 'required'), option('d', 'differences', 'optional'), option('e', 'errexit'), option('g', 'chgexit'), option('q', 'equexit', 'required'),
    option('c', 'color'), option('C', 'no-color'), option('t', 'no-title'), option('b', 'beep'), option('p', 'precise'), option('x', 'exec', 'none', 'exec'),
    option('w', 'no-wrap'), option('r', 'no-rerun'), option('h', 'help'), option('v', 'version'),
  ]],
  // GNU parallel's common options; the rest of its table (remote logins among it) blocks.
  ['parallel', [
    option('j', 'jobs', 'required'), option('k', 'keep-order'), option('n', 'max-args', 'required'), option('N', undefined, 'required'), option('X'), option('m'),
    option('q', 'quote'), option('0', 'null'), option('a', 'arg-file', 'required'), option('d', 'delimiter', 'required'), option('I', undefined, 'required', 'replace'),
    option('i', 'replace', 'optional', 'replace'), option('r', 'no-run-if-empty'), option('t', 'verbose'), option('v'), option('u', 'ungroup'), option('g', 'group'),
    option(undefined, 'line-buffer'), option(undefined, 'tag'), option(undefined, 'dry-run'), option(undefined, 'bar'), option(undefined, 'progress'), option(undefined, 'eta'),
    option(undefined, 'halt', 'required'), option(undefined, 'joblog', 'required'), option(undefined, 'results', 'required'), option(undefined, 'timeout', 'required'),
    option(undefined, 'retries', 'required'), option(undefined, 'colsep', 'required'), option(undefined, 'header', 'required'), option(undefined, 'workdir', 'required', 'chdir'),
    option(undefined, 'wd', 'required', 'chdir'), option(undefined, 'will-cite'), ...HELP,
  ]],
  // util-linux 2.39.
  ['ionice', [
    option('c', 'class', 'required'), option('n', 'classdata', 'required'), option('p', 'pid', 'required', 'noCommand'), option('P', 'pgid', 'required', 'noCommand'),
    option('u', 'uid', 'required', 'noCommand'), option('t', 'ignore'), option('h', 'help'), option('V', 'version'),
  ]],
  ['taskset', [option('a', 'all-tasks'), option('p', 'pid', 'none', 'noCommand'), option('c', 'cpu-list'), option('h', 'help'), option('V', 'version')]],
  ['chrt', [
    option('b', 'batch'), option('d', 'deadline'), option('f', 'fifo'), option('i', 'idle'), option('o', 'other'), option('r', 'rr'), option('R', 'reset-on-fork'),
    option('T', 'sched-runtime', 'required'), option('P', 'sched-period', 'required'), option('D', 'sched-deadline', 'required'), option('a', 'all-tasks'),
    option('m', 'max', 'none', 'noCommand'), option('p', 'pid', 'none', 'noCommand'), option('v', 'verbose'), option('h', 'help'), option('V', 'version'),
  ]],
  // BSD script's -t takes a value where util-linux's takes an attached file, so neither form is read.
  ['script', [
    option('I', 'log-in', 'required'), option('O', 'log-out', 'required'), option('B', 'log-io', 'required'), option('T', 'log-timing', 'required'),
    option('m', 'logging-format', 'required'), option('a', 'append'), option('c', 'command', 'required', 'script'), option('e', 'return'), option('f', 'flush'),
    option(undefined, 'force'), option('E', 'echo', 'required'), option('o', 'output-limit', 'required'), option('q', 'quiet'), option('h', 'help'), option('V', 'version'),
  ]],
  ['su', SU_OPTIONS],
  ['runuser', [option('u', 'user', 'required'), ...SU_OPTIONS]],
  ['winpty', [option('h', 'help'), option(undefined, 'mouse'), option(undefined, 'showkey'), option(undefined, 'version')]],
  ['cross-env', []],
  ['cross-env-shell', []],
  // npm 7+ exec; npm configuration given as an option blocks.
  ['npx', [
    option('p', 'package', 'required'), option('c', 'call', 'required', 'script'), option('y', 'yes'), option(undefined, 'no'), option(undefined, 'no-install'),
    option(undefined, 'ignore-existing'), option('q', 'quiet'), option(undefined, 'silent'), option('w', 'workspace', 'required'), option(undefined, 'workspaces'),
    option(undefined, 'include-workspace-root'), option(undefined, 'prefer-offline'), option(undefined, 'prefer-online'), option(undefined, 'offline'),
    option(undefined, 'loglevel', 'required'), ...HELP,
  ]],
]);
// These take `NAME=value` operands before the command.
const ENV_SETTERS: ReadonlySet<string> = new Set(['env', 'sudo', 'cross-env', 'cross-env-shell']);
const ENV_RESETTERS: ReadonlySet<string> = new Set(['sudo', 'su', 'runuser', 'doas']);
// These take options after operands too (GNU getopt's permutation).
const PERMUTING: ReadonlySet<string> = new Set(['script', 'su', 'runuser']);
// The separators before GNU parallel's input sources.
const PARALLEL_SOURCES: ReadonlySet<string> = new Set([':::', '::::', ':::+', '::::+']);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
const READERS: ReadonlySet<string> = new Set(['read', 'mapfile', 'readarray', 'printf', 'getopts']);
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'fish', 'tcsh', 'csh']);
// Shells whose text reads as bash's: ksh and mksh take a two-operand cd, zsh runs glob qualifiers, fish and csh set variables their own way.
const BASH_READ_SHELLS: ReadonlySet<string> = new Set(['bash', 'sh', 'dash', 'ash']);
// Long options of those shells that take no value; any other long option may consume the next word.
const SHELL_FLAG_OPTIONS: ReadonlySet<string> = new Set(['--login', '--noprofile', '--norc', '--posix', '--restricted', '--verbose', '--version', '--noediting', '--debugger', '--help', '--interactive', '--no-config', '--private']);
const SHELL_VALUE_OPTIONS: ReadonlySet<string> = new Set(['--rcfile', '--init-file']);
// Only fish's -C (--init-command) takes a value; in the other shells -C is the noclobber flag.
const FISH_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '--init-command']);
// git's global options that take no value; any other option before the subcommand either is handled below or blocks.
const GIT_FLAG_OPTIONS: ReadonlySet<string> = new Set(['-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-advice', '--version', '--help', '--html-path', '--man-path', '--info-path', '--no-lazy-fetch']);

/** `flag` takes no value, `value` an attached `=value` or the next word, `optional` only an attached `=value`. */
type OptionKind = 'flag' | 'value' | 'optional';
/**
 * A program's options as parse-options (git) or getopt_long (GNU) reads them: long names, abbreviated to any unique
 * prefix; short letters, clustered, each standing for a long name, or for a `-x` key that has none.
 */
interface OptionTable {
  readonly long: Readonly<Record<string, OptionKind>>;
  readonly short: Readonly<Record<string, string>>;
  /** parse-options takes `--no-<name>` for every long name; getopt_long only the names it lists. */
  readonly negatable: boolean;
  /** Options end at the first operand (git config); otherwise they may follow operands until `--`. */
  readonly stopAtOperand?: true;
}
/** Each option by long name (`no-<name>` when negated), and each operand, with the index of the word that holds it; undefined where computed. */
interface ReadOptions {
  readonly options: ReadonlyArray<{ readonly name: string; readonly value: string | undefined; readonly index: number }>;
  readonly operands: ReadonlyArray<{ readonly word: string | undefined; readonly index: number }>;
}
const gitOptionTable = (long: Readonly<Record<string, OptionKind>>, short: Readonly<Record<string, string>>, stopAtOperand?: true): OptionTable => ({ long, short, negatable: true, ...(stopAtOperand ? { stopAtOperand } : {}) });
// git 2.56's `git worktree add -h`.
const GIT_WORKTREE_ADD = gitOptionTable(
  { force: 'flag', orphan: 'flag', detach: 'flag', checkout: 'flag', lock: 'flag', reason: 'value', quiet: 'flag', track: 'flag', 'guess-remote': 'flag', 'relative-paths': 'flag', '-b': 'value', '-B': 'value' },
  { f: 'force', b: '-b', B: '-B', d: 'detach', q: 'quiet' },
);
// git 2.56's `git clone --git-completion-helper-all`.
const GIT_CLONE = gitOptionTable(
  {
    verbose: 'flag', quiet: 'flag', progress: 'flag', 'reject-shallow': 'flag', 'no-checkout': 'flag', checkout: 'flag', bare: 'flag', naked: 'flag', mirror: 'flag', local: 'flag',
    'no-hardlinks': 'flag', hardlinks: 'flag', shared: 'flag', dissociate: 'flag', 'single-branch': 'flag', tags: 'flag', 'shallow-submodules': 'flag', ipv4: 'flag', ipv6: 'flag',
    'also-filter-submodules': 'flag', 'remote-submodules': 'flag', sparse: 'flag', 'recurse-submodules': 'optional', recursive: 'optional', jobs: 'value', template: 'value',
    reference: 'value', 'reference-if-able': 'value', origin: 'value', branch: 'value', revision: 'value', 'upload-pack': 'value', depth: 'value', 'shallow-since': 'value',
    'shallow-exclude': 'value', 'separate-git-dir': 'value', 'ref-format': 'value', config: 'value', 'server-option': 'value', filter: 'value', 'bundle-uri': 'value',
  },
  { v: 'verbose', q: 'quiet', n: 'no-checkout', l: 'local', s: 'shared', j: 'jobs', o: 'origin', b: 'branch', u: 'upload-pack', c: 'config', '4': 'ipv4', '6': 'ipv6' },
);
// git 2.56's `git init --git-completion-helper-all`.
const GIT_INIT = gitOptionTable(
  { template: 'value', bare: 'flag', shared: 'optional', quiet: 'flag', 'separate-git-dir': 'value', 'initial-branch': 'value', 'object-format': 'value', 'ref-format': 'value' },
  { q: 'quiet', b: 'initial-branch' },
);
const GIT_CONFIG_FILES: Readonly<Record<string, OptionKind>> = { global: 'flag', system: 'flag', local: 'flag', worktree: 'flag', file: 'value', blob: 'value' };
const GIT_CONFIG_TYPES: Readonly<Record<string, OptionKind>> = { type: 'value', bool: 'flag', int: 'flag', 'bool-or-int': 'flag', 'bool-or-str': 'flag', path: 'flag', 'expiry-date': 'flag' };
// git 2.56's `git config` without a subcommand, which stops reading options at its first operand.
const GIT_CONFIG_LEGACY = gitOptionTable(
  {
    ...GIT_CONFIG_FILES, ...GIT_CONFIG_TYPES, get: 'flag', 'get-all': 'flag', 'get-regexp': 'flag', 'get-urlmatch': 'flag', 'replace-all': 'flag', add: 'flag', unset: 'flag',
    'unset-all': 'flag', 'rename-section': 'flag', 'remove-section': 'flag', list: 'flag', edit: 'flag', 'get-color': 'flag', 'get-colorbool': 'flag', default: 'value',
    comment: 'value', null: 'flag', 'name-only': 'flag', 'show-origin': 'flag', 'show-scope': 'flag', includes: 'flag', 'fixed-value': 'flag',
  },
  { f: 'file', t: 'type', l: 'list', e: 'edit', z: 'null' },
  true,
);
// git 2.56's `git config set`, `unset`, `rename-section` and `remove-section`, which stop at their first operand too.
const GIT_CONFIG_WRITE = gitOptionTable({ ...GIT_CONFIG_FILES, ...GIT_CONFIG_TYPES, all: 'flag', value: 'value', 'fixed-value': 'flag', comment: 'value', append: 'flag' }, { f: 'file', t: 'type' }, true);
// The legacy actions that only read; with none of them and no other action, two or more operands set a value.
const GIT_CONFIG_READS: ReadonlySet<string> = new Set(['get', 'get-all', 'get-regexp', 'get-urlmatch', 'list', 'edit', 'get-color', 'get-colorbool']);
// GNU coreutils 8.32 ln, as Git Bash ships it.
const LN_OPTIONS: OptionTable = {
  long: {
    backup: 'optional', directory: 'flag', force: 'flag', interactive: 'flag', logical: 'flag', 'no-dereference': 'flag', physical: 'flag', relative: 'flag', suffix: 'value',
    symbolic: 'flag', 'target-directory': 'value', 'no-target-directory': 'flag', verbose: 'flag', help: 'flag', version: 'flag',
  },
  short: { b: 'backup', d: 'directory', F: 'directory', f: 'force', i: 'interactive', L: 'logical', n: 'no-dereference', P: 'physical', r: 'relative', s: 'symbolic', S: 'suffix', t: 'target-directory', T: 'no-target-directory', v: 'verbose' },
  negatable: false,
};

/** The long option `spelled` names, exactly or as its one unique prefix; undefined when none or several match. */
function longOption(table: OptionTable, spelled: string): { readonly name: string; readonly kind: OptionKind } | undefined {
  const names = Object.keys(table.long).filter((name) => !name.startsWith('-'));
  if (names.includes(spelled)) return { name: spelled, kind: table.long[spelled]! };
  if (table.negatable && spelled.startsWith('no-') && names.includes(spelled.slice(3))) return { name: spelled, kind: 'flag' };
  const found = new Map<string, OptionKind>();
  for (const name of names) {
    if (name.startsWith(spelled)) found.set(name, table.long[name]!);
    if (table.negatable && `no-${name}`.startsWith(spelled)) found.set(`no-${name}`, 'flag');
  }
  const [only] = found;
  return found.size === 1 ? { name: only![0], kind: only![1] } : undefined;
}

/**
 * `args` from `start` read as `table`'s program reads them; undefined when a word is an option it does not know, an
 * ambiguous abbreviation, or one that lacks its value. A computed word may be an option or an operand, so it is an
 * operand and, where options end at the first operand, ends them.
 */
function readOptions(args: ReadonlyArray<string | undefined>, start: number, table: OptionTable): ReadOptions | undefined {
  const options: Array<ReadOptions['options'][number]> = [];
  const operands: Array<ReadOptions['operands'][number]> = [];
  let ended = false;
  for (let k = start; k < args.length; k++) {
    const word = args[k];
    if (ended || word === undefined || !word.startsWith('-') || word === '-') {
      operands.push({ word, index: k });
      if (table.stopAtOperand) ended = true;
      continue;
    }
    if (word === '--' || (table.negatable && word === '--end-of-options')) {
      ended = true;
      continue;
    }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      const found = longOption(table, word.slice(2, eq < 0 ? undefined : eq));
      if (found === undefined || (found.kind === 'flag' && eq >= 0)) return undefined;
      if (eq >= 0 || found.kind !== 'value') {
        options.push({ name: found.name, value: eq >= 0 ? word.slice(eq + 1) : undefined, index: k });
        continue;
      }
      if (k + 1 >= args.length) return undefined;
      options.push({ name: found.name, value: args[++k], index: k });
      continue;
    }
    for (let c = 1; c < word.length; c++) {
      const name = table.short[word[c]!];
      if (name === undefined) return undefined;
      if (table.long[name] !== 'value') {
        options.push({ name, value: undefined, index: k });
        continue;
      }
      if (c + 1 < word.length) options.push({ name, value: word.slice(c + 1), index: k });
      else if (k + 1 < args.length) options.push({ name, value: args[++k], index: k });
      else return undefined;
      break;
    }
  }
  return { options, operands };
}

/** The values `parsed` gives option `name`, in order. */
function optionValues(parsed: ReadOptions, name: string): ReadOptions['options'] {
  return parsed.options.filter((option) => option.name === name);
}
const POWERSHELLS: ReadonlySet<string> = new Set(['pwsh', 'powershell']);

/** What a switch of pwsh or Windows PowerShell does, as far as the check reads it. */
type PsSwitch = 'flag' | 'value' | 'help' | 'version' | 'noprofile' | 'login' | 'startup' | 'server' | 'command' | 'commandWithArgs' | 'encoded' | 'file' | 'directory';
/** A switch's full name, the shortest prefix that takes it, and what it does. */
type PsSwitchEntry = readonly [name: string, shortest: string, kind: PsSwitch];
// pwsh 7's switches in the order its parser tries them (CommandLineParameterParser.cs); a word none takes is the script file.
const PWSH_SWITCHES: readonly PsSwitchEntry[] = [
  ['version', 'v', 'version'], ['help', 'h', 'help'], ['?', '?', 'help'], ['login', 'l', 'login'], ['noexit', 'noe', 'flag'],
  ['noprofile', 'nop', 'noprofile'], ['nologo', 'nol', 'flag'], ['noninteractive', 'noni', 'flag'], ['socketservermode', 'so', 'server'],
  ['v2socketservermode', 'v2so', 'server'], ['servermode', 's', 'server'], ['namedpipeservermode', 'nam', 'server'], ['sshservermode', 'sshs', 'server'],
  ['noprofileloadtime', 'noprofileloadtime', 'flag'], ['interactive', 'i', 'flag'], ['configurationfile', 'configurationfile', 'startup'],
  ['configurationname', 'config', 'startup'], ['custompipename', 'cus', 'value'], ['commandwithargs', 'commandwithargs', 'commandWithArgs'],
  ['cwa', 'cwa', 'commandWithArgs'], ['command', 'c', 'command'], ['windowstyle', 'w', 'value'], ['file', 'f', 'file'], ['outputformat', 'o', 'value'],
  ['of', 'o', 'value'], ['inputformat', 'inp', 'value'], ['if', 'if', 'value'], ['executionpolicy', 'ex', 'value'], ['ep', 'ep', 'value'],
  ['encodedcommand', 'e', 'encoded'], ['ec', 'e', 'encoded'], ['encodedarguments', 'encodeda', 'value'], ['ea', 'ea', 'value'],
  ['settingsfile', 'settings', 'value'], ['sta', 'sta', 'flag'], ['mta', 'mta', 'flag'], ['workingdirectory', 'wo', 'directory'], ['wd', 'wd', 'directory'],
  ['removeworkingdirectorytrailingcharacter', 'removeworkingdirectorytrailingcharacter', 'flag'], ['token', 'to', 'value'], ['utctimestamp', 'utc', 'value'],
];
// Windows PowerShell 5.1's switches in the order its parser tries them, measured; a word none takes starts the command
// text. It takes -WorkingDirectory's value and stays where it starts.
const WINDOWS_POWERSHELL_SWITCHES: readonly PsSwitchEntry[] = [
  ['help', 'h', 'help'], ['?', '?', 'help'], ['noexit', 'noe', 'flag'], ['importsystemmodules', 'imp', 'flag'], ['noprofile', 'nop', 'noprofile'],
  ['nologo', 'nol', 'flag'], ['noninteractive', 'noni', 'flag'], ['socketservermode', 'so', 'server'], ['servermode', 's', 'server'],
  ['namedpipeservermode', 'nam', 'server'], ['configurationname', 'config', 'startup'], ['command', 'c', 'command'], ['windowstyle', 'w', 'value'],
  ['file', 'f', 'file'], ['outputformat', 'o', 'value'], ['of', 'o', 'value'], ['inputformat', 'i', 'value'], ['if', 'i', 'value'],
  ['executionpolicy', 'ex', 'value'], ['ep', 'ep', 'value'], ['encodedcommand', 'e', 'encoded'], ['ec', 'e', 'encoded'],
  ['encodedarguments', 'encodeda', 'value'], ['ea', 'ea', 'value'], ['sta', 's', 'flag'], ['mta', 'mta', 'flag'], ['workingdirectory', 'wo', 'value'],
  ['wd', 'wd', 'value'], ['token', 'to', 'value'], ['utctimestamp', 'utc', 'value'],
];
// The dashes PowerShell takes before a switch (`CharExtensions.IsDash`), and `/`.
const PS_SWITCH_START = /^[-\u2013\u2014\u2015/]/;
const PS_DASH = /^[-\u2013\u2014\u2015]/;

/** What `word` is to pwsh or Windows PowerShell: a switch of `table` it takes, or undefined for a word that is none. */
function psSwitch(word: string, table: readonly PsSwitchEntry[]): PsSwitch | undefined {
  const trimmed = word.trim();
  if (!PS_SWITCH_START.test(trimmed)) return undefined;
  let key = trimmed.slice(1).toLowerCase();
  // `--name` reads as `-name`.
  if (PS_DASH.test(trimmed) && PS_DASH.test(key)) key = key.slice(1);
  return table.find(([name, shortest]) => key.length >= shortest.length && name.startsWith(key))?.[2];
}
// wsl.exe's arguments, from `wsl.h` and the parser in `WslClient.cpp` (microsoft/WSL).
const WSL_GUID = /^(?:\{[0-9a-f-]{36}\}|[0-9a-f-]{36})$/i;
const WSL_BLANKS = /^[ \t]+/;
const WSL_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-d', '--distribution', '--distribution-id', '-u', '--user', '--parent-console']);
const WSL_MANAGEMENT: ReadonlySet<string> = new Set([
  '--help', '--update', '--export', '--import', '--import-in-place', '-l', '--list', '-s', '--setdefault', '--set-default', '-t', '--terminate',
  '--unregister', '--set-default-version', '--shutdown', '--manage', '--set-version', '--mount', '--unmount', '--install', '--status', '-v',
  '--version', '--uninstall',
]);
const CD_COMMANDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'chdir']);
// bash expands an alias of one of its reserved words before it reads the word, which changes how the text parses.
const BASH_RESERVED: ReadonlySet<string> = new Set(['if', 'then', 'else', 'elif', 'fi', 'case', 'esac', 'for', 'select', 'while', 'until', 'do', 'done', 'in', 'function', 'time', 'coproc', '{', '}', '!', '[[', ']]']);
// The characters bash refuses in an alias name (`legal_alias_name`).
const ALIAS_NAME_REFUSED = /[/$`=|&;()<>\s'"\\]/;
// Past this many places the shell may stand in (directory and stack), the parse stops following them and blocks a later git or cd.
const MAX_PLACES = 32;
// A loop that has not settled within this many walks makes the places unknown.
const MAX_UNSETTLED_WALKS = 32;
// A `for` or `foreach` over at most this many items the text gives runs its body once per item; a longer list is followed as any loop.
const MAX_LOOP_ITEMS = 32;
// Past this many loop and function body walks in one pass the command blocks, which bounds nested loops and recursion.
const MAX_LOOP_WALKS = 256;
const MAX_DEPTH = 6;
// Past this many nested blocks, loops, subshells, function calls and texts the command blocks, before the call stack runs out.
const MAX_NESTING = 200;
// Past this many EXIT trap walks where one shell exits, the command blocks.
const MAX_TRAP_RUNS = 6;
// Bash's builtins that read or change the directory stack.
const STACK_COMMANDS: ReadonlySet<string> = new Set([...CD_COMMANDS, 'popd', 'dirs']);
const UNREAD_DIRECTORY = 'The working directory cannot be read.';
const GROWN_BASH =
  'A loop or a chain of cd commands left more possible folders than this check follows; change directory in a subshell, at a loop body\'s top level or in an `if` branch inside it, as in `for d in a b; do (cd "$d" && npm test); done`.';
const GROWN_POWERSHELL =
  'A loop or a chain of Set-Location commands left more possible locations than this check follows; change location between Push-Location and Pop-Location, at a loop body\'s top level or in an `if` branch inside it.';
// Trap conditions, upper case, that run only when the shell exits; any other may run between any two commands.
const EXIT_CONDITIONS: ReadonlySet<string> = new Set(['EXIT', '0']);

function commandName(word: string): string {
  return path.basename(word.replace(/\\/g, '/')).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '');
}

/** Whether `set`'s options turn on keyword mode (`-k`, `-o keyword`), where an assignment after the command name reaches it. */
function keywordMode(args: ReadonlyArray<string | undefined>): boolean {
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === undefined) return true;
    if (word === '--' || word === '-' || !word.startsWith('-')) return false;
    if (word.slice(1).includes('k')) return true;
    if (word.slice(1).includes('o') && (args[++i] === undefined || args[i] === 'keyword')) return true;
  }
  return false;
}

/** Every value each variable may hold, undefined for a computed one. */
type Env = Map<string, ReadonlySet<string | undefined>>;

/** An assignment may run in a subshell or a branch not taken, so the earlier values stay possible, as directories do. */
function widen(env: Env, name: string, value: string | undefined): void {
  env.set(name, new Set([...(env.get(name) ?? []), value]));
}

// /dev/stdin and the descriptor files: a script operand there is read from input.
const INPUT_FILE = /^\/(?:dev\/(?:stdin|fd\/\d+)|proc\/[^/]+\/(?:task\/[^/]+\/)?fd\/\d+)$/;

// The exit statuses a command may have left in a place, as bits.
const SUCCEEDED = 1;
const FAILED = 2;
const EITHER = SUCCEEDED | FAILED;

/** One way a shell may stand: its directory together with its own directory stack and OLDPWD. */
interface Place {
  readonly dir: string;
  /** The directory stack, its top last. */
  readonly stack: readonly string[];
  /** The values OLDPWD may hold, undefined among them while it is unset; null when the text does not give it. */
  readonly previous: ReadonlySet<string | undefined> | null;
  /** The exit statuses the last command may have left here (SUCCEEDED, FAILED), which `&&` and `||` read. */
  readonly exits: number;
}

// Each place's key by its stack and directory; a stack array is never changed once made, and places share it.
const placeKeys = new WeakMap<readonly string[], Map<string, string>>();

function placeKey(place: Place): string {
  let byDir = placeKeys.get(place.stack);
  if (byDir === undefined) placeKeys.set(place.stack, (byDir = new Map()));
  let key = byDir.get(place.dir);
  if (key === undefined) byDir.set(place.dir, (key = JSON.stringify([place.dir, ...place.stack])));
  return key;
}

/**
 * The places of `lists` with each directory and stack once, its exit statuses and OLDPWD values joined; undefined when
 * a list is, or past MAX_PLACES.
 */
function joinPlaces(...lists: ReadonlyArray<readonly Place[] | undefined>): Place[] | undefined {
  const joined = new Map<string, Place>();
  for (const list of lists) {
    if (list === undefined) return undefined;
    for (const place of list) {
      const key = placeKey(place);
      const found = joined.get(key);
      joined.set(key, found === undefined ? place : { ...found, exits: found.exits | place.exits, previous: joinPrevious(found.previous, place.previous) });
    }
  }
  return joined.size > MAX_PLACES ? undefined : [...joined.values()];
}

function joinPrevious(a: Place['previous'], b: Place['previous']): Place['previous'] {
  if (a === null || b === null) return null;
  if (a === b) return a;
  const joined = new Set([...a, ...b]);
  return joined.size > MAX_PLACES ? null : joined;
}

/** `places` with every exit status possible, as after a command whose status is not known. */
function eitherExit(places: readonly Place[]): Place[] {
  return places.map((place) => (place.exits === EITHER ? place : { ...place, exits: EITHER }));
}

/** Each directory `places` hold, once. */
function directories(places: readonly Place[]): string[] {
  return [...new Set(places.map((place) => place.dir))];
}

/** Where a new process starts: each directory, with an empty stack and an OLDPWD the text does not give. */
function startingPlaces(dirs: Iterable<string> | undefined): Place[] | undefined {
  const distinct = dirs === undefined ? undefined : new Set(dirs);
  return distinct === undefined || distinct.size > MAX_PLACES ? undefined : [...distinct].map((dir) => ({ dir, stack: [], previous: null, exits: EITHER }));
}

/** A trap on anything but EXIT, which may run before any later command: its condition, upper case, undefined when computed or absent. */
interface RepeatingTrap {
  readonly condition: string | undefined;
  readonly action: string;
}

/** The EXIT actions a shell runs where it exits, and the traps that may run before any of its commands. */
interface Traps {
  readonly exit: string[];
  readonly repeating: RepeatingTrap[];
}

function noTraps(): Traps {
  return { exit: [], repeating: [] };
}

/** The places a new process has stood in: those it starts in, by key. */
function seenOf(places: readonly Place[] | undefined): Map<string, Place> | undefined {
  return places === undefined ? undefined : new Map(places.map((place) => [placeKey(place), place]));
}

interface ShellState {
  /**
   * Every place the shell may stand in; a command that may fail leaves the places before it possible. Undefined once
   * they cannot be read.
   */
  places: Place[] | undefined;
  /**
   * Every place this process has stood in, by `placeKey`, undefined past MAX_PLACES; a trap, a jump or a loop's exit may
   * resume from any.
   */
  seen: Map<string, Place> | undefined;
  /** A jump (break, continue, return, a catch) left the straight line, so every later command may resume from any place seen. */
  scattered: boolean;
  readonly env: Env;
  /** The traps this shell set; a `( )` subshell has its own while it runs. */
  traps: Traps;
  /** The repeating traps whose actions run now; bash never runs a trap inside its own action. */
  firing: ReadonlySet<RepeatingTrap>;
  depth: number;
  /** This process's values the text proves, by the name its shell reads them under; text it runs itself shares the map. */
  readonly constants: Map<string, Constant>;
  /** The loop variables bound for the body walked now, by the name a constant has; each reads while its header is its one site. */
  readonly bindings: Map<string, Constant>;
  /** The PowerShell functions and filters this process defined, by name without case; a call by that name walks its body. */
  readonly functions: Map<string, PsFunction>;
  /** What this process's children inherit; text it runs itself shares it. */
  readonly environment: Environment;
  /** How this bash process reads aliases now; a command reads them as they stood when bash read its line. */
  aliases: Aliases;
  /** A PowerShell process's `$HOME` and `~`, fixed when it starts; undefined when computed. */
  readonly home: string | undefined;
}

// A start environment and a function body never change once made, so a key names them by identity.
const identities = new WeakMap<object, number>();
let identityCount = 0;
function identity(value: object): number {
  let id = identities.get(value);
  if (id === undefined) identities.set(value, (id = identityCount++));
  return id;
}

/** Everything a walk from `state` reads in it: two states with one key walk alike. Each field of ShellState must appear. */
function stateKey(state: ShellState): string {
  const place = (p: Place): unknown => [p.dir, p.stack, p.previous === null ? null : [...p.previous], p.exits];
  const fields: { readonly [K in keyof ShellState]-?: unknown } = {
    places: state.places?.map(place) ?? null,
    seen: state.seen === undefined ? null : [...state.seen.values()].map(place),
    scattered: state.scattered,
    env: [...state.env].map(([name, values]) => [name, [...values]]),
    traps: [state.traps.exit, state.traps.repeating.map((trap) => [trap.condition ?? null, trap.action])],
    firing: [...state.firing].map((trap) => [trap.condition ?? null, trap.action]),
    depth: state.depth,
    constants: [...state.constants],
    bindings: [...state.bindings],
    functions: [...state.functions].map(([name, body]) => [name, identity(body)]),
    environment: [identity(state.environment.start), [...state.environment.changes], state.environment.known],
    aliases: [[...state.aliases.table], state.aliases.expand ?? null, state.aliases.posix ?? null],
    home: state.home ?? null,
  };
  return JSON.stringify(fields);
}

/**
 * What bash's alias expansion reads: the aliases the text defined, each undefined where the text does not prove whether
 * or how it is defined, whether expansion is on, and whether POSIX mode is; undefined where the text does not give it.
 * Defined only by text the check reads: an alias a sourced or startup file defines is not read, as the file is not.
 */
interface Aliases {
  readonly table: ReadonlyMap<string, string | undefined>;
  readonly expand: boolean | undefined;
  readonly posix: boolean | undefined;
}

/** How bash reads the aliases of a text: as they stood when it read the line, less those whose text this is, which it never expands again. */
interface AliasReading {
  readonly aliases: Aliases;
  readonly expanding: ReadonlySet<string>;
}

const NO_ALIASES: Aliases = { table: new Map(), expand: false, posix: false };
const UNREAD_ALIASES: Aliases = { table: new Map(), expand: undefined, posix: undefined };

/** `aliases` once the shell option turns on or off, undefined when the text does not say which; leaving POSIX mode turns expansion off. */
function withOption(aliases: Aliases, option: 'posix' | 'expand_aliases', on: boolean | undefined): Aliases {
  return option === 'posix' ? { ...aliases, posix: on, expand: on } : { ...aliases, expand: on };
}

/** True when either holds, false when neither can, undefined otherwise. */
function either(a: boolean | undefined, b: boolean | undefined): boolean | undefined {
  return a === true || b === true ? true : a === false && b === false ? false : undefined;
}

/**
 * How a bash started with `environment` reads aliases: a POSIX shell, POSIXLY_CORRECT and SHELLOPTS' posix put it in
 * POSIX mode, which expands them, as BASHOPTS' expand_aliases does.
 */
function startingAliases(environment: Environment, posixShell: boolean): Aliases {
  // Bash reads each by its exact name; a value the text does not give may hold anything.
  const given = (name: string, holds: (value: string) => boolean): boolean | undefined => {
    const entry = environmentEntry(environment, environmentKey(name));
    if (entry === undefined || (entry.name !== undefined && entry.name !== name)) return false;
    return entry.value === undefined ? undefined : holds(entry.value);
  };
  const posix = either(either(posixShell, given('POSIXLY_CORRECT', () => true)), given('SHELLOPTS', (value) => value.split(':').includes('posix')));
  return { table: new Map(), posix, expand: either(posix, given('BASHOPTS', (value) => value.split(':').includes('expand_aliases'))) };
}

/** What two alias states agree on, where a change may or may not have run; the rest unread. */
function joinAliases(a: Aliases, b: Aliases): Aliases {
  const table = new Map<string, string | undefined>();
  for (const name of new Set([...a.table.keys(), ...b.table.keys()])) {
    const text = a.table.get(name);
    table.set(name, a.table.has(name) && b.table.has(name) && text === b.table.get(name) ? text : undefined);
  }
  return { table, expand: a.expand === b.expand ? a.expand : undefined, posix: a.posix === b.posix ? a.posix : undefined };
}

/** The aliases after `shopt` with `words`: -s or -u with expand_aliases, or with -o and posix; a computed word may change either. */
function shoptAliases(words: ReadonlyArray<string | undefined>, aliases: Aliases): Aliases {
  const flags = new Set<string>();
  let k = 1;
  for (; k < words.length; k++) {
    const word = words[k];
    if (word === undefined) return withOption(aliases, 'posix', undefined);
    if (word === '--') {
      k++;
      break;
    }
    if (!/^-[a-z]+$/.test(word)) break;
    for (const flag of word.slice(1)) flags.add(flag);
  }
  // Neither sets anything: without -s or -u shopt prints, and with both it refuses.
  if (flags.has('s') === flags.has('u')) return aliases;
  const option = flags.has('o') ? 'posix' : 'expand_aliases';
  const operands = words.slice(k);
  if (operands.includes(undefined)) return withOption(aliases, option, undefined);
  return operands.includes(option) ? withOption(aliases, option, flags.has('s')) : aliases;
}

/** The aliases after `set` with `words`: `-o posix` and `+o posix`; a computed word may change them. */
function setAliases(words: ReadonlyArray<string | undefined>, aliases: Aliases): Aliases {
  let result = aliases;
  for (let k = 1; k < words.length; k++) {
    const word = words[k];
    if (word === undefined) return withOption(result, 'posix', undefined);
    if (word === '--' || word === '-' || !/^[-+]/.test(word)) break;
    // `-o` anywhere in a cluster takes the next word; without one, set lists the options.
    if (!word.slice(1).includes('o') || k + 1 >= words.length) continue;
    const option = words[++k];
    if (option === undefined) return withOption(result, 'posix', undefined);
    if (option === 'posix') result = withOption(result, 'posix', word.startsWith('-'));
  }
  return result;
}

/** How a command stands in its text: its words as parsed, each undefined where an expansion gives it, and whether it runs exactly once where it stands. */
interface CommandWords {
  readonly written: ReadonlyArray<string | undefined>;
  readonly once: boolean;
}

/** Whether bash may read some command word differently under `a` than under `b`. */
function aliasesDiffer(a: Aliases, b: Aliases): boolean {
  if (a.table.size === 0 && b.table.size === 0) return false;
  return a.expand !== b.expand || a.table.size !== b.table.size || [...a.table].some(([name, text]) => !b.table.has(name) || b.table.get(name) !== text);
}

/**
 * A state for code that runs apart from `state`'s shell, so none of its changes come back: copies of its variables,
 * functions and directory stack, the environment it inherits, and no traps or jump; `overrides` give what a child
 * starts with instead. Text the shell runs itself (eval, a trap, Invoke-Expression) takes `state` itself.
 */
function fork(state: ShellState, overrides: Partial<ShellState> = {}): ShellState {
  const places = 'places' in overrides ? overrides.places : state.places;
  return {
    places,
    seen: seenOf(places),
    scattered: false,
    env: new Map(state.env),
    traps: noTraps(),
    firing: new Set(),
    depth: state.depth,
    constants: new Map(state.constants),
    bindings: new Map(state.bindings),
    functions: new Map(state.functions),
    environment: inherit(state.environment),
    aliases: state.aliases,
    home: state.home,
    ...overrides,
  };
}

/** A new process `state`'s process starts in `places` with `env`: of this one's state it keeps only the environment it exports. */
function spawned(state: ShellState, places: Place[] | undefined, env: Env, environment: Environment = inherit(state.environment)): ShellState {
  return fork(state, { places, env: new Map(env), depth: state.depth + 1, constants: new Map(), bindings: new Map(), functions: new Map(), environment, aliases: UNREAD_ALIASES });
}

/** A new PowerShell process, as `spawned` starts it, whose `$HOME` and `~` are `home`. */
function spawnedPowershell(state: ShellState, places: Place[] | undefined, home: string | undefined, env: Env = state.env): ShellState {
  return { ...spawned(state, places, env), home };
}

/** An environment variable of a process. */
interface EnvEntry {
  /** The spelling a Bash process reads it under; undefined once two spellings of one Windows name met. */
  readonly name: string | undefined;
  /** Undefined when computed. */
  readonly value: string | undefined;
  /** The defining site that set it; absent for a value the process started with, which reads only while its name has no site. */
  readonly site?: string;
}

/** A process's exported environment, keyed by `environmentKey`: the run's starting one, then what the text changed. */
interface Environment {
  readonly start: ReadonlyMap<string, EnvEntry>;
  readonly changes: Map<string, EnvEntry>;
  /** False after a barrier, when every name without a change may hold anything. */
  known: boolean;
}

/** The key an environment variable is stored under: Windows keeps one variable per name without case. */
function environmentKey(name: string): string {
  return process.platform === 'win32' ? name.toUpperCase() : name;
}

function environmentEntry(environment: Environment, key: string): EnvEntry | undefined {
  return environment.changes.get(key) ?? (environment.known ? environment.start.get(key) : { name: undefined, value: undefined });
}

// Variables MSYS2 rewrites to POSIX form when Git Bash imports them on Windows.
const MSYS_CONVERTED = /^(?:PATH|HOME|TMP|TEMP|TMPDIR)$/;

/** The value a Bash process on Windows imports: one drive path in POSIX form, and any other converted value computed. */
function msysImport(name: string, value: string): string | undefined {
  return process.platform !== 'win32' || !MSYS_CONVERTED.test(name) || !/[\\;]/.test(value) ? value : bashPath(value);
}

/** A native path as Git Bash spells it on Windows, `/c/...`; undefined for one without a drive. */
function bashPath(native: string): string | undefined {
  if (process.platform !== 'win32') return native;
  const drive = /^([A-Za-z]):[\\/]([^;]*)$/.exec(native);
  return drive ? `/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/g, '/')}` : undefined;
}

/** A child's environment: its parent's exported entries at the spawn point. */
function inherit(environment: Environment): Environment {
  return { start: environment.start, changes: new Map(environment.changes), known: environment.known };
}

/** An environment a process gets from somewhere the text does not show. */
function unknownEnvironment(): Environment {
  return { start: new Map(), changes: new Map(), known: false };
}

/**
 * What a reference reads: a Bash variable, a constant or else the inherited variable of exactly its name; an environment
 * variable by its name alone, never a constant (PowerShell's `$env:NAME`, cmd's `%NAME%`); or a plain PowerShell
 * variable, only ever a constant.
 */
type VariableKind = 'bash' | 'environment' | 'powershell';

/** A value set by the defining assignment at `site`, which reads only while that stays its name's one site. */
interface Constant {
  readonly value: string;
  readonly site: string;
}

/** One pass's value reading (docs/worktree-isolation.md "Value reading"). */
interface Reading {
  readonly resolving: boolean;
  /** Every site found so far in the run, by name key (`siteKey`), each as `textId:offset`. */
  readonly sites: Map<string, Set<string>>;
  poisoned: boolean;
  /** The name keys a read took a value for, or took as set from outside the command, and `IFS` once a word was split. */
  readonly resolved: Set<string>;
  /** A read name gained a site, or a poison came, after the read. */
  invalid: boolean;
  /** A script block that may run later (`PsRange.later`) was walked, so a later barrier cannot be placed before every read it should precede. */
  deferred: boolean;
}

/** A walked bash text: its id, which keys its sites, and whether its top-level assignments define values. */
interface BashText {
  readonly id: number;
  readonly defining: boolean;
}

/** How a range walk takes each segment, and each loop: `body` and `header` walk its parts, `inner` are the loops inside it. */
interface RangeWalker<L extends LoopRange> {
  step(k: number): string | undefined;
  loop(found: L, body: () => string | undefined, header: () => string | undefined, inner: readonly L[]): string | undefined;
}

/** Ranges in the order a range walk meets them, outer first; the sort is stable, so ranges over the same segments keep their order. */
function byNesting<L extends LoopRange>(ranges: L[]): L[] {
  return ranges.sort((a, b) => a.head - b.head || b.end - a.end);
}

class IsolationRun {
  private readonly iso: WorktreeIsolation;
  private readonly canonical = new Map<string, string>();
  private readonly forms = new Map<string, readonly string[]>();
  // Paths a check reads share their prefixes, so the file system is read once per path for the whole check.
  private readonly paths = rememberedPathQueries();
  private areas: { working: readonly string[]; edits: readonly Area[]; git: readonly Area[] } | undefined;
  private reading: Reading = { resolving: false, sites: new Map(), poisoned: false, resolved: new Set(), invalid: false, deferred: false };
  private readonly textIds = new Map<string, number>();
  private readonly scans = new Map<(text: string) => TextScan, Map<string, TextScan>>();
  /**
   * The starting environment's entries, the possible values it gives the variables git and cd read, and the environment value
   * Bash's starting HOME comes from, built once per run.
   */
  private start: { readonly entries: ReadonlyMap<string, EnvEntry>; readonly env: Env; readonly home: string | undefined } | undefined;
  /** Lower-cased pieces of every starting-environment value a reference read, which a reason must not quote. */
  private readonly secrets = new Set<string>();
  /** The command text as written, lower-cased: a piece of it is no secret. */
  private readonly written: string;
  /** The loop and function body walks of the current pass. */
  private loopWalks = 0;
  /** How many walks of segment ranges hold the current one. */
  private nesting = 0;
  /** Each shell state's key when its repeating traps last closed it, in the current pass. */
  private closures = new WeakMap<ShellState, string>();
  /** How many changes so far may have dropped a place the shell stood in (`narrow`). */
  private narrowings = 0;
  /** The current pass had more places than MAX_PLACES, or a loop that did not settle, somewhere. */
  private grown = false;
  /** The starting git variables the current pass has checked, as `NAME=value`, or `NAME` for a computed one. */
  private readonly startChecked = new Set<string>();
  /** Each `[IO.Path]::Combine(...)` token's argument statement, scanned once per run; undefined when unreadable. */
  private readonly combineArguments = new Map<string, PsSegment | undefined>();
  /** Each bash text's structure, parsed once per run. */
  private readonly bashParses = new Map<string, ShellStructure>();
  /** Each PowerShell text's statements and script blocks, scanned once per run; undefined when unreadable. */
  private readonly psParses = new Map<string, { readonly segments: readonly PsSegment[]; readonly ranges: readonly PsRange[] } | undefined>();
  /** Each cmd line's reading, with the variables in the order the parse looked them up and what each gave it. */
  private readonly cmdParses = new Map<string, Array<{ readonly lookups: ReadonlyArray<readonly [string, CmdVariable]>; readonly parsed: CmdLine | CmdBlocked }>>();

  constructor(iso: WorktreeIsolation, written = '') {
    this.iso = iso;
    this.written = written.toLowerCase();
  }

  /**
   * The tool's own shell: Bash starts behind a barrier when BASH_ENV names a startup file, WSL's bash in an environment
   * the text does not give, and PowerShell runs -NoProfile.
   */
  initialState(shell: ToolShell | 'powershell'): ShellState {
    const start = this.startEnvironment();
    const wsl = shell === 'wsl';
    const environment: Environment = wsl ? unknownEnvironment() : { start: start.entries, changes: new Map(), known: true };
    // Bash keeps an OLDPWD it starts with, which the text does not give; without one, `cd -` fails.
    const previous = environmentEntry(environment, environmentKey('OLDPWD')) === undefined ? new Set([undefined]) : null;
    const places: Place[] = [{ dir: this.iso.workingFolder, stack: [], previous, exits: EITHER }];
    const state: ShellState = {
      places,
      seen: seenOf(places),
      scattered: false,
      env: wsl ? new Map() : new Map(start.env),
      traps: noTraps(),
      firing: new Set(),
      depth: 0,
      constants: new Map(),
      bindings: new Map(),
      functions: new Map(),
      environment,
      // sh, dash and ash run in POSIX mode.
      aliases: shell === 'powershell' ? NO_ALIASES : startingAliases(environment, this.iso.shellPath !== undefined && commandName(this.iso.shellPath) !== 'bash'),
      home: this.iso.homeDir,
    };
    if (shell === 'bash' && this.startsBehindBarrier(state.environment, state.env)) this.barrier(state);
    return state;
  }

  private startEnvironment(): NonNullable<IsolationRun['start']> {
    if (this.start !== undefined) return this.start;
    const entries = new Map<string, EnvEntry>();
    const env: Env = new Map();
    for (const [name, value] of Object.entries(this.iso.environment)) {
      const key = environmentKey(name);
      // Two spellings of one Windows name: which one the shell keeps is not known.
      entries.set(key, entries.has(key) ? { name: undefined, value: undefined } : { name, value });
      if (targetVariable(envName(name))) widen(env, envName(name), entries.get(key)!.value);
    }
    // Git Bash without HOME uses the profile folder, which Windows gives as USERPROFILE.
    const home = entries.get(environmentKey('HOME'));
    const value = home === undefined ? this.iso.homeDir : home.name === 'HOME' ? home.value : undefined;
    env.set('HOME', new Set([value === undefined ? undefined : msysImport('HOME', value)]));
    const source = home === undefined ? (process.platform === 'win32' ? entries.get(environmentKey('USERPROFILE')) : undefined) : home;
    this.start = { entries, env, home: source?.value };
    return this.start;
  }

  /**
   * A pass reading values optimistically; when a text walked later invalidates it, a pass from its sites and poisons;
   * when that is invalid too, a pass with reading off decides. A block from any pass stands.
   */
  check(walk: () => string | undefined): string | undefined {
    for (let pass = 0; ; pass++) {
      const previous = this.reading;
      this.reading = {
        resolving: pass < 2,
        sites: new Map([...previous.sites].map(([key, sites]) => [key, new Set(sites)])),
        poisoned: previous.poisoned,
        resolved: new Set(),
        invalid: false,
        deferred: false,
      };
      this.loopWalks = 0;
      this.closures = new WeakMap();
      this.grown = false;
      this.startChecked.clear();
      const blocked = walk();
      if (blocked !== undefined || !this.reading.invalid || pass === 2) return blocked;
    }
  }

  /** Registers a walked text's sites and poisons, scanned once per text; returns the text's id, which keys its sites. */
  private walked(text: string, scan: (text: string) => TextScan): number {
    let id = this.textIds.get(text);
    if (id === undefined) {
      id = this.textIds.size;
      this.textIds.set(text, id);
    }
    let cache = this.scans.get(scan);
    if (cache === undefined) this.scans.set(scan, (cache = new Map()));
    let found = cache.get(text);
    if (found === undefined) cache.set(text, (found = scan(text)));
    for (const { key, offset } of found.sites) this.addSite(key, `${id}:${offset}`);
    if (found.poisoned) this.poison();
    return id;
  }

  /** A place that can set the variable `key` names; one found after a read of that name invalidates the pass. */
  private addSite(key: string, site: string): void {
    let sites = this.reading.sites.get(key);
    if (sites === undefined) this.reading.sites.set(key, (sites = new Set()));
    if (sites.has(site)) return;
    sites.add(site);
    if (this.reading.resolved.has(key)) this.reading.invalid = true;
  }

  /** Something that can set a variable by a name the text does not show: no value reads for the rest of the run. */
  private poison(): void {
    if (this.reading.poisoned) return;
    this.reading.poisoned = true;
    if (this.reading.resolved.size > 0) this.reading.invalid = true;
  }

  /** Code the text does not show runs in this process: no value set before it reads after it. */
  private barrier(state: ShellState): void {
    state.constants.clear();
    state.bindings.clear();
    state.aliases = withOption(state.aliases, 'posix', undefined);
    this.environmentBarrier(state);
    this.stand(state, state.places?.map((place) => ({ ...place, previous: null })));
  }

  /** Sets the places `state`'s shell may stand in, past MAX_PLACES none it can read, and records them as stood in. */
  private stand(state: ShellState, places: Place[] | undefined): void {
    // Every caller that leaves the places unknown on purpose sets them directly (`lose`).
    if (state.places !== undefined && (places === undefined || places.length > MAX_PLACES)) this.grown = true;
    state.places = places === undefined || places.length > MAX_PLACES ? undefined : places;
    if (state.places === undefined || state.seen === undefined) return;
    for (const place of state.places) {
      const key = placeKey(place);
      const found = state.seen.get(key);
      state.seen.set(key, found === undefined ? { ...place, exits: EITHER } : { ...found, previous: joinPrevious(found.previous, place.previous) });
    }
    if (state.seen.size > MAX_PLACES) state.seen = undefined;
  }

  /** The block for a working directory that cannot be read, saying how to keep a loop's places few when one grew them. */
  private unreadDirectory(detail = UNREAD_DIRECTORY, powershell = false): string {
    return this.block(this.grown ? `${detail} ${powershell ? GROWN_POWERSHELL : GROWN_BASH}` : detail);
  }

  /** `state`'s places joined with every place its process has stood in. */
  private withSeen(state: ShellState): Place[] | undefined {
    return state.places === undefined || state.seen === undefined ? undefined : joinPlaces(state.places, eitherExit([...state.seen.values()]));
  }

  /** A change that may drop a place the shell stood in from its places, which a loop's exit must then take from those seen. */
  private narrow(state: ShellState, places: Place[] | undefined): void {
    this.narrowings++;
    this.stand(state, places);
  }

  /** The directory stack's entries, unless the text may set DIRSTACK, which changes them. */
  private stackReadable(): boolean {
    this.reading.resolved.add(siteKey('DIRSTACK'));
    return !this.reading.poisoned && !this.reading.sites.has(siteKey('DIRSTACK'));
  }

  /** Code the text does not show changes this process's environment: no inherited or exported value reads after it. */
  private environmentBarrier(state: ShellState): void {
    state.environment.changes.clear();
    state.environment.known = false;
    widen(state.env, 'HOME', undefined);
  }

  /**
   * Whether a non-interactive shell with this environment runs a startup file before its text: BASH_ENV is set. Only an
   * interactive shell reads ENV, and `-i` is a barrier already.
   */
  private startsBehindBarrier(environment: Environment, env: Env): boolean {
    return environmentEntry(environment, environmentKey('BASH_ENV')) !== undefined || env.has(envName('BASH_ENV'));
  }

  /**
   * The value `name` holds in `state`'s process here, when the text proves it; `key` is its site key and `kind` what
   * the reference names. Bash's HOME and PWD, and PowerShell's `$HOME` and `$PWD`, are the shell's own; Bash's
   * HOME is read from `env`.
   */
  private lookup(state: ShellState, name: string, key: string, kind: VariableKind, env: Env = state.env): string | undefined {
    const reading = this.reading;
    if (!reading.resolving || reading.poisoned) return undefined;
    if (kind === 'bash' && name === 'HOME') return this.home(env);
    if ((kind === 'bash' && name === 'PWD') || (kind === 'powershell' && name === 'pwd')) return this.currentDirectory(state, kind === 'bash');
    // PowerShell's `$HOME` is read-only and fixed when the process starts: assigning it fails.
    if (kind === 'powershell' && name === 'home') return state.home;
    const sites = reading.sites.get(key);
    const read = (value: string | undefined, site: string | undefined): string | undefined => {
      if (value === undefined || (site === undefined ? sites !== undefined : sites?.size !== 1 || !sites.has(site))) return undefined;
      reading.resolved.add(key);
      return value;
    };
    const constant = kind === 'environment' ? undefined : state.bindings.get(name) ?? state.constants.get(name);
    if (constant !== undefined || kind === 'powershell') return read(constant?.value, constant?.site);
    const entry = environmentEntry(state.environment, environmentKey(name));
    // Bash reads an unset variable as empty; PowerShell binds a missing `$env:` value as $null, unlike ''.
    if (entry === undefined) return kind === 'bash' ? read('', undefined) : undefined;
    if (entry.name === undefined || (kind === 'bash' && entry.name !== name)) return undefined;
    const imported = kind === 'bash' && entry.value !== undefined ? msysImport(name, entry.value) : entry.value;
    const value = read(imported, entry.site);
    if (value !== undefined && entry.site === undefined) this.secret(entry.value!);
    return value;
  }

  /**
   * Bash's HOME in `env` when it can hold only one value, which `~` and an operand-less cd read with value reading
   * off too. Arithmetic can assign it unseen, so a poison makes it computed.
   */
  private home(env: Env): string | undefined {
    this.reading.resolved.add(HOME_READ);
    const values = env.get('HOME');
    if (this.reading.poisoned || values?.size !== 1) return undefined;
    const [value] = values;
    // Bash never expands a `~` its value starts with.
    if (value === undefined || value.startsWith('~')) return undefined;
    const start = this.startEnvironment();
    if (start.home !== undefined && start.env.get('HOME')?.has(value)) this.secret(start.home);
    return value;
  }

  /**
   * The home of a PowerShell process `state`'s process starts: the USERPROFILE it inherits on Windows, HOME elsewhere. A
   * value the run never sets gives the profile folder, a value it sets reads as any inherited value does, and undefined
   * when computed. Changing the variable later in the running process does not move it.
   */
  private psHome(state: ShellState): string | undefined {
    const name = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const key = siteKey(name);
    this.reading.resolved.add(key);
    if (this.reading.poisoned) return undefined;
    if (!this.reading.sites.has(key)) return state.environment.known ? this.iso.homeDir : undefined;
    return this.lookup(state, name, key, 'environment');
  }

  /** The shell's current directory, as Bash or PowerShell spells it, when only one is possible and nothing sets PWD. */
  private currentDirectory(state: ShellState, bash: boolean): string | undefined {
    this.reading.resolved.add(siteKey('PWD'));
    const dirs = state.places === undefined ? [] : directories(state.places);
    if (this.reading.sites.has(siteKey('PWD')) || dirs.length !== 1) return undefined;
    return bash ? bashPath(dirs[0]!) : dirs[0];
  }

  /**
   * Keeps a starting-environment value out of reasons: each run of letters and digits in it, also once a parse drops its
   * quotes and backslashes. A run under 3 characters, or one the command text holds, discloses nothing and stays shown.
   */
  private secret(value: string): void {
    const lowered = value.toLowerCase();
    for (const form of [lowered, lowered.replace(/['"`\\]/g, '')]) {
      for (const piece of form.split(/[^\p{L}\p{N}]+/u)) if (piece.length >= 3 && !this.written.includes(piece)) this.secrets.add(piece);
    }
  }

  /** Whether a word a reason would name repeats a piece of a starting-environment value. */
  private repeatsSecret(word: string): boolean {
    const lowered = word.toLowerCase();
    return [...this.secrets].some((piece) => lowered.includes(piece));
  }

  /** `name` exported with `value`, undefined when computed, by the defining site `site`. */
  private export(state: ShellState, name: string, value: string | undefined, site: string): void {
    const key = environmentKey(name);
    const existing = environmentEntry(state.environment, key);
    state.environment.changes.set(key, { name: existing === undefined || existing.name === name ? name : undefined, value, site });
  }

  /** Whether a Bash variable is in its process's environment, so an assignment to it is exported. */
  private inherited(state: ShellState, name: string): boolean {
    return environmentEntry(state.environment, environmentKey(name))?.name === name;
  }

  /** A string detail holds no word the command or a value gave; such a word comes as a `Worded`, dropped when it repeats a secret. */
  private block(detail: string | Worded): string {
    return reason(this.iso, typeof detail === 'string' ? detail : this.repeatsSecret(detail.word) ? detail.withoutWord : detail.detail);
  }

  private canonicalOf(p: string): string {
    let resolved = this.canonical.get(p);
    if (resolved === undefined) {
      resolved = canonicalPath(p, this.paths);
      this.canonical.set(p, resolved);
    }
    return resolved;
  }

  // Both the link-resolved and the as-spelled forms, so a link, junction, 8.3 name or `\\?\` prefix lands on one of them.
  private formsOf(p: string): readonly string[] {
    let result = this.forms.get(p);
    if (result === undefined) {
      result = [...new Set([this.canonicalOf(p), spelledPath(p, this.paths), path.resolve(p)])];
      this.forms.set(p, result);
    }
    return result;
  }

  private protectedAreas(): NonNullable<IsolationRun['areas']> {
    if (this.areas === undefined) {
      const other: Area = { name: OTHER_WORKTREE, roots: this.iso.otherWorktrees.flatMap((p) => this.formsOf(p)) };
      const project: Area = { name: PROJECT_FOLDER, roots: this.formsOf(this.iso.projectPath) };
      this.areas = {
        working: this.formsOf(this.iso.workingFolder),
        edits: [other, project],
        git: [other, project, { name: PROJECT_REPOSITORY, roots: this.formsOf(this.iso.repositoryRoot) }],
      };
    }
    return this.areas;
  }

  /** The area `target` lies in, outside the working folder, or undefined. */
  private lands(target: string, areas: readonly Area[], working: readonly string[]): string | undefined {
    for (const form of this.formsOf(target)) {
      if (working.some((root) => folderContains(root, form))) continue;
      const area = areas.find((a) => a.roots.some((root) => folderContains(root, form)));
      if (area) return area.name;
    }
    return undefined;
  }

  landsEdit(target: string): string | undefined {
    const areas = this.protectedAreas();
    return this.lands(target, areas.edits, areas.working);
  }

  /** The area a shell target lies in, also as Win32 opens it for a native program. */
  private landsGit(target: string): string | undefined {
    const areas = this.protectedAreas();
    const opened = process.platform === 'win32' ? win32Trimmed(target) : target;
    return this.lands(target, areas.git, areas.working) ?? (opened === target ? undefined : this.lands(opened, areas.git, areas.working));
  }

  /**
   * A path the OS opens or changes to: each `..` leaves the directory the prefix really is, through any link. `home` is
   * where a leading `~` goes, none for a path bash already expanded.
   */
  private physicalPath(text: string, cwd: string, home: string | undefined): string {
    const p = shellPathText(text, home, process.platform);
    const lexical = path.resolve(cwd, p);
    const separators = process.platform === 'win32' ? /[\\/]+/ : /\/+/;
    if (!p.split(separators).includes('..')) return lexical;
    // A drive-relative path names another drive's working directory, which the text does not give.
    if (process.platform === 'win32' && /^[A-Za-z]:(?![\\/])/.test(p)) return lexical;
    const root = path.parse(p).root;
    let current = path.isAbsolute(p) ? path.parse(lexical).root : this.canonicalOf(cwd);
    for (const segment of p.slice(root.length).split(separators)) {
      if (segment === '' || segment === '.') continue;
      current = segment === '..' ? path.dirname(this.canonicalOf(current)) : path.join(current, segment);
    }
    return current;
  }

  /**
   * A whole shell script: its commands, then the traps it set, which run where the shell has moved by then. `text` is the
   * script's own text when the process runs it, absent for a substitution, whose text is part of a walked one. `reading`
   * is how bash reads its aliases when it read the text before it ran it, absent when it reads each line as it comes.
   */
  script(structure: ShellStructure, state: ShellState, text?: string, reading?: AliasReading): string | undefined {
    return this.bash(structure, state, text === undefined ? undefined : { text, defining: true }, reading) ?? this.exitTraps(state);
  }

  /**
   * Where a shell exits: its repeating traps may run after its last command, then each EXIT action it set runs, from any
   * place it stood in; an EXIT trap an action sets runs after it.
   */
  private exitTraps(state: ShellState): string | undefined {
    const repeated = this.repeatTraps(state);
    if (repeated) return repeated;
    for (let runs = 0; state.traps.exit.length > 0; runs++) {
      if (runs >= MAX_TRAP_RUNS) return this.block('The command sets too many traps to read its git target.');
      // The shell may exit, by `exit` or an error, wherever it has stood.
      this.stand(state, this.withSeen(state));
      const later = this.nested(state.traps.exit.shift()!, state);
      if (later) return later;
    }
    return undefined;
  }

  /**
   * Each repeating trap not running now may run any number of times before the next command: the places become their
   * closure under its action, walked as a loop body. bash keeps the command's exit status across a trap.
   */
  private repeatTraps(state: ShellState): string | undefined {
    const ready = (): RepeatingTrap[] => state.traps.repeating.filter((trap) => !state.firing.has(trap));
    if (ready().length === 0) return undefined;
    // The closure depends only on the state it starts from and the pass's reading, so a state it closed needs no walk.
    const key = (): string => JSON.stringify([stateKey(state), this.reading.resolving, this.reading.poisoned, this.reading.deferred, [...this.reading.sites.values()].reduce((n, sites) => n + sites.size, 0)]);
    if (state.places !== undefined) state.places = eitherExit(state.places);
    if (this.closures.get(state) === key()) return undefined;
    const blocked = this.fixpoint(state, () => {
      for (const trap of ready()) {
        const fired = this.runTrap(state, [trap], trap.action);
        if (fired) return fired;
      }
      return undefined;
    });
    if (blocked) return blocked;
    if (state.places !== undefined) state.places = eitherExit(state.places);
    this.closures.set(state, key());
    return undefined;
  }

  /** A trap's `action` runs in `state`'s shell; the repeating traps `running` stay off until it ends, the others may run before its commands. */
  private runTrap(state: ShellState, running: readonly RepeatingTrap[], action: string): string | undefined {
    const firing = state.firing;
    state.firing = new Set([...firing, ...running]);
    const blocked = this.nested(action, state);
    state.firing = firing;
    return blocked;
  }

  /** A bash text `state`'s process walks; a `${HOME:=v}` anywhere in it may set HOME. */
  private bashText(text: string, state: ShellState, defining: boolean): BashText {
    if (HOME_DEFAULT.test(text)) widen(state.env, 'HOME', undefined);
    return { id: this.walked(text, bashTextScan), defining };
  }

  /** `text`'s bash structure, parsed once per run. */
  private parsed(text: string): ShellStructure {
    let structure = this.bashParses.get(text);
    if (structure === undefined) this.bashParses.set(text, (structure = parseShellStructure(text)));
    return structure;
  }

  /**
   * Text the current shell runs itself (eval, a trap, an alias's text), so its cd and variables reach the commands after
   * it; `reading` as for `script`.
   */
  private nested(text: string, state: ShellState, reading?: AliasReading): string | undefined {
    state.depth++;
    const blocked = this.bash(this.parsed(text), state, { text, defining: false }, reading);
    state.depth--;
    return blocked;
  }

  /**
   * A new shell process: it starts where this one may be, with this one's exported environment, and none of its changes
   * come back. `startup` when it runs a startup file before its text; BASH_ENV in its environment also makes one.
   * `aliases` gives how it starts reading aliases from the environment it starts with, absent where the shell is not known.
   */
  private childShell(text: string, state: ShellState, env: Env, { cwd, startup = false, aliases }: { cwd?: string; startup?: boolean; aliases?: (environment: Environment) => Aliases } = {}): string | undefined {
    const child = spawned(state, startingPlaces(state.places === undefined ? undefined : [...directories(state.places), ...(cwd === undefined ? [] : [cwd])]), env);
    if (aliases !== undefined) child.aliases = aliases(child.environment);
    if (startup || this.startsBehindBarrier(child.environment, child.env)) this.barrier(child);
    return this.script(this.parsed(text), child, text);
  }

  /**
   * Bash commands run in `state`'s process; `source` is the walked text they are, absent for a substitution's. Each
   * command reads aliases as `reading` gives them, else as they stood when the walk reached its line.
   */
  private bash(structure: ShellStructure, state: ShellState, source: { readonly text: string; readonly defining: boolean } | undefined, reading?: AliasReading): string | undefined {
    if (structure.unparsable) return this.block('The command could not be parsed, so its git target cannot be read.');
    if (state.depth > MAX_DEPTH) return this.block('The command nests too deeply to read its git target.');
    // Scanned only once it parsed, so no scan reads more than MAX_COMMAND_LENGTH characters.
    const text = source === undefined ? undefined : this.bashText(source.text, state, source.defining);
    // A substitution never defines, so its sites only need to count.
    const site = (name: string, offset: number): string => (text === undefined ? `set:${siteKey(name)}` : `${text.id}:${offset}`);
    // bash reads a whole line before it runs any of it, and a loop walked again reads as when it was read.
    const lines = new Map<number, Aliases>();
    const readingOf = (segment: ShellSegment): AliasReading => {
      if (reading !== undefined) return reading;
      let aliases = lines.get(segment.line);
      if (aliases === undefined) lines.set(segment.line, (aliases = state.aliases));
      return { aliases, expanding: new Set() };
    };
    // Outer ranges first: a branch, a subshell and a loop over the same segments are `then ( for ...; done ); fi`.
    const ranges = byNesting<LoopRange & { readonly loop?: ShellLoop; readonly branch?: true }>([
      ...structure.branches.map((branch) => ({ branch: true as const, head: branch.start, start: branch.start, end: branch.end })),
      ...structure.subshells.map((subshell) => ({ head: subshell.start, start: subshell.start, end: subshell.end })),
      ...structure.loops.map((loop) => ({ loop, head: loop.header ?? loop.start, start: loop.start, end: loop.end })),
    ]);
    return this.range(0, structure.segments.length, ranges, {
      step: (k) => this.sequenced(state, structure.segments[k]!, () => this.bashSegment(structure.segments[k]!, state, text, site, readingOf(structure.segments[k]!))),
      loop: (found, body) =>
        found.branch ? this.branch(state, body) : found.loop === undefined ? this.subshell(state, body) : this.bashLoop(found.loop, structure, state, text, site, body, readingOf),
    });
  }

  /** A `( )` subshell: none of the places it moves to come back, and the traps it sets run where it exits. */
  private subshell(state: ShellState, body: () => string | undefined): string | undefined {
    const before = state.places;
    const seen = state.seen;
    const traps = state.traps;
    state.seen = seen === undefined ? undefined : new Map(seen);
    // bash runs none of the shell's EXIT traps here, and keeps its repeating ones under `set -E` and `set -T`.
    state.traps = { exit: [], repeating: [...traps.repeating] };
    const blocked = body() ?? this.exitTraps(state);
    state.places = before === undefined ? undefined : eitherExit(before);
    state.seen = seen;
    state.traps = traps;
    return blocked;
  }

  /**
   * A branch of an `if`, which runs whole or not at all: its commands follow one another, and the places after it join
   * those before it. A jump or an error that leaves it partway is followed as anywhere else.
   */
  private branch(state: ShellState, body: () => string | undefined): string | undefined {
    const before = state.places;
    const blocked = body();
    if (blocked) return blocked;
    if (before === undefined) state.places = undefined;
    else this.stand(state, joinPlaces(state.places, eitherExit(before)));
    return undefined;
  }

  /**
   * One command with the places it may run in: where the command before it succeeded or failed when `guard` is `&&` or
   * `||`, the others staying as they were; one that may not run once there runs everywhere and keeps the places before it
   * too. A command no place runs is checked where the shell may be. Each starts with its exit status not known; a cd and
   * the other location commands set it.
   */
  private sequenced(state: ShellState, { guard, sequential }: { readonly guard?: '&&' | '||'; readonly sequential: boolean }, run: () => string | undefined): string | undefined {
    if (state.scattered) this.stand(state, this.withSeen(state));
    const before = state.places;
    if (before === undefined) return this.repeatTraps(state) ?? run();
    const wanted = !sequential || guard === undefined ? EITHER : guard === '&&' ? SUCCEEDED : FAILED;
    const matching = before.filter((place) => (place.exits & wanted) !== 0);
    const skipped = before.filter((place) => (place.exits & ~wanted & EITHER) !== 0).map((place) => ({ ...place, exits: place.exits & ~wanted & EITHER }));
    state.places = eitherExit(matching.length > 0 ? matching : before);
    // After the guard, since bash keeps the status `&&` and `||` read across a trap.
    const blocked = this.repeatTraps(state) ?? run();
    if (blocked) return blocked;
    this.stand(state, joinPlaces(state.places, skipped, sequential ? [] : eitherExit(before)));
    return undefined;
  }

  /**
   * One bash command, its aliases read as `reading` gives them: its substitutions, then the text an alias of its name
   * gives, or its assignments and the command its words give.
   */
  private bashSegment(segment: ShellSegment, state: ShellState, text: BashText | undefined, site: (name: string, offset: number) => string, reading: AliasReading): string | undefined {
    const substituted = this.substitutions(segment, state, reading);
    if (substituted) return substituted;
    const expanded = this.aliasExpansion(segment, reading);
    if (typeof expanded === 'string') return expanded;
    if (expanded !== undefined) return this.nested(expanded.text, state, expanded.reading);
    const words = segment.words.map((word, k) => word ?? this.bashTemplate(segment.templates[k], state, true));
    const defines = text?.defining === true && segment.unconditional && words.length === 0;
    const localEnv = new Map(state.env);
    const values: Array<string | undefined> = [];
    // Assignments run left to right, so a value may read the one before it.
    for (const { name, value: literal, raw, offset, append, template } of segment.assignments) {
      this.addSite(siteKey(name), site(name, offset));
      const value = literal ?? this.bashTemplate(template, state, false, localEnv);
      const blocked = this.checkEnv(name, value, state, raw);
      if (blocked) return blocked;
      // `+=` appends to a value the env model may not know.
      localEnv.set(envName(name), new Set([append ? undefined : value]));
      values.push(append ? undefined : value);
      if (!defines || append || raw === undefined || value === undefined || !bashReadable(name)) continue;
      state.constants.set(name, { value, site: site(name, offset) });
      if (this.inherited(state, name)) this.export(state, name, value, site(name, offset));
    }
    if (words.length === 0) {
      segment.assignments.forEach(({ name }, k) => widen(state.env, envName(name), values[k]));
      return undefined;
    }
    // A substitution's text runs once in its own shell whenever its command does; text this shell runs itself may not.
    const blocked = this.command(words, localEnv, state, segment.rawWords, { written: segment.words, once: segment.unconditional && (text === undefined || text.defining) });
    if (blocked) return blocked;
    if (text?.defining === true && segment.unconditional) this.exported(segment.rawWords, words, segment.offsets, state, site);
    return undefined;
  }

  /**
   * A command's substitutions, which run before it, each in a subshell with its own variables, directory stack and traps.
   * bash reads a substitution's text as it runs it, and in POSIX mode with the line that holds it.
   */
  private substitutions(segment: ShellSegment, state: ShellState, reading: AliasReading): string | undefined {
    if (segment.substitutions.length === 0) return undefined;
    const { posix } = reading.aliases;
    if (posix === undefined && (reading.expanding.size > 0 || aliasesDiffer(reading.aliases, state.aliases))) {
      return this.block('bash may read the aliases in a substitution as its line was read or as it runs, so the command it runs cannot be read.');
    }
    for (const inner of segment.substitutions) {
      // As a `( )` subshell, it keeps the shell's repeating traps and none of its EXIT traps.
      const traps = { exit: [], repeating: [...state.traps.repeating] };
      const blocked = this.script(inner, fork(state, { depth: state.depth + 1, traps, firing: state.firing }), undefined, posix === true ? reading : undefined);
      if (blocked) return blocked;
    }
    return undefined;
  }

  /**
   * The text a command reads as once bash expands its aliases, as `reading` gives them: each alias's text in place of its
   * word, and the next word's too while a text ends in a blank. Undefined when no alias applies, a reason when bash may or
   * may not expand one or its text is not proven.
   */
  private aliasExpansion(segment: ShellSegment, { aliases, expanding }: AliasReading): { readonly text: string; readonly reading: AliasReading } | string | undefined {
    if (aliases.table.size === 0 || aliases.expand === false) return undefined;
    const texts: string[] = [];
    const names = new Set(expanding);
    let k = 0;
    for (; k < segment.rawWords.length; k++) {
      const word = segment.rawWords[k]!;
      // Only an unquoted literal word is expanded, and never an alias whose text this is.
      if (segment.words[k] !== word || names.has(word) || !aliases.table.has(word)) break;
      const text = aliases.table.get(word);
      if (text === undefined || aliases.expand === undefined) return this.block(`bash may run the alias ${word} here, which this check cannot read.`);
      names.add(word);
      texts.push(text);
      if (!/[ \t]$/.test(text)) {
        k++;
        break;
      }
    }
    if (texts.length === 0) return undefined;
    const assignments = segment.assignments.map(({ name, append, raw }) => `${name}${append ? '+=' : '='}${raw ?? ''}`);
    return { text: [...assignments, ...texts, ...segment.rawWords.slice(k)].join(' '), reading: { aliases, expanding: names } };
  }

  /**
   * A bash loop: a `for` over at most MAX_LOOP_ITEMS items the text gives runs its body once per item, with its
   * variable bound to the item; any other loop is walked until its state settles, with its variable computed.
   */
  private bashLoop(
    loop: ShellLoop,
    structure: ShellStructure,
    state: ShellState,
    text: BashText | undefined,
    site: (name: string, offset: number) => string,
    body: () => string | undefined,
    readingOf: (segment: ShellSegment) => AliasReading,
  ): string | undefined {
    const header = loop.header === undefined ? undefined : structure.segments[loop.header]!;
    const { variable: name, items } = loop;
    const values = header !== undefined && name !== undefined && items !== undefined && items.length <= MAX_LOOP_ITEMS ? items.map((item) => this.bashTemplate(item, state, true)) : undefined;
    if (header === undefined || name === undefined || values === undefined || !allRead(values)) {
      const blocked = header === undefined ? undefined : this.bashSegment(header, state, text, site, readingOf(header));
      return blocked ?? this.fixpoint(state, body);
    }
    const substituted = this.substitutions(header, state, readingOf(header));
    if (substituted) return substituted;
    const at = site(name, header.assignments[0]!.offset);
    this.addSite(siteKey(name), at);
    for (const value of values) {
      if (++this.loopWalks > MAX_LOOP_WALKS) return this.loopBudget();
      const blocked = this.checkEnv(name, value, state);
      if (blocked) return blocked;
      widen(state.env, envName(name), value);
      // A substitution's sites count by name alone, so only a walked text's header can be its variable's one site.
      if (text !== undefined && bashReadable(name)) state.bindings.set(name, { value, site: at });
      const walked = body();
      state.bindings.delete(name);
      if (walked) return walked;
    }
    return undefined;
  }

  /**
   * Walks segments `from` to `to`: a loop of `loops`, in opening order, that begins at a segment by `walker.loop`, which
   * decides how often its parts run, and every other segment by `walker.step`.
   */
  private range<L extends LoopRange>(from: number, to: number, loops: readonly L[], walker: RangeWalker<L>): string | undefined {
    if (this.nesting >= MAX_NESTING) return this.block(`The command nests blocks more than ${MAX_NESTING} deep, more than this check follows, so its git target cannot be read.`);
    this.nesting++;
    try {
      return this.rangeWalk(from, to, loops, walker);
    } finally {
      this.nesting--;
    }
  }

  /** `loops` are sorted by head, then by end descending (`byNesting`), so the cursor `r` only moves forward. */
  private rangeWalk<L extends LoopRange>(from: number, to: number, loops: readonly L[], walker: RangeWalker<L>): string | undefined {
    let r = 0;
    for (let k = from; k < to; ) {
      while (r < loops.length && loops[r]!.head < k) r++;
      // The outermost range opening here: a block in the header of another opens first and starts at the same segment.
      const found = loops[r]?.head === k && loops[r]!.end > k ? loops[r]! : undefined;
      if (found === undefined) {
        const blocked = walker.step(k);
        if (blocked) return blocked;
        k++;
        continue;
      }
      let after = r + 1;
      while (after < loops.length && loops[after]!.head < found.end) after++;
      const inner = loops.slice(r + 1, after).filter((loop) => loop.end <= found.end);
      const blocked = walker.loop(found, () => this.range(found.start, found.end, inner, walker), () => this.range(found.head, found.start, inner, walker), inner);
      if (blocked) return blocked;
      k = found.end;
    }
    return undefined;
  }

  /**
   * A body that may run any number of times, walked until `state`'s signature stops changing; each walk's places
   * join those it started from. One that has not settled within MAX_UNSETTLED_WALKS walks makes the places unknown, and
   * is walked on from there. A loop may stop between any two commands of a walk (a while condition), so when a walk
   * dropped a place it stood in, the places after the loop are every place seen.
   */
  private fixpoint(state: ShellState, body: () => string | undefined): string | undefined {
    const narrowings = this.narrowings;
    let before = this.signature(state);
    for (let walks = 1; ; walks++) {
      if (++this.loopWalks > MAX_LOOP_WALKS) return this.loopBudget();
      const entry = state.places;
      const blocked = body();
      if (blocked) return blocked;
      this.stand(state, joinPlaces(entry, state.places));
      const after = this.signature(state);
      if (after === before) break;
      if (walks === MAX_UNSETTLED_WALKS) {
        state.places = undefined;
        this.grown = true;
      }
      before = walks === MAX_UNSETTLED_WALKS ? this.signature(state) : after;
    }
    if (this.narrowings !== narrowings) this.stand(state, this.withSeen(state));
    return undefined;
  }

  /**
   * What a body walk can change in `state`. Every update keeps the earlier values or only clears, and a walk's places
   * join those before it, so a walk that leaves the signature unchanged changed nothing; the aliases, which a change
   * replaces, count whole.
   */
  private signature(state: ShellState): string {
    return JSON.stringify([
      state.places?.map((place) => [placeKey(place), place.exits, place.previous?.size ?? -1]).sort() ?? -1,
      state.seen?.size ?? -1,
      state.scattered,
      [...state.env].map(([name, values]) => [name, values.size]),
      state.traps.exit,
      state.traps.repeating.map((trap) => [trap.condition ?? null, trap.action]),
      state.constants.size,
      state.bindings.size,
      state.environment.changes.size,
      state.environment.known,
      state.functions.size,
      [...state.aliases.table].sort(),
      state.aliases.expand ?? null,
      state.aliases.posix ?? null,
    ]);
  }

  private loopBudget(): string {
    return this.block('The command repeats loop bodies more often than this check follows, so its git target cannot be read.');
  }

  /** An option-free `export N=V` defines N where an assignment would, when the name and `=` are written plainly. */
  private exported(raws: readonly string[], words: ReadonlyArray<string | undefined>, offsets: readonly number[], state: ShellState, site: (name: string, offset: number) => string): void {
    if (raws[0] !== 'export' || words.slice(1).some((word) => word === undefined || /^[-+]/.test(word))) return;
    for (let k = 1; k < words.length; k++) {
      const name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(raws[k]!)?.[1];
      if (name === undefined || !bashReadable(name)) continue;
      const word = words[k]!;
      const value = word.slice(word.indexOf('=') + 1);
      this.addSite(siteKey(name), site(name, offsets[k]!));
      state.constants.set(name, { value, site: site(name, offsets[k]!) });
      this.export(state, name, value, site(name, offsets[k]!));
    }
  }

  /**
   * A bash word's text with each variable it expands read as its value; `split` when the shell splits and globs
   * the word, where only a value that is one plain word reads. `~` and `$HOME` read HOME from `env`.
   */
  private bashTemplate(template: readonly ShellPart[] | undefined, state: ShellState, split: boolean, env: Env = state.env): string | undefined {
    if (template === undefined) return undefined;
    let text = '';
    for (const part of template) {
      if (typeof part === 'string') {
        text += part;
        continue;
      }
      // Bash neither splits nor globs what `~` expands to.
      if ('tilde' in part) {
        const home = this.home(env);
        if (home === undefined) return undefined;
        text += home;
        continue;
      }
      const value = 'substitution' in part ? this.bashSubstitution(part.substitution, part.body, state, env) : this.bashReference(state, part.variable, env);
      // Bash never tilde-expands a value, which the path readers here would.
      if (value === undefined || value.startsWith('~')) return undefined;
      if (split && !part.quoted) {
        this.reading.resolved.add(IFS_KEY);
        if (value === '' || /[\s*?[(\\]/.test(value) || this.reading.sites.has(IFS_KEY)) return undefined;
      }
      text += value;
    }
    return text;
  }

  /** The value a bash reference reads, HOME from `env`; undefined when computed. */
  private bashReference(state: ShellState, name: string, env: Env): string | undefined {
    const own = name === 'HOME' || name === 'PWD';
    return own || bashReadable(name) ? this.lookup(state, name, siteKey(name), 'bash', env) : undefined;
  }

  /**
   * The text a `$(...)` prints (docs/worktree-isolation.md "Path functions") when its body is one `dirname`,
   * `basename` or `realpath -m` with one readable operand, and no pipe, list or redirection; undefined for any other
   * body. Its words read as the subshell starts, as here.
   */
  private bashSubstitution(structure: ShellStructure, body: string, state: ShellState, env: Env): string | undefined {
    const segment = structure.segments[0];
    if (structure.unparsable || structure.loops.length > 0 || structure.segments.length !== 1 || segment!.assignments.length > 0 || /[<>|&;\n]/.test(body)) return undefined;
    const words = segment!.words.map((word, k) => word ?? this.bashTemplate(segment!.templates[k], state, true, env));
    if (segment!.rawWords[0] !== words[0] || words.length < 2) return undefined;
    // An alias of the name runs its own text.
    if (state.aliases.expand !== false && state.aliases.table.has(words[0]!)) return undefined;
    const [name, ...options] = words.slice(0, -1);
    const operand = words.at(-1);
    if (operand === undefined || operand === '' || operand.startsWith('-') || operand.includes('\n')) return undefined;
    if (options.length === 0 && name === 'dirname') return posixDirname(operand);
    if (options.length === 0 && name === 'basename') return posixBasename(operand);
    const flags = options.join(' ');
    const dirs = state.places === undefined ? [] : directories(state.places);
    if (name !== 'realpath' || !['-m', '-m -s', '-s -m'].includes(flags) || dirs.length !== 1) return undefined;
    // A `~` left in an operand bash expanded is a folder name, which the path readers here would expand.
    if (operand.startsWith('~')) return undefined;
    const [cwd] = dirs;
    const native = flags === '-m' ? this.canonicalOf(this.physicalPath(operand, cwd!, undefined)) : nativeShellPath(operand, cwd!, undefined);
    // Git Bash's realpath prints a drive operand with its drive, and any other in the `/c/...` form.
    return process.platform === 'win32' && /^[A-Za-z]:/.test(operand) ? native.replaceAll('\\', '/') : bashPath(native);
  }

  /**
   * A place that sets `name` which no defining assignment shares, or a poison when the name is computed; either may
   * give `state`'s HOME a value the text does not show.
   */
  private setter(name: string | undefined, state: ShellState): void {
    const variable = name === undefined ? undefined : /^[A-Za-z_][A-Za-z0-9_]*/.exec(name)?.[0];
    if (name === undefined) this.poison();
    else if (variable !== undefined) this.addSite(siteKey(variable), `set:${siteKey(variable)}`);
    if (name === undefined || variable === 'HOME') widen(state.env, 'HOME', undefined);
  }

  /**
   * The text a reference gives a command variable's value, which git's shell parses again: its value when the text
   * proves it, else computed text when nothing in the run can set it (the environment or a startup file gave it, so it is
   * data), else undefined, since the command may have put syntax in it.
   */
  private outside(state: ShellState, name: string): string | undefined {
    const key = siteKey(name);
    const value = this.bashReference(state, name, state.env);
    if (value !== undefined) return value;
    this.reading.resolved.add(key);
    return this.reading.poisoned || this.reading.sites.has(key) || SHELL_SET_VARIABLE.test(name) ? undefined : COMPUTED_TEXT;
  }

  /** A bash assignment's check; `raw` is its value as written, when the text gives it. */
  private checkEnv(name: string, value: string | undefined, state: ShellState, raw?: string): string | undefined {
    return this.gitVariable(envName(name), value, state, raw === undefined ? undefined : () => outsideValueText(raw, (n) => this.outside(state, n)));
  }

  /**
   * The check of a variable either shell sets, where it sets it: a git path, command or configuration variable, or CDPATH.
   * `readComputed` gives the text a computed command variable hands git's shell, when the shell's syntax lets it be read.
   */
  private gitVariable(name: string, value: string | undefined, state: ShellState, readComputed?: () => string | undefined): string | undefined {
    if (GIT_CONFIG_ENV.test(name)) return this.block(`${name} gives git configuration from the environment, which this check cannot follow.`);
    if (!targetVariable(name)) return undefined;
    if (value === undefined) {
      const text = COMMAND_ENV.has(name) && readComputed !== undefined ? readComputed() : undefined;
      return text === undefined ? this.block(`${name} is computed, so the git target cannot be read.`) : this.gitRunsCommand(text, state);
    }
    if (COMMAND_ENV.has(name)) return this.gitRunsCommand(value, state);
    if (value === '') return undefined;
    if (state.places === undefined) return this.unreadDirectory();
    const parts = name === 'CDPATH' || name === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ? value.split(/[:;]/) : [value];
    for (const cwd of directories(state.places)) {
      for (const part of parts) {
        if (part === '') continue;
        // cd takes CDPATH entries as it takes its operand; git opens its paths through the file system.
        const target = name === 'CDPATH' ? nativeShellPath(part, cwd, this.iso.homeDir) : this.physicalPath(part, cwd, this.iso.homeDir);
        const area = this.landsGit(target);
        if (area) return this.block(`${name} points git at ${area}.`);
      }
    }
    return undefined;
  }

  /** Text git hands to a shell, from the working directory or the worktree's top level. */
  private gitRunsCommand(text: string, state: ShellState): string | undefined {
    if (text === '') return undefined;
    // git runs the text with the HOME of its own environment, which a prefix assignment or a later export may change.
    const env = new Map(state.env);
    widen(env, 'HOME', undefined);
    // git runs it with `sh -c`, which is in POSIX mode.
    return this.childShell(text, state, env, { cwd: this.iso.workingFolder, aliases: (environment) => startingAliases(environment, true) });
  }

  /**
   * A command with its words read, in `state`'s shell. `written` gives its words as parsed, each undefined where an
   * expansion gives it, and whether it runs exactly once where it stands; absent, every word counts as expanded and the
   * command as one that may not run.
   */
  private command(words: Array<string | undefined>, env: Env, state: ShellState, rawWords: readonly string[] = [], written?: CommandWords): string | undefined {
    const first = words[0];
    if (first === undefined || first.startsWith('-')) return this.block('The command name is computed, so its git target cannot be read.');
    const name = commandName(first);
    const args = words.slice(1);
    const spelled = rawWords.length > 0 ? rawWords.slice(1) : undefined;
    if (DECLARATION_BUILTINS.has(name)) return this.declare(words, rawWords, state);
    // Arithmetic assigns the names a value holds.
    if (name === 'let' || (name === '[[' && args.some((word) => word !== undefined && ARITHMETIC_TEST.test(word)))) this.poison();
    if (name === 'unset') args.filter((word) => word === undefined || !word.startsWith('-')).forEach((word) => this.setter(word, state));
    if (name === 'wait' || name === 'compgen') {
      const option = name === 'wait' ? '-p' : '-V';
      args.forEach((word, k) => word === option && this.setter(args[k + 1], state));
    }
    if (READERS.has(name)) {
      // These assign the variables they name from input or computed text; printf only through -v.
      const printed = args[0]?.startsWith('-v') ? [args[0] === '-v' ? args[1] : args[0].slice(2)] : [];
      const named = name === 'printf' ? printed : args;
      // mapfile -C evaluates its callback text with each line it reads appended.
      if ((name === 'mapfile' || name === 'readarray') && args.some((word) => word === undefined || /^-\w*C/.test(word))) return this.block(`${name} -C runs callback text with lines it reads, so its git target cannot be read.`);
      for (const word of named) if (word === undefined || !word.startsWith('-')) this.setter(word, state);
      if (named.some((word) => word === undefined || targetVariable(envName(word)))) return this.block(`${name} sets a variable git reads, so its target cannot be read.`);
      return undefined;
    }
    // busybox runs its applet in a process of its own.
    if (name === 'busybox') return args.length > 0 ? this.command(args, env, fork(state), rawWords.slice(1)) : undefined;
    if (first === name && (name === 'alias' || name === 'unalias' || name === 'shopt' || name === 'set')) {
      const blocked = this.aliasChange(name, words, state, written ?? { written: [], once: false });
      if (blocked !== undefined || name !== 'set') return blocked;
    }
    if (name === 'set' && keywordMode(args)) return this.block('set -k reads assignments after a command name, so its git target cannot be read.');
    const wrapperOptions = WRAPPERS.get(name);
    if (wrapperOptions) return this.wrapper(name, wrapperOptions, words, rawWords, env, state);
    if (name === 'eval') {
      if (args.some((w) => w === undefined)) return this.block('eval runs computed text, so its git target cannot be read.');
      return this.nested(args.join(' '), state);
    }
    if (name === 'source' || name === '.') {
      this.barrier(state);
      return this.source(name, args);
    }
    if (name === 'trap') {
      const action = args.find((w) => w === undefined || !w.startsWith('-'));
      if (action === undefined && args.length > 0 && args.some((w) => w === undefined)) return this.block('trap runs computed text, so its git target cannot be read.');
      if (action === undefined) return undefined;
      const { exit, repeating } = state.traps;
      const conditions = args.slice(args.indexOf(action) + 1);
      // A condition that is computed or absent may be EXIT or any other.
      const named = conditions.length === 0 ? [undefined] : conditions.map((w) => w?.toUpperCase());
      if (named.some((condition) => condition === undefined || EXIT_CONDITIONS.has(condition)) && !exit.includes(action)) exit.push(action);
      const set: RepeatingTrap[] = [];
      for (const condition of named.filter((c) => c === undefined || !EXIT_CONDITIONS.has(c))) {
        let trap = repeating.find((t) => t.condition === condition && t.action === action);
        if (trap === undefined) repeating.push((trap = { condition, action }));
        set.push(trap);
      }
      const blocked = this.runTrap(state, set, action);
      if (state.places !== undefined) state.places = eitherExit(state.places);
      return blocked;
    }
    if (name === 'break' || name === 'continue') state.scattered = true;
    if (name === 'find') return this.find(args, env, state);
    // Only the builtin, called by its name, moves this shell; a program of the name runs in a process of its own.
    if (STACK_COMMANDS.has(name)) return this.directoryBuiltin(name, args, env, first === name && name !== 'chdir' ? state : fork(state), spelled);
    return this.program(name, args, env, state, spelled, msysCommandLine);
  }

  /**
   * How `alias`, `unalias`, `shopt` and `set -o` change the way this shell reads aliases. A change that may not run
   * leaves what it changes unread; a reason when no later command can be read.
   */
  private aliasChange(name: string, words: ReadonlyArray<string | undefined>, state: ShellState, { written, once }: CommandWords): string | undefined {
    const before = state.aliases;
    const next =
      name === 'alias' ? this.aliasDefinitions(words, written, before) : name === 'unalias' ? this.aliasRemovals(words, before) : name === 'shopt' ? shoptAliases(words, before) : setAliases(words, before);
    if (typeof next === 'string' || next === before) return typeof next === 'string' ? next : undefined;
    // A trap reads its text when it runs, which may be on either side of the change.
    if (state.traps.exit.length + state.traps.repeating.length > 0 && (next.table.size > 0 || before.table.size > 0)) return this.block('The aliases change while a trap is set, so the command the trap runs cannot be read.');
    state.aliases = once ? next : joinAliases(before, next);
    return undefined;
  }

  /** The aliases after `alias` with `words`, `written` as parsed; a definition by computed text, or of a reserved word, blocks. */
  private aliasDefinitions(words: ReadonlyArray<string | undefined>, written: ReadonlyArray<string | undefined>, aliases: Aliases): Aliases | string {
    const option = words[1];
    if (option !== undefined && option !== '--' && /^-./.test(option)) {
      // An option bash refuses defines nothing; -p lists the aliases, and whether it then defines its operands differs by version.
      if (option !== '-p') return aliases;
      return words.slice(2).some((word) => word === undefined || word.includes('=')) ? this.block('alias -p may or may not define its operands, so the command a later alias runs cannot be read.') : aliases;
    }
    const table = new Map(aliases.table);
    for (let k = option === '--' ? 2 : 1; k < words.length; k++) {
      const word = words[k];
      if (word === undefined || (written[k] === undefined && word.includes('='))) return this.block('alias defines an alias by computed text, so the command it runs cannot be read.');
      const eq = word.indexOf('=');
      const alias = word.slice(0, Math.max(eq, 0));
      // Without `=` it prints the alias; bash refuses a name with these characters and defines nothing for it.
      if (alias === '' || ALIAS_NAME_REFUSED.test(alias)) continue;
      if (BASH_RESERVED.has(alias)) return this.block(`alias ${alias} renames a reserved word, which changes how the text parses, so its git target cannot be read.`);
      const text = word.slice(eq + 1);
      // Text over more than one line defines and runs commands between its lines, which this reading does not order.
      table.set(alias, text.includes('\n') ? undefined : text);
    }
    return { ...aliases, table };
  }

  /** The aliases after `unalias` with `words`: -a removes every one; a computed name blocks. */
  private aliasRemovals(words: ReadonlyArray<string | undefined>, aliases: Aliases): Aliases | string {
    const table = new Map(aliases.table);
    for (let k = 1; k < words.length; k++) {
      const word = words[k];
      if (word === undefined) return this.block('unalias names a computed alias, so the command a later alias runs cannot be read.');
      if (k === 1 && word === '--') continue;
      if (k === 1 && /^-./.test(word)) {
        // An option bash refuses removes nothing.
        if (!/^-a+$/.test(word)) return aliases;
        table.clear();
        continue;
      }
      table.delete(word);
    }
    return { ...aliases, table };
  }

  /** Bash's cd, pushd, popd and dirs in `state`'s shell. */
  private directoryBuiltin(name: string, args: Array<string | undefined>, env: Env, state: ShellState, spelled: Spelled | undefined): string | undefined {
    if (name === 'dirs') {
      if (args.some((w) => w === undefined)) return this.lose(state);
      // dirs -c clears the stack; its other options only print it.
      if (args.some((w) => /^-\w*c/.test(w!))) this.narrow(state, state.places?.map((place) => ({ ...place, stack: [] })));
      return undefined;
    }
    // popd -n and popd +N or -N remove an entry without changing to it.
    if (name === 'popd') return args.length > 0 ? this.lose(state) : this.popLocation(state, 'bash');
    if (name === 'pushd' && args.some((w) => w === undefined || /^[-+]\d+$/.test(w) || w === '-n')) return this.block('This pushd changes to a directory that cannot be read.');
    const dashdash = args.indexOf('--');
    const at = dashdash >= 0 ? dashdash + 1 : args.findIndex((w) => w === undefined || !/^-[LPe@]+$/.test(w));
    const none = at < 0 || at >= args.length;
    if (none && name === 'pushd') return this.swapLocation(state);
    // Only the builtins read `-` as OLDPWD; to a program it is a folder of that name.
    if (!none && args[at] === '-' && name !== 'chdir') return state.places === undefined ? this.unreadDirectory() : this.previousDirectory(state, name === 'pushd');
    if (!none) return this.changeDirectory(args[at], env, state, spelled?.[at], name === 'pushd');
    // Without an operand cd goes to HOME, a prefix assignment's included.
    const home = this.home(env);
    return home === undefined ? this.block('HOME is computed, so the directory cd changes to cannot be read.') : this.changeDirectory(home, env, state, 'HOME');
  }

  /** The shell's places become unknown, which blocks wherever something reads them. */
  private lose(state: ShellState): undefined {
    state.places = undefined;
    return undefined;
  }

  /**
   * popd and Pop-Location: each place goes to its stack's top, taken off the stack; a directory the shell stood in is taken
   * to still exist. On an empty stack Bash's popd fails, and cmd's and PowerShell's stay put.
   */
  private popLocation(state: ShellState, shell: 'bash' | 'cmd' | 'powershell'): undefined {
    if (state.places === undefined || (shell === 'bash' && !this.stackReadable())) return this.lose(state);
    this.narrow(
      state,
      state.places.map((place) => {
        const top = place.stack.at(-1);
        if (top === undefined) return { ...place, exits: shell === 'bash' ? FAILED : SUCCEEDED };
        return { dir: top, stack: place.stack.slice(0, -1), previous: shell === 'bash' ? new Set([place.dir]) : place.previous, exits: SUCCEEDED };
      }),
    );
    return undefined;
  }

  /** pushd without an operand swaps the directory with the stack's top, and fails on an empty stack. */
  private swapLocation(state: ShellState): undefined {
    if (state.places === undefined || !this.stackReadable()) return this.lose(state);
    const swapped = state.places.flatMap((place) => {
      const top = place.stack.at(-1);
      const stays = { ...place, exits: FAILED };
      return top === undefined ? [stays] : [{ dir: top, stack: [...place.stack.slice(0, -1), place.dir], previous: new Set([place.dir]), exits: SUCCEEDED }, stays];
    });
    this.stand(state, joinPlaces(swapped));
    return undefined;
  }

  /**
   * A program either shell starts: git, and the shells whose text this check reads. `spelled` gives each argument as
   * written, for a reason to name; absent, the arguments are as written. `commandLine` gives the command lines the caller
   * builds from the arguments, which cmd and wsl read instead of them.
   */
  private program(name: string, args: Array<string | undefined>, env: Env, state: ShellState, spelled: Spelled | undefined, commandLine: CommandLine): string | undefined {
    if (name === 'git') return this.gitInvocation(args, env, state, spelled);
    if (name === 'ln') return this.link(args, state, spelled);
    if (SHELLS.has(name)) return this.shell(name, args, env, state);
    if (POWERSHELLS.has(name)) return this.nestedPowershell(name, args, env, state, spelled);
    if (name === 'cmd' || name === 'wsl') {
      const lines = commandLine(args, name);
      if (lines === undefined) return this.block(`${name} runs computed text, so its git target cannot be read.`);
      for (const line of lines) {
        const blocked = name === 'cmd' ? this.cmd(line, env, state) : this.wsl(line, state);
        if (blocked) return blocked;
      }
      return undefined;
    }
    return undefined;
  }

  /**
   * The links GNU ln makes: a symbolic link reads a relative target from the link's folder, with -r from the working
   * directory, as a hard link does. Git Bash's ln -s, which copies unless MSYS asks for links, reads it the same way.
   */
  private link(args: ReadonlyArray<string | undefined>, state: ShellState, spelled: Spelled | undefined): string | undefined {
    const parsed = readOptions(args, 0, LN_OPTIONS);
    if (parsed === undefined) return this.block('ln takes an option this check cannot read.');
    const names = new Set(parsed.options.map(({ name }) => name));
    if (names.has('help') || names.has('version')) return undefined;
    if (state.places === undefined) return this.unreadDirectory();
    const cwds = directories(state.places);
    const { operands } = parsed;
    const into = optionValues(parsed, 'target-directory').map(({ value }) => value);
    if (operands.some(({ word }) => word === undefined) || into.includes(undefined)) {
      for (const { word, index } of operands) {
        const blocked = word !== undefined && path.isAbsolute(shellPathText(word, undefined, process.platform)) ? this.linkReaches(word, cwds, undefined, spelling(args, spelled, index)) : undefined;
        if (blocked) return blocked;
      }
      return this.block('ln makes a link with a computed path, so where it reaches cannot be read.');
    }
    const words = operands.map(({ word }) => word!);
    const last = words.at(-1);
    const folderOf = (text: string): string => pathFor(process.platform).dirname(shellPathText(text, undefined, process.platform));
    // The folders a link may be made in: -t's; else a lone target's link goes in the working directory, and the last of
    // two operands names the link, or an existing folder it goes in, which the text does not tell apart.
    let folders: readonly string[];
    let targets = operands;
    if (into.length > 0) folders = into as string[];
    else if (last === undefined || (names.has('no-target-directory') && words.length !== 2)) return undefined;
    else if (words.length === 1) folders = ['.'];
    else {
      targets = operands.slice(0, -1);
      folders = words.length > 2 ? [last] : names.has('no-target-directory') ? [folderOf(last)] : [folderOf(last), last];
    }
    const fromLink = names.has('symbolic') && !names.has('relative');
    for (const cwd of cwds) {
      const bases = fromLink ? folders.flatMap((folder) => [nativeShellPath(folder, cwd, undefined), this.physicalPath(folder, cwd, undefined)]) : [cwd];
      for (const { word, index } of targets) {
        const blocked = this.linkReaches(word!, bases, undefined, spelling(args, spelled, index));
        if (blocked) return blocked;
      }
    }
    return undefined;
  }

  /**
   * The block for a link to `target`, read from each of `bases`, that lies in a protected area, or above one, which a
   * relative path through the link then reaches. `home` is where a leading `~` goes.
   */
  private linkReaches(target: string, bases: Iterable<string>, home: string | undefined, spelled: string | undefined): string | undefined {
    for (const base of new Set(bases)) {
      for (const candidate of new Set([nativeShellPath(target, base, home), this.physicalPath(target, base, home)])) {
        const area = this.landsGit(candidate);
        if (area) return this.block(inArea(spelled, area));
        const below = this.areaBelow(candidate);
        if (below) return this.block(worded(spelled, (word) => `A link to ${word} reaches a folder in ${below}.`, `A link the command makes reaches a folder in ${below}.`));
      }
    }
    return undefined;
  }

  /** The area one of whose folders lies in `p`, or undefined. */
  private areaBelow(p: string): string | undefined {
    const areas = this.protectedAreas();
    for (const form of this.formsOf(p)) {
      const area = areas.git.find((a) => a.roots.some((root) => folderContains(form, root)));
      if (area) return area.name;
    }
    return undefined;
  }

  /**
   * wsl.exe started with `line` after its name, as `WslClient.cpp` reads it: its own options split at spaces and tabs,
   * then the rest of the line, which the distribution's shell runs as written, or which -e splits into a command's words.
   */
  private wsl(line: string, state: ShellState): string | undefined {
    const computed = (): string => this.block('wsl runs computed text, so its git target cannot be read.');
    let cwds: Iterable<string> | undefined = state.places === undefined ? undefined : directories(state.places);
    let useShell = true;
    let rest = line.replace(WSL_BLANKS, '');
    // An option ends at a space or tab; --cd's value may be one quoted string.
    const peek = (quoted = false): string => {
      const close = quoted && rest.startsWith('"') ? rest.indexOf('"', 1) : -1;
      return close > 0 ? rest.slice(0, close + 1) : rest.slice(0, rest.search(/[ \t]|$/));
    };
    const take = (quoted = false): string => {
      const argument = peek(quoted);
      rest = rest.slice(argument.length).replace(WSL_BLANKS, '');
      return argument;
    };
    // A distribution GUID, then `~`, may lead the arguments.
    if (WSL_GUID.test(peek())) take();
    if (peek() === '~') {
      take();
      const moved = this.wslDirectory('~', '~');
      if (typeof moved === 'string') return moved;
      cwds = moved;
    }
    while (rest !== '') {
      const word = peek();
      if (word.includes(COMPUTED_TEXT)) return computed();
      // These manage WSL and return without running anything in a distribution.
      if (WSL_MANAGEMENT.has(word)) return undefined;
      if (word === '--debug-shell') return this.block('wsl --debug-shell reads its commands from input, so its git target cannot be read.');
      if (word === '--' || word === '-e' || word === '--exec') {
        take();
        if (word !== '--') useShell = false;
        break;
      }
      if (word.startsWith('-') && !WSL_VALUE_OPTIONS.has(word) && word !== '--system' && word !== '--cd' && word !== '--shell-type') return this.block('wsl takes an option this check cannot read.');
      if (!word.startsWith('-')) break;
      take();
      if (WSL_VALUE_OPTIONS.has(word)) take();
      if (word === '--shell-type') useShell = take() !== 'none';
      if (word === '--cd') {
        const written = take(true);
        const dir = written.length > 1 && written.startsWith('"') && written.endsWith('"') ? written.slice(1, -1) : written;
        if (dir.includes(COMPUTED_TEXT)) return this.block('wsl starts in a computed directory, so it cannot be read.');
        // wsl.exe refuses an empty or relative Windows path, and runs nothing.
        if (!/^[/~]/.test(dir) && !path.win32.isAbsolute(dir)) return undefined;
        const moved = this.wslDirectory(dir, written);
        if (typeof moved === 'string') return moved;
        cwds = moved;
      }
    }
    // wsl passes the environment only through WSLENV, and the distribution sets its own.
    const child = spawned(state, startingPlaces(cwds), new Map(), unknownEnvironment());
    // Without a shell wsl.exe runs the words CommandLineToArgvW splits the rest into, and refuses an empty command line.
    if (!useShell) return rest === '' ? undefined : this.command(windowsArguments(rest).map((word) => (word.includes(COMPUTED_TEXT) ? undefined : word)), child.env, child);
    if (rest === '') return this.block('wsl starts a shell that reads its commands from input, so its git target cannot be read.');
    // The distribution's shell runs the rest of the line through `$SHELL -c`, which reads it as bash does.
    return this.script(this.parsed(rest), child, rest);
  }

  /** The folder `wsl --cd` starts in: a Linux path when it begins with `/` or `~`, else an absolute Windows path. */
  private wslDirectory(dir: string, spelled: string | undefined): string | Set<string> {
    // Linux takes `..` through links; Windows takes it lexically.
    const target = /^[/~]/.test(dir) ? this.physicalPath(dir, this.iso.workingFolder, this.iso.homeDir) : path.resolve(dir);
    const area = this.landsGit(target);
    return area ? this.block(inArea(spelled, area)) : new Set([target]);
  }

  private declare(words: Array<string | undefined>, rawWords: readonly string[], state: ShellState): string | undefined {
    const name = commandName(words[0]!);
    // An option can change how later assignments set a value (-i, -l, -u, -n), so it turns value reading off.
    const options = words.slice(1).some((word) => word !== undefined && /^[-+]/.test(word));
    if (options) this.poison();
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      // A nameref makes every later use of its name read and set the variable it names; export -n only unexports.
      if (name !== 'export' && word !== undefined && /^-[A-Za-z]*n/.test(word)) return this.block(`${name} -n makes a reference to a variable, so its git target cannot be read.`);
      const assigned = ASSIGNMENT.exec(word ?? rawWords[i] ?? '');
      // The text scan finds an operand that starts with its name as written; quotes can build one it does not see.
      const written = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rawWords[i] ?? '')?.[0];
      if (assigned ? written !== assigned[1] : word !== undefined && !word.startsWith('-') && (name !== 'export' || options)) this.setter(assigned?.[1] ?? word, state);
      if (!assigned) {
        if (word === undefined) {
          this.poison();
          return this.block('A declaration names a computed variable, so its git target cannot be read.');
        }
        continue;
      }
      const value = word === undefined ? undefined : word.slice(word.indexOf('=') + 1);
      const raw = word === undefined ? rawWords[i]!.slice(assigned[0].length) : undefined;
      const blocked = this.checkEnv(assigned[1]!, value, state, raw);
      if (blocked) return blocked;
      widen(state.env, envName(assigned[1]!), assigned[0].endsWith('+=') ? undefined : value);
    }
    return undefined;
  }

  /** `source` and `.` run a file in this shell: a static file is not read, as `./build.sh` is not. */
  private source(name: string, args: Array<string | undefined>): string | undefined {
    let i = 0;
    for (; i < args.length && args[i]?.startsWith('-'); i++) {
      if (args[i] === '--') {
        i++;
        break;
      }
      // bash 5.3's -p names the path searched for the file.
      if (args[i] === '-p') i++;
      else return this.block(worded(args[i], (word) => `${name} ${word} is an option this check cannot read.`, `${name} takes an option this check cannot read.`));
    }
    return i < args.length ? this.scriptFile(name, args[i]) : undefined;
  }

  /** A script operand: computed text and the input's own files block; a static file is not read. */
  private scriptFile(name: string, operand: string | undefined): string | undefined {
    if (operand === undefined) return this.block(`${name} runs computed text, so its git target cannot be read.`);
    if (INPUT_FILE.test(path.posix.normalize(operand.replace(/\\/g, '/')))) return this.block(`${name} reads its commands from input, so its git target cannot be read.`);
    return undefined;
  }

  private wrapper(name: string, options: readonly WrapperOption[], words: Array<string | undefined>, rawWords: readonly string[], env: Env, state: ShellState): string | undefined {
    const unknown = (word: string): string => this.block(worded(rawWords[i] ?? word, (w) => `${name} ${w} is an option this check cannot read.`, `${name} takes an option this check cannot read.`));
    // Called once the missing value's index is past the option's.
    const valueless = (word: string): string =>
      this.block(worded(rawWords[i - 1] ?? word, (w) => `${name} ${w} takes a value this check cannot read.`, `An option of ${name} takes a value this check cannot read.`));
    // `at` is the index of the word that gave the value.
    const given: Array<{ readonly option: WrapperOption; readonly value: string | undefined; readonly at?: number }> = [];
    const operands: string[] = [];
    let assigned = false;
    let cleared = false;
    let i = 1;
    for (; i < words.length; i++) {
      const word = words[i];
      const setting = ENV_SETTERS.has(name) ? /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word ?? rawWords[i] ?? '') : null;
      if (setting) {
        const value = word === undefined ? undefined : word.slice(setting[0].length);
        const blocked = this.checkEnv(setting[1]!, value, state, word === undefined ? rawWords[i]!.slice(setting[0].length) : undefined);
        if (blocked) return blocked;
        env.set(envName(setting[1]!), new Set([value]));
        assigned = true;
        continue;
      }
      if (word === undefined) return this.block(`An argument of ${name} is computed, so the command it runs cannot be read.`);
      // Options end at the first operand, and for env and sudo at the first assignment.
      if (assigned || !word.startsWith('-') || word === '-') {
        if (name === 'env' && word === '-' && !assigned) {
          cleared = true;
          continue;
        }
        if ((name === 'su' || name === 'runuser') && word === '-') {
          given.push({ option: options.find((o) => o.role === 'login')!, value: undefined });
          continue;
        }
        if (PERMUTING.has(name)) {
          operands.push(word);
          continue;
        }
        break;
      }
      if (word === '--') {
        i++;
        break;
      }
      if (name === 'nice' && /^-\d+$/.test(word)) continue;
      if (word.startsWith('--')) {
        const eq = word.indexOf('=');
        const spelled = word.slice(2, eq < 0 ? undefined : eq);
        // getopt_long takes any unambiguous prefix of a long option.
        const exact = options.find((o) => o.long === spelled);
        const matches = exact ? [exact] : options.filter((o) => o.long?.startsWith(spelled));
        if (matches.length !== 1) return unknown(word);
        const match = matches[0]!;
        if (eq >= 0 && match.argument === 'none') return unknown(word);
        if (eq < 0 && match.argument === 'required') {
          const value = words[++i];
          if (value === undefined) return valueless(word);
          given.push({ at: i, option: match, value });
        } else {
          given.push({ at: i, option: match, value: eq < 0 ? undefined : word.slice(eq + 1) });
        }
        continue;
      }
      for (let k = 1; k < word.length; k++) {
        const match = options.find((o) => o.short === word[k]);
        if (!match) return unknown(word);
        if (match.argument === 'none') {
          given.push({ at: i, option: match, value: undefined });
          continue;
        }
        const attached = word.slice(k + 1);
        const value = attached !== '' || match.argument === 'optional' ? attached : words[++i];
        if (value === undefined) return valueless(word);
        given.push({ at: i, option: match, value: value === '' && match.argument === 'optional' ? undefined : value });
        break;
      }
    }
    // Only `builtin`, and `command` without -v or -V, run a builtin in this shell; every other wrapper starts a process.
    const inShell = name === 'builtin' || (name === 'command' && !given.some((g) => g.option.short === 'v' || g.option.short === 'V'));
    // These start the command with an environment the text does not give: reset by policy, cleared, or another user's.
    cleared ||= ENV_RESETTERS.has(name) || given.some(({ option: o }) => o.long === 'ignore-environment' || o.long === 'unset' || (name === 'exec' && o.short === 'c'));
    if (cleared) env.set('HOME', new Set([undefined]));
    const run = inShell ? state : fork(state, { environment: cleared ? unknownEnvironment() : inherit(state.environment) });
    for (const { option: o, value, at } of given) {
      if (o.role === 'chroot') return this.block(`${name} changes the root directory, so its paths cannot be read.`);
      // sudo -e edits the files it names and doas -C checks a configuration; neither runs a command.
      if (o.role === 'noCommand') return undefined;
      if (o.role === 'chdir') {
        const blocked = this.changeDirectory(value, env, run, at === undefined ? undefined : rawWords[at]);
        if (blocked) return blocked;
      }
    }
    // sudo -i and su -l run in the target user's home, which the text does not give.
    if (given.some(({ option: o }) => o.role === 'login')) this.lose(run);
    const split = given.find((g) => g.option.role === 'split');
    // env -S splits only its own text; each later word reaches the command whole.
    if (split) return this.nested([split.value!, ...words.slice(i).map((w) => w ?? COMPUTED_TEXT)].join(' '), run);
    const script = given.find((g) => g.option.role === 'script');
    if (script) return this.shellText(name, script.value!, env, run);
    if (PERMUTING.has(name)) {
      const rest = [...operands, ...words.slice(i)];
      // runuser -u runs its operands as a command; otherwise they follow the user and go to the user's shell.
      if (name === 'runuser' && given.some((g) => g.option.long === 'user')) return this.command(rest, env, run);
      if (name !== 'script') return this.shell(name, rest.slice(1), env, run);
      // Without -c, script runs an interactive shell; BSD script runs the command after its file.
      return rest.length > 1 ? this.command(rest.slice(1), env, run) : this.block('script runs a shell that reads its commands from input, so its git target cannot be read.');
    }
    // A shell parses the words joined, so a computed one may hold any syntax.
    if (name === 'cross-env-shell') return words.slice(i).includes(undefined) ? this.computedShellText(name) : this.shellText(name, words.slice(i).join(' '), env, run);
    if (name === 'parallel') return this.parallel(words.slice(i), given, env, run);
    // The first operand of timeout is the duration, of taskset the CPU mask, of chrt the priority when given.
    if (name === 'timeout' || name === 'taskset' || (name === 'chrt' && /^\d+$/.test(words[i] ?? ''))) i++;
    if (name === 'flock') {
      // flock's first operand is the lock file; a -c after it takes a shell script.
      i++;
      if (words[i] === '-c' || words[i] === '--command') {
        const text = words[i + 1];
        return text === undefined ? this.block('flock -c runs computed text, so its git target cannot be read.') : this.childShell(text, run, env);
      }
    }
    if (i >= words.length) return undefined;
    let command = words.slice(i);
    // Without -x, watch joins its operands and runs them through `sh -c`.
    if (name === 'watch' && !given.some((g) => g.option.role === 'exec')) return command.includes(undefined) ? this.computedShellText(name) : this.childShell(command.join(' '), run, env);
    if (name === 'xargs') {
      // xargs puts what it reads in place of its replace string, or after the command: both are computed words.
      const replace = replaceString(given);
      command = replace !== undefined ? command.map((w) => (w === undefined || w.includes(replace) ? undefined : w)) : [...command, undefined];
    }
    return this.command(command, env, run, rawWords.slice(i));
  }

  /** Text a runner hands to a shell: npm's and cross-env's shell is cmd on Windows, which they start as Node does. */
  private shellText(name: string, text: string, env: Env, state: ShellState): string | undefined {
    if ((name === 'npx' || name === 'cross-env-shell') && process.platform === 'win32') return this.cmd(`/d /s /c "${text}"`, env, state);
    return this.childShell(text, state, env);
  }

  /** GNU parallel runs each job through a shell: its command with each input in place of a replacement string, or appended. */
  private parallel(operands: Array<string | undefined>, given: ReadonlyArray<{ readonly option: WrapperOption; readonly value: string | undefined }>, env: Env, state: ShellState): string | undefined {
    const sourceAt = operands.findIndex((w) => w !== undefined && PARALLEL_SOURCES.has(w));
    const template = sourceAt < 0 ? operands : operands.slice(0, sourceAt);
    if (template.length === 0) {
      // Without a command, each input is a command line.
      const inputs = sourceAt < 0 ? [] : operands.slice(sourceAt);
      if (sourceAt < 0 || given.some((g) => g.option.long === 'arg-file') || inputs.some((w) => w === '::::' || w === '::::+')) {
        return this.block('parallel reads its commands from input, so its git target cannot be read.');
      }
      for (const input of inputs) {
        if (input === undefined) return this.block('parallel runs computed text, so its git target cannot be read.');
        if (PARALLEL_SOURCES.has(input)) continue;
        const blocked = this.childShell(input, state, env);
        if (blocked) return blocked;
      }
      return undefined;
    }
    if (!allRead(template)) return this.computedShellText('parallel');
    const replace = replaceString(given);
    // parallel quotes each input it puts in, so it is one computed word.
    const place = (word: string): string => (replace !== undefined ? word.replaceAll(replace, COMPUTED_TEXT) : word.replace(/\{[^}]*\}/g, COMPUTED_TEXT));
    const text = template.map(place);
    const placed = text.some((w, k) => w !== template[k]);
    return this.childShell([...text, ...(placed ? [] : [COMPUTED_TEXT])].join(' '), state, env);
  }

  private computedShellText(name: string): string {
    return this.block(`${name} runs computed text, so its git target cannot be read.`);
  }

  private shell(name: string, args: Array<string | undefined>, env: Env, state: ShellState): string | undefined {
    const fromInput = (): string => this.block(`${name} reads its commands from input, so its git target cannot be read.`);
    // -s reads the commands from input; operands become their arguments.
    let readsInput = false;
    let startup = false;
    // The options that change how it reads aliases, in the order given; bash alone starts outside POSIX mode.
    const options: Array<readonly ['posix' | 'expand_aliases', boolean | undefined]> = [];
    const aliases = (environment: Environment): Aliases => options.reduce((read, [option, on]) => withOption(read, option, on), startingAliases(environment, name !== 'bash'));
    for (let i = 0; i < args.length; i++) {
      const word = args[i];
      if (word === undefined) return this.block(`${name} runs computed text, so its git target cannot be read.`);
      // A lone `-` ends the options as `--` does.
      const ended = word === '--' || word === '-';
      if (ended || (!word.startsWith('-') && !word.startsWith('+'))) {
        if (readsInput || (ended && i + 1 >= args.length)) return fromInput();
        return this.scriptFile(name, ended ? args[i + 1] : word);
      }
      // The shell prints its version or help, or refuses the option, and reads no command.
      if (word === '--version' || word === '--help') return undefined;
      if (word === '--posix') options.push(['posix', true]);
      if (SHELL_VALUE_OPTIONS.has(word) || (name === 'fish' && FISH_VALUE_OPTIONS.has(word))) {
        i++;
        continue;
      }
      if (word.startsWith('--') && !SHELL_FLAG_OPTIONS.has(word)) return this.block(`${name} takes an option this check cannot read.`);
      // A login or interactive shell runs its profile or rc file first.
      if (word === '--login' || word === '--interactive' || /^-[A-Za-z]*[li]/.test(word)) startup = true;
      if (/^-[A-Za-z]*k/.test(word) || (word === '-o' && args[i + 1] === 'keyword')) return this.block(`${name} -k reads assignments after a command name, so its git target cannot be read.`);
      // -c anywhere in a cluster (-lc, -ec) takes the script from the next operand.
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) {
        const script = args.slice(i + 1).find((w) => w === undefined || !w.startsWith('-'));
        if (script === undefined) return this.block(`${name} -c runs computed text, so its git target cannot be read.`);
        if (!BASH_READ_SHELLS.has(name)) return this.block(`${name} -c runs text this check cannot read as bash, so its git target cannot be read.`);
        return this.childShell(script, state, env, { startup, aliases });
      }
      if (/^-[A-Za-z]*s[A-Za-z]*$/.test(word)) readsInput = true;
      // -o and -O take the next word, at the end of a cluster too (`-eo pipefail`).
      const named = /^[-+][A-Za-z]*([oO])$/.exec(word)?.[1];
      if (named !== undefined) {
        const option = args[++i];
        const changes = named === 'o' ? 'posix' : 'expand_aliases';
        if (option === undefined || option === changes) options.push([changes, option === undefined ? undefined : word.startsWith('-')]);
      }
    }
    // No script operand: the shell reads its commands from input, which this text does not hold.
    return fromInput();
  }

  /**
   * pwsh or powershell, `name`, as a new process: it starts where this shell may be, with its environment, and nothing
   * comes back.
   */
  private nestedPowershell(name: string, args: Array<string | undefined>, env: Env, state: ShellState, spelled?: Spelled): string | undefined {
    const computed = (): string => this.block('PowerShell runs computed text, so its git target cannot be read.');
    const fromInput = (): string => this.block('PowerShell reads its commands from input, so its git target cannot be read.');
    if (state.places === undefined) return this.unreadDirectory();
    let cwds: ReadonlySet<string> = new Set(directories(state.places));
    const windows = name === 'powershell';
    const home = this.psHome(state);
    let profile = true;
    // Code the text does not show runs before the command: a console file, a session configuration, a login shell.
    let startup = false;
    const texts: string[] = [];
    let i = 0;
    // Windows PowerShell's launcher takes a leading -Version and -PSConsoleFile, each once, after `-` only.
    for (const taken = new Set<string>(); windows && i < args.length; i += 2) {
      const key = /^-([a-z]+)$/i.exec(args[i] ?? '')?.[1]?.toLowerCase();
      const launcher = key === undefined ? undefined : ['version', 'psconsolefile'].find((option) => option.startsWith(key));
      if (launcher === undefined || taken.has(launcher)) break;
      taken.add(launcher);
      if (launcher === 'psconsolefile') startup = true;
    }
    for (; i < args.length; i++) {
      const word = args[i];
      if (word === undefined) return computed();
      // pwsh takes an empty word as its script file; Windows PowerShell skips it.
      if (word.trim() === '') {
        if (windows) continue;
        return undefined;
      }
      const kind = psSwitch(word, windows ? WINDOWS_POWERSHELL_SWITCHES : PWSH_SWITCHES);
      if (kind === undefined) {
        // `-` reads the commands from input; any other word is pwsh's script file, and Windows PowerShell's command with the words after it.
        if (word === '-') return fromInput();
        if (!windows) return undefined;
        const rest = args.slice(i);
        if (!allRead(rest)) return computed();
        texts.push(rest.join(' '));
        break;
      }
      if (kind === 'help' || kind === 'version') return undefined;
      if (kind === 'server') return fromInput();
      if (kind === 'noprofile') profile = false;
      // pwsh off Windows starts through a login shell, which runs its profile.
      if (kind === 'login' && process.platform !== 'win32') startup = true;
      if (kind === 'value' || kind === 'startup') i++;
      if (kind === 'startup') startup = true;
      if (kind === 'file') return args[i + 1] === '-' ? fromInput() : undefined;
      if (kind === 'command' || kind === 'commandWithArgs') {
        // -CommandWithArgs takes one word as its command and the rest as its arguments.
        const rest = kind === 'command' ? args.slice(i + 1) : args.slice(i + 1, i + 2);
        if (!allRead(rest)) return computed();
        if (rest[0] === '-') return fromInput();
        texts.push(rest.join(' '));
        break;
      }
      if (kind === 'encoded') {
        const encoded = args[++i];
        if (encoded === undefined) return computed();
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return this.block('The encoded PowerShell command cannot be read.');
        texts.push(Buffer.from(encoded, 'base64').toString('utf16le'));
      }
      if (kind === 'directory') {
        const dir = args[++i];
        if (dir === undefined) return this.block('PowerShell starts in a computed directory, so it cannot be read.');
        const moved = this.psDirectories(dir, cwds, spelling(args, spelled, i), home);
        if (typeof moved === 'string') return moved;
        cwds = new Set([...cwds, ...moved]);
      }
    }
    if (texts.length === 0) return fromInput();
    for (const text of texts) {
      const started = spawnedPowershell(state, startingPlaces(cwds), home, env);
      // Without -NoProfile the profile scripts run first.
      if (profile || startup) this.barrier(started);
      const blocked = this.powershell(text, started);
      if (blocked) return blocked;
    }
    return undefined;
  }

  /**
   * cmd started with `line` after its name, as a new process with `env`: AutoRun runs first unless /d, then its
   * /c text, read in each way cmd may take it.
   */
  private cmd(line: string, env: Env, state: ShellState): string | undefined {
    if (state.depth > MAX_DEPTH) return this.block('The command nests too deeply to read its git target.');
    this.walked(line, cmdTextScan);
    const switches = cmdSwitches(line);
    if ('blocked' in switches) return this.block(switches.blocked);
    if ('help' in switches) return undefined;
    const start = (): ShellState => {
      const started = this.spawn(state, env);
      if (!switches.switches.noAutoRun) this.barrier(started);
      return started;
    };
    const reader = start();
    const parsed = this.cmdLine(line, switches, (name) => this.cmdVariable(reader, name));
    if ('blocked' in parsed) return this.block(parsed.blocked);
    for (const segments of parsed.readings) {
      const blocked = this.cmdRun(segments, start());
      if (blocked) return blocked;
    }
    return undefined;
  }

  /**
   * `line`'s reading, parsed once per run for each set of values its variables give: the parse looks them up in an order
   * only their values decide, so the same values in that order give the same reading.
   */
  private cmdLine(line: string, start: CmdStart, lookup: (name: string) => CmdVariable): CmdLine | CmdBlocked {
    const same = (a: CmdVariable, b: CmdVariable): boolean => (typeof a === 'object' && typeof b === 'object' ? a.value === b.value : a === b);
    const known = this.cmdParses.get(line) ?? [];
    const found = known.find((entry) => entry.lookups.every(([name, value]) => same(lookup(name), value)));
    if (found !== undefined) return found.parsed;
    const lookups: Array<readonly [string, CmdVariable]> = [];
    const parsed = parseCmdLine(start, (name) => {
      const value = lookup(name);
      lookups.push([name, value]);
      return value;
    });
    this.cmdParses.set(line, [...known, { lookups, parsed }]);
    return parsed;
  }

  /** A new process `state`'s process starts, where it may be, with `env` and its exported environment. */
  private spawn(state: ShellState, env: Env): ShellState {
    return spawned(state, startingPlaces(state.places === undefined ? undefined : directories(state.places)), env);
  }

  /**
   * What `%NAME%` gives in cmd's process `state` (docs/worktree-isolation.md "cmd"): a value the text proves, `unset`
   * when nothing can have set it, syntax when the run may have set it, else a computed word. cmd matches names without
   * case on Windows.
   */
  private cmdVariable(state: ShellState, name: string): CmdVariable {
    const key = siteKey(name);
    const dynamic = CMD_DYNAMIC.test(name);
    const value = dynamic ? undefined : this.lookup(state, name, key, 'environment');
    if (value !== undefined) return { value };
    this.reading.resolved.add(key);
    if (this.reading.poisoned || this.reading.sites.has(key)) return 'syntax';
    const unset = !dynamic && this.reading.resolving && environmentEntry(state.environment, environmentKey(name)) === undefined;
    return unset ? 'unset' : 'computed';
  }

  /** One text cmd runs: a pipeline's sides in child cmd processes that read their text again, every other command here. */
  private cmdRun(segments: readonly CmdSegment[], state: ShellState): string | undefined {
    for (const segment of segments) {
      const before = state.places;
      const blocked = segment.piped ? this.cmd(`/d /s /c "${segment.text}"`, state.env, state) : this.cmdAlternatives(segment.commands, state);
      if (blocked) return blocked;
      // A command after `&&` or `||` may not run, and the segments do not tell those from `&`.
      this.stand(state, joinPlaces(state.places, before));
    }
    return undefined;
  }

  /** Each way cmd may take one command's token, from the same state; only an internal command changes it, and it has one way. */
  private cmdAlternatives(commands: readonly CmdCommand[], state: ShellState): string | undefined {
    for (const command of commands) {
      const blocked = this.cmdCommand(command, state);
      if (blocked) return blocked;
    }
    return undefined;
  }

  /** One command in cmd's process `state`: an internal command, a drive change or a program. */
  private cmdCommand({ name, internal, rest }: CmdCommand, state: ShellState): string | undefined {
    if (name === undefined) return this.block('The command name is computed, so its git target cannot be read.');
    // A drive change goes to that drive's current directory, which the text does not give.
    if (!internal && /^[A-Za-z]:$/.test(name)) return this.lose(state);
    if (!internal) return this.cmdProgram(name, rest, state);
    if (name === 'for' || name === 'if' || name === 'goto') return this.block(`cmd runs ${name}, which this check cannot read.`);
    if (name === 'cd' || name === 'chdir') return this.cmdChangeDirectory(rest.replace(CMD_CD_SWITCH, ''), state);
    // Without an operand pushd prints the stack.
    if (name === 'pushd') return rest.trim() === '' ? undefined : this.cmdChangeDirectory(rest, state, true);
    if (name === 'popd') return this.popLocation(state, 'cmd');
    if (name === 'set') return this.cmdSet(rest, state);
    if (name === 'setlocal' && /enabledelayedexpansion|disableextensions/i.test(rest)) return this.block('setlocal changes how cmd expands the text, which this check cannot read.');
    if (name === 'start') return this.cmdStart(rest, state);
    if (name === 'call') return this.cmdCall(rest, state);
    if (name === 'mklink') return this.cmdLink(rest, state);
    return undefined;
  }

  /**
   * mklink's link, then its target: a junction (/J) and a hard link (/H) read a relative target from the working
   * directory, a symbolic link (/D or no switch) from the link's folder. Another switch, or another number of operands, makes nothing.
   */
  private cmdLink(rest: string, state: ShellState): string | undefined {
    const words = cmdTokens(rest).map(({ text }) => text.replaceAll('"', ''));
    if (words.some((word) => word.includes(COMPUTED_TEXT))) return this.block('mklink makes a link with a computed path, so where it reaches cannot be read.');
    const switches = new Set(words.filter((word) => word.startsWith('/')).map((word) => word.toLowerCase()));
    const operands = words.filter((word) => !word.startsWith('/'));
    if ([...switches].some((option) => option !== '/d' && option !== '/h' && option !== '/j') || operands.length !== 2) return undefined;
    if (state.places === undefined) return this.unreadDirectory();
    const [link, target] = operands as [string, string];
    // With /J and /D together mklink makes a junction.
    const fromCwd = switches.has('/j') || switches.has('/h');
    const fromLink = !switches.has('/j');
    const folder = pathFor(process.platform).dirname(link);
    for (const cwd of directories(state.places)) {
      const bases = [...(fromCwd ? [cwd] : []), ...(fromLink ? [nativeShellPath(folder, cwd, undefined), this.physicalPath(folder, cwd, undefined)] : [])];
      const blocked = this.linkReaches(target, bases, undefined, target);
      if (blocked) return blocked;
    }
    return undefined;
  }

  /** A program cmd starts with `rest` as its arguments, which its runtime splits. */
  private cmdProgram(written: string, rest: string, state: ShellState): string | undefined {
    const name = commandName(written);
    for (const words of nativeArgumentReadings(rest, name)) {
      const blocked = this.program(name, words, state.env, state, undefined, () => [rest]);
      if (blocked) return blocked;
    }
    return undefined;
  }

  /**
   * `cd` or `pushd` to `text`: with extensions the whole text without quotes, and without them its first word, which a
   * registry setting may choose.
   */
  private cmdChangeDirectory(text: string, state: ShellState, push = false): string | undefined {
    const whole = text.replaceAll('"', '').replace(CMD_DELIMITERS, '').replace(CMD_TRAILING_SPACE, '');
    if (whole === '') return undefined;
    const first = cmdTokens(text)[0]!.text.replaceAll('"', '');
    const before = state.places;
    const reached: Array<Place[] | undefined> = [];
    for (const target of new Set([whole, first])) {
      state.places = before;
      const blocked = this.changeDirectory(target.includes(COMPUTED_TEXT) ? undefined : target, new Map(), state, undefined, push);
      if (blocked) return blocked;
      reached.push(state.places);
    }
    this.stand(state, joinPlaces(...reached));
    return undefined;
  }

  /**
   * `set`: a variable git or a child reads, which a child reads as computed, since no cmd assignment defines a value;
   * `/p` reads its value from input, and `/a` assigns the names its expression holds.
   */
  private cmdSet(rest: string, state: ShellState): string | undefined {
    let text = rest.replace(CMD_DELIMITERS, '');
    if (/^\/a/i.test(text)) {
      this.poison();
      const named = text.slice(2).match(/[A-Za-z_]\w*/g) ?? [];
      return named.some((name) => targetVariable(envName(environmentKey(name)))) ? this.block('set /a assigns a variable git reads, so its target cannot be read.') : undefined;
    }
    const prompt = /^\/p/i.test(text);
    if (prompt) text = text.slice(2).replace(CMD_DELIMITERS, '');
    // `set "N=v"` ends its value at the last quote.
    if (text.startsWith('"')) text = text.lastIndexOf('"') > 0 ? text.slice(1, text.lastIndexOf('"')) : text.slice(1);
    const eq = text.indexOf('=');
    if (eq <= 0) return undefined;
    const name = text.slice(0, eq);
    if (name.includes(COMPUTED_TEXT)) {
      this.poison();
      return this.block('set names a computed variable, so its git target cannot be read.');
    }
    const assigned = text.slice(eq + 1);
    const value = prompt || assigned.includes(COMPUTED_TEXT) ? undefined : assigned;
    const site = `set:${siteKey(name)}`;
    this.addSite(siteKey(name), site);
    const key = envName(environmentKey(name));
    // The value keeps the spaces before a following `&`, which Windows drops from the path it opens.
    for (const each of new Set([value, value?.trimEnd()])) {
      const blocked = this.gitVariable(key, each, state);
      if (blocked) return blocked;
      widen(state.env, key, each);
    }
    this.export(state, name, undefined, site);
    return undefined;
  }

  /**
   * `start`: the first quoted token among its options is the title, and the options go on after it; `/d` names the folder
   * the program starts in; the first other token, a second quoted one included, is the program or internal command.
   */
  private cmdStart(rest: string, state: ShellState): string | undefined {
    // A `/` right after the title's closing quote starts the next option.
    const tokens = cmdTokens(rest).flatMap((token) => {
      const close = token.text.startsWith('"') ? token.text.indexOf('"', 1) : -1;
      if (close < 0 || token.text[close + 1] !== '/') return [token];
      return [{ text: token.text.slice(0, close + 1), offset: token.offset }, { text: token.text.slice(close + 1), offset: token.offset + close + 1 }];
    });
    const started = this.spawn(state, state.env);
    let titled = false;
    let k = 0;
    for (; k < tokens.length; k++) {
      const written = tokens[k]!.text;
      if (written.startsWith('"') && !titled) {
        titled = true;
        continue;
      }
      if (!written.startsWith('/')) break;
      const option = written.toLowerCase();
      if (option.startsWith('/d')) {
        const dir = option === '/d' ? tokens[++k]?.text : written.slice(2);
        const blocked = dir === undefined ? undefined : this.changeDirectory(dir.includes(COMPUTED_TEXT) ? undefined : dir.replaceAll('"', ''), new Map(), started);
        if (blocked) return blocked;
      } else if (option === '/node' || option === '/affinity') {
        k++;
      } else if (!START_SWITCHES.has(option) && !/^\/machine:\w+$/.test(option)) {
        return this.block(worded(written, (word) => `start ${word} is an option this check cannot read.`, 'start takes an option this check cannot read.'));
      }
    }
    if (k >= tokens.length) return undefined;
    const text = rest.slice(tokens[k]!.offset);
    const commands = cmdCommands(text);
    // An internal command runs in a new cmd window, which runs AutoRun first and reads the text again.
    return commands.some((command) => command.internal) ? this.cmd(`/s /c "${text}"`, started.env, started) : this.cmdAlternatives(commands, started);
  }

  /** `call` reads its text again: `%` expands a second time and a label is a jump, so both block. */
  private cmdCall(rest: string, state: ShellState): string | undefined {
    const text = rest.replace(CMD_DELIMITERS, '');
    if (text.startsWith(':')) return this.block('call runs a label, which this check cannot follow.');
    if (text.includes('%')) return this.block('call expands the text a second time, so its git target cannot be read.');
    const readings = cmdSegments(text, false);
    if ('blocked' in readings) return this.block(readings.blocked);
    // With delayed expansion off there is one reading.
    const segments = readings[0]!;
    if (segments.length > 1) return this.block('call reads its text again, so its git target cannot be read.');
    return this.cmdAlternatives(segments[0]?.commands ?? [], state);
  }

  private find(args: Array<string | undefined>, env: Env, state: ShellState): string | undefined {
    for (let i = 0; i < args.length; i++) {
      const action = args[i] ?? '';
      if (!/^-(exec|execdir|ok|okdir)$/.test(action)) continue;
      const end = args.findIndex((w, j) => j > i && (w === ';' || w === '+'));
      // find puts each found path in place of {} anywhere in a word.
      const inner = args.slice(i + 1, end < 0 ? args.length : end).map((w) => (w === undefined || w.includes('{}') ? undefined : w));
      // -execdir and -okdir run in each found file's folder, which the text does not give.
      const blocked = this.command(inner, env, fork(state, { places: action.endsWith('dir') ? undefined : state.places }));
      if (blocked) return blocked;
    }
    return undefined;
  }

  /**
   * A cd to `target`, a word bash already expanded, so a `~` in it is a folder name; a reason names it as `spelled`, its
   * word as written, when given.
   */
  private changeDirectory(target: string | undefined, env: Env, state: ShellState, spelled?: string, push = false): string | undefined {
    if (target === undefined) return this.block('The directory a cd changes to is computed, so it cannot be read.');
    if (state.places === undefined) return this.unreadDirectory();
    const cdpaths = env.get('CDPATH') ?? new Set<string | undefined>();
    if (cdpaths.has(undefined)) return this.block('CDPATH is computed, so the directory a cd changes to cannot be read.');
    const relative = !path.isAbsolute(target) && !target.startsWith('/') && !/^\.\.?([/\\]|$)/.test(target);
    const entries: Array<{ readonly entry: string; readonly home: string | undefined }> = [];
    for (const entry of relative ? [...cdpaths].flatMap((cdpath) => cdpath!.split(/[:;]/)) : []) {
      if (entry === '') continue;
      // cd expands a `~` that starts a CDPATH entry with the shell's HOME.
      const home = /^~(?:\/|$)/.test(entry) ? this.home(env) : undefined;
      if (entry.startsWith('~') && home === undefined) return this.block('A CDPATH entry names a home folder that cannot be read.');
      entries.push({ entry, home });
    }
    // A cd that succeeds moves (pushd pushes first), one that fails stays put with its stack unchanged.
    const next: Place[] = [];
    for (const place of state.places) {
      const bases = new Set([place.dir, ...entries.map(({ entry, home }) => nativeShellPath(entry, place.dir, home))]);
      for (const base of bases) {
        // cd -P, and cd after set -P, takes `..` physically; both readings stay possible.
        for (const candidate of new Set([nativeShellPath(target, base, undefined), this.physicalPath(target, base, undefined)])) {
          const area = this.landsGit(candidate);
          if (area) return this.block(inArea(spelled ?? target, area));
          next.push({ dir: candidate, stack: push ? [...place.stack, place.dir] : place.stack, previous: new Set([place.dir]), exits: SUCCEEDED });
        }
      }
      next.push({ ...place, exits: FAILED });
    }
    this.stand(state, joinPlaces(next));
    return undefined;
  }

  /**
   * `cd -` and `pushd -` go to OLDPWD in each place, pushd pushing the directory it leaves, and fail where it is unset.
   * An OLDPWD the shell started with or the text may set is computed, as is any after arithmetic, and blocks.
   */
  private previousDirectory(state: ShellState, push: boolean): string | undefined {
    this.reading.resolved.add(siteKey('OLDPWD'));
    const places = state.places!;
    if (this.reading.poisoned || this.reading.sites.has(siteKey('OLDPWD')) || places.some((place) => place.previous === null)) {
      return this.block(`OLDPWD is computed, so the directory ${push ? 'pushd' : 'cd'} - changes to cannot be read.`);
    }
    const next = places.flatMap((place) => [
      { ...place, exits: FAILED },
      ...[...place.previous!].flatMap((dir) => (dir === undefined ? [] : [{ dir, stack: push ? [...place.stack, place.dir] : place.stack, previous: new Set([place.dir]), exits: SUCCEEDED }])),
    ]);
    this.stand(state, joinPlaces(next));
    return undefined;
  }

  /**
   * git started with `args`, by either shell, with the variables `env` gives it, in any folder `state` may be in: the folder
   * and repository its global options, configuration and path variables point it at, and the commands it runs.
   */
  private gitInvocation(args: Array<string | undefined>, env: Env, state: ShellState, spelled?: Spelled): string | undefined {
    if (state.places === undefined) return this.unreadDirectory('The working directory of this git command cannot be read.');
    let cwds = directories(state.places);
    const targets: Array<{ readonly path: string; readonly spelled: string | undefined }> = [];
    let i = 0;
    for (; i < args.length; i++) {
      const word = args[i];
      if (word === undefined) return this.block('An option of this git command is computed, so its target cannot be read.');
      if (!word.startsWith('-')) break;
      if (word === '-C' || (word.startsWith('-C') && word.length > 2)) {
        const dir = word === '-C' ? args[++i] : word.slice(2);
        if (dir === undefined) return this.block('git -C names a computed directory, so its target cannot be read.');
        if (dir !== '') cwds = cwds.map((cwd) => this.physicalPath(dir, cwd, this.iso.homeDir));
        continue;
      }
      if (word === '-c' || word.startsWith('--config-env')) {
        const config = word === '-c' ? args[++i] : undefined;
        if (config === undefined) return this.block('This git command takes configuration this check cannot read.');
        if (/^core\.worktree=/i.test(config)) targets.push({ path: config.slice(config.indexOf('=') + 1), spelled: spelling(args, spelled, i) });
        const blocked = this.gitConfigPair(config, env, state, cwds);
        if (blocked) return blocked;
        continue;
      }
      if (word === '--namespace' || word.startsWith('--namespace=')) {
        if (word === '--namespace') i++;
        continue;
      }
      let handled = GIT_FLAG_OPTIONS.has(word);
      for (const gitOption of ['--git-dir', '--work-tree']) {
        if (word !== gitOption && !word.startsWith(`${gitOption}=`)) continue;
        const value = word === gitOption ? args[++i] : word.slice(gitOption.length + 1);
        if (value === undefined) return this.block(`git ${gitOption} names a computed path, so its target cannot be read.`);
        targets.push({ path: value, spelled: spelling(args, spelled, i) });
        handled = true;
      }
      if (!handled) return this.block(worded(spelling(args, spelled, i) ?? word, (w) => `git ${w} is an option this check cannot read.`, 'This git command takes an option this check cannot read.'));
    }
    for (const variable of GIT_PATH_ENV) {
      for (const value of env.get(variable) ?? []) {
        if (value === undefined) return this.block(`${variable} is computed, so the git target cannot be read.`);
        if (value !== '') targets.push({ path: value, spelled: variable });
      }
    }
    const commands = this.gitCommandOptions(args, i, env, state, cwds);
    if (commands) return commands;
    for (const cwd of cwds) {
      const runsIn = this.landsGit(cwd);
      if (runsIn) return this.block(`This git command runs in ${runsIn}.`);
      for (const target of targets) {
        const area = this.landsGit(this.physicalPath(target.path, cwd, this.iso.homeDir));
        if (area) return this.block(pointed('git', target.spelled, area));
      }
      // `git worktree remove|move|repair` acts on the folder its operand names, which may be another worktree of the project.
      if (args[i] === 'worktree' && (args[i + 1] === 'remove' || args[i + 1] === 'move' || args[i + 1] === 'repair')) {
        for (let k = i + 2; k < args.length; k++) {
          const operand = args[k];
          if (operand === undefined) return this.block('git worktree names a computed path, so its target cannot be read.');
          const area = operand.startsWith('-') ? undefined : this.landsGit(this.physicalPath(operand, cwd, this.iso.homeDir));
          if (area) return this.block(pointed('git worktree', spelling(args, spelled, k), area));
        }
      }
      const written = this.gitWrites(args, i, cwd, spelled);
      if (written) return written;
    }
    return this.startGitVariables(env, fork(state, { env: new Map(env), places: startingPlaces(cwds) }));
  }

  /** A `name=value` pair git takes as configuration: an alias or an included file blocks, and command text is read. */
  private gitConfigPair(config: string, env: Env, state: ShellState, cwds: readonly string[]): string | undefined {
    if (/^alias\./i.test(config)) return this.block('A git alias defined on the command line runs commands this check cannot read.');
    if (/^include(if\.[^=]*)?\.path=/i.test(config)) return this.block('This git command includes a configuration file this check cannot read.');
    if (!GIT_COMMAND_CONFIG.test(config)) return undefined;
    return this.gitRunsCommand(config.slice(config.indexOf('=') + 1).replace(/^!/, ''), fork(state, { env: new Map(env), places: startingPlaces(cwds) }));
  }

  /** The configuration and the upload-pack command `git clone` gives the repository it makes, where it may run from any of `cwds`. */
  private gitCommandOptions(args: ReadonlyArray<string | undefined>, at: number, env: Env, state: ShellState, cwds: readonly string[]): string | undefined {
    const parsed = args[at] === 'clone' ? readOptions(args, at + 1, GIT_CLONE) : undefined;
    for (const { name, value } of parsed?.options ?? []) {
      if (name !== 'config' && name !== 'upload-pack') continue;
      if (value === undefined) return this.block(`git clone --${name} is computed, so what it runs cannot be read.`);
      const blocked = name === 'config' ? this.gitConfigPair(value, env, state, cwds) : this.gitRunsCommand(value, fork(state, { env: new Map(env), places: startingPlaces(cwds) }));
      if (blocked) return blocked;
    }
    return undefined;
  }

  /**
   * The folder a git subcommand started in `cwd` writes through an operand, or points a repository's git at: the path of
   * `worktree add`, the folder and `--separate-git-dir` of `clone` and `init`, and core.worktree as `git config` writes it.
   */
  private gitWrites(args: ReadonlyArray<string | undefined>, at: number, cwd: string, spelled: Spelled | undefined): string | undefined {
    const subcommand = args[at] === 'worktree' && args[at + 1] === 'add' ? 'worktree add' : args[at];
    if (subcommand === 'config') return this.gitConfigWrite(args, at + 1, cwd, spelled);
    const table = subcommand === 'worktree add' ? GIT_WORKTREE_ADD : subcommand === 'clone' ? GIT_CLONE : subcommand === 'init' ? GIT_INIT : undefined;
    if (table === undefined) return undefined;
    const parsed = readOptions(args, at + (subcommand === 'worktree add' ? 2 : 1), table);
    if (parsed === undefined) return this.block(`git ${subcommand} takes an option this check cannot read.`);
    // The path of worktree add and init's folder are the first operand, clone's folder the second, after its repository.
    const named = parsed.operands.slice(0, subcommand === 'clone' ? 2 : 1);
    if (named.some(({ word }) => word === undefined)) return this.block(`git ${subcommand} names a computed path, so its target cannot be read.`);
    const folder = subcommand === 'clone' ? named.slice(1) : named;
    const separate = optionValues(parsed, 'separate-git-dir').map(({ value, index }) => ({ word: value, index }));
    for (const { word, index } of [...folder, ...separate]) {
      if (word === undefined) return this.block(`git ${subcommand} names a computed path, so its target cannot be read.`);
      const area = this.landsGit(this.physicalPath(word, cwd, this.iso.homeDir));
      if (area) return this.block(pointed(`git ${subcommand}`, spelling(args, spelled, index), area));
    }
    // Reinitializing a repository moves its git directory to --separate-git-dir; this worktree's is the project's.
    const initialized = this.physicalPath(named[0]?.word ?? '.', cwd, this.iso.homeDir);
    if (subcommand === 'init' && separate.length > 0 && this.aroundWorkingFolder(initialized)) {
      return this.block("git init --separate-git-dir moves the git directory of a repository it reinitializes, and the folder it initializes may be this worktree, whose repository is the project's.");
    }
    for (const { value, index } of subcommand === 'clone' ? optionValues(parsed, 'config') : []) {
      if (value !== undefined && /^core\.worktree=/i.test(value)) {
        const blocked = this.coreWorktree(value.slice(value.indexOf('=') + 1), spelling(args, spelled, index), undefined, 'git clone -c');
        if (blocked) return blocked;
      }
    }
    return undefined;
  }

  /**
   * `git config` from `start`, started in `cwd`, where it may write core.worktree: the repository's shared configuration,
   * which the project folder's own git reads; this worktree's `config.worktree`; or a `--file`. git reads core.worktree
   * from no global or system file.
   */
  private gitConfigWrite(args: ReadonlyArray<string | undefined>, start: number, cwd: string, spelled: Spelled | undefined): string | undefined {
    if (start >= args.length) return undefined;
    const first = args[start];
    if (first === undefined) return this.block('git config names a computed key, which may be core.worktree.');
    if (first === 'get' || first === 'list' || first === 'edit') return undefined;
    const subcommand = first === 'set' || first === 'unset' || first === 'rename-section' || first === 'remove-section' ? first : undefined;
    const parsed = readOptions(args, subcommand === undefined ? start : start + 1, subcommand === undefined ? GIT_CONFIG_LEGACY : GIT_CONFIG_WRITE);
    if (parsed === undefined) return this.block('git config takes an option this check cannot read.');
    const names = new Set(parsed.options.map(({ name }) => name));
    const { operands } = parsed;
    const has = (...actions: string[]): boolean => actions.some((action) => names.has(action));
    let action: 'set' | 'unset' | 'section' | undefined;
    if (subcommand !== undefined) action = subcommand === 'set' ? 'set' : subcommand === 'unset' ? 'unset' : 'section';
    else if ([...names].some((name) => GIT_CONFIG_READS.has(name))) action = undefined;
    else if (has('add', 'replace-all')) action = 'set';
    else if (has('unset', 'unset-all')) action = 'unset';
    else if (has('rename-section', 'remove-section')) action = 'section';
    else if (operands.length >= 2) action = 'set';
    if (action === undefined || operands.length === 0) return undefined;
    const touches = action === 'section' ? operands.slice(0, 2).some(({ word }) => word === undefined || /^core$/i.test(word)) : operands[0]!.word === undefined || /^core\.worktree$/i.test(operands[0]!.word);
    if (!touches) return undefined;
    const value = action === 'set' ? operands[1] : undefined;
    if (action === 'set' && value === undefined) return undefined;
    const files = optionValues(parsed, 'file');
    const local = (!has('global', 'system', 'worktree', 'blob') && files.length === 0) || has('local', 'no-global', 'no-system', 'no-worktree', 'no-file', 'no-blob', 'no-local');
    if (local) return this.block("This git config may change core.worktree in the repository's shared configuration, which the project folder's own git reads.");
    if (has('worktree') && action === 'section') return this.block('This git config may give core.worktree a value the text does not show.');
    if (has('worktree') && value !== undefined) {
      const blocked = this.coreWorktree(value.word, spelling(args, spelled, value.index), undefined);
      if (blocked) return blocked;
    }
    for (const file of files) {
      if (file.value === undefined) return this.block('git config writes a computed file, which may be a configuration of the project.');
      const written = this.physicalPath(file.value, cwd, undefined);
      const area = this.landsGit(written);
      if (area) return this.block(pointed('git config', spelling(args, spelled, file.index), area));
      // A repository's configuration lies in its git directory, which a relative core.worktree starts from.
      const blocked = value === undefined ? undefined : this.coreWorktree(value.word, spelling(args, spelled, value.index), path.dirname(written));
      if (blocked) return blocked;
    }
    return undefined;
  }

  /** A core.worktree value git reads relative to the git directory `gitDir`, or to one this check does not know when absent. */
  private coreWorktree(value: string | undefined, spelled: string | undefined, gitDir: string | undefined, subject = 'core.worktree'): string | undefined {
    if (value === undefined) return this.block('core.worktree is computed, so the folder git works in cannot be read.');
    const absolute = path.isAbsolute(shellPathText(value, undefined, process.platform));
    if (!absolute && gitDir === undefined) return this.block('git reads a relative core.worktree from a git directory this check does not know, so the folder git works in cannot be read.');
    const area = this.landsGit(this.physicalPath(value, gitDir ?? this.iso.workingFolder, undefined));
    return area ? this.block(pointed(subject, spelled, area)) : undefined;
  }

  /** Whether `p` lies in the working folder or above it. */
  private aroundWorkingFolder(p: string): boolean {
    const { working } = this.protectedAreas();
    return this.formsOf(p).some((form) => working.some((root) => folderContains(root, form) || folderContains(form, root)));
  }

  /**
   * The command and configuration variables git starts with that `env` still gives it, each checked once per pass as one
   * the command sets is where it sets it; the git their text runs then skips them.
   */
  private startGitVariables(env: Env, state: ShellState): string | undefined {
    for (const [name, values] of this.startEnvironment().env) {
      if (!COMMAND_ENV.has(name) && !(GIT_CONFIG_ENV.test(name) && !GIT_CONFIG_FILE_ENV.has(name))) continue;
      for (const value of values) {
        const key = value === undefined ? name : `${name}=${value}`;
        if (!env.get(name)?.has(value) || this.startChecked.has(key)) continue;
        this.startChecked.add(key);
        if (value !== undefined) this.secret(value);
        const blocked = this.gitVariable(name, value, state);
        if (blocked) return blocked;
      }
    }
    return undefined;
  }

  /**
   * A PowerShell script run in `state`: the locations it moves to, the variables it sets and the programs it starts.
   * Text the process runs itself (Invoke-Expression) is not `defining`: its assignments never read as values.
   */
  powershell(command: string, state: ShellState, defining = true): string | undefined {
    // PowerShell reads an en or em dash as a parameter's dash.
    const source = command.replace(PS_DASHES, '-');
    const text: PsText = { id: this.walked(source, psTextScan), defining };
    const scanned = this.psParsed(source);
    if (scanned === undefined || state.depth > MAX_DEPTH) return this.block('The command could not be parsed, so its git target cannot be read.');
    if (PS_SESSION_LOCATION.test(command)) return this.block('The command changes location through the session state, which this check cannot read.');
    if (PS_DEFAULT_PARAMETERS.test(command)) return this.block('$PSDefaultParameterValues gives cmdlets parameters the text does not show, so its git target cannot be read.');
    if (PS_NATIVE_PASSING.test(command)) return this.block('$PSNativeCommandArgumentPassing changes the command lines programs get, so its git target cannot be read.');
    if (PS_PROCESS_CLASS.test(command) && PS_CREATE_CALL.test(command)) return this.block('The command starts a process through Win32_Process, which this check cannot read.');
    // A trap's `continue` resumes after the top-level statement around the error, which may end a branch or a loop partway.
    if (PS_TRAP.test(source)) state.scattered = true;
    return this.range(0, scanned.segments.length, scanned.ranges, this.psWalker(scanned.segments, text, state));
  }

  /** `source`'s statements and script blocks, scanned once per run; undefined when the text cannot be read. */
  private psParsed(source: string): { readonly segments: readonly PsSegment[]; readonly ranges: readonly PsRange[] } | undefined {
    if (!this.psParses.has(source)) {
      const segments: PsSegment[] = [];
      const ranges: PsRange[] = [];
      this.psParses.set(source, scanPowershell(source, 0, 0, segments, false, ranges) === undefined ? undefined : { segments, ranges: byNesting(ranges) });
    }
    return this.psParses.get(source);
  }

  private psWalker(segments: readonly PsSegment[], text: PsText, state: ShellState): RangeWalker<PsRange> {
    return {
      step: (k) => this.sequenced(state, segments[k]!, () => this.psStatement(segments[k]!, state, text)),
      loop: (range, body, header, inner) => this.psLoop(range, inner, segments, text, state, body, header),
    };
  }

  /**
   * A PowerShell script block that may run more than once: a `foreach` over at most MAX_LOOP_ITEMS items the text
   * gives runs once per item, with its variable bound to the item; any other is walked until its state settles. A function
   * or filter is walked once where it is defined, and recorded so that each call walks its body. An `if` branch runs whole
   * or not at all.
   */
  private psLoop(range: PsRange, inner: readonly PsRange[], segments: readonly PsSegment[], text: PsText, state: ShellState, body: () => string | undefined, header: () => string | undefined): string | undefined {
    if (range.branch === 'if') return header() ?? this.branch(state, body);
    if (range.branch === 'else') return this.branch(state, () => header() ?? this.branch(state, body));
    if (range.later) this.reading.deferred = true;
    if (range.name !== undefined) {
      state.functions.set(range.name, { segments, text, start: range.start, end: range.end, inner });
      // The definition runs nothing, so the places its walk reaches only join those it started from.
      const before = state.places;
      const blocked = header() ?? body();
      this.stand(state, joinPlaces(state.places, before));
      return blocked;
    }
    const job = range.later ? this.jobProcess(range, segments, state) : undefined;
    // A Start-Job block runs once, in a process of its own.
    if (job !== undefined) return typeof job === 'string' ? job : header() ?? this.range(range.start, range.end, inner, this.psWalker(segments, text, job));
    const { foreach } = range;
    if (foreach === undefined) return this.fixpoint(state, () => header() ?? body());
    const blocked = header();
    if (blocked) return blocked;
    const values = foreach.items.length <= MAX_LOOP_ITEMS ? foreach.items.map((item) => psValue(item.raw, item.word ?? this.psTemplate(item.template, state))) : [undefined];
    if (!allRead(values)) return this.fixpoint(state, body);
    const reference = psReference(foreach.variable);
    const bound = reference?.environment === false ? reference.name : undefined;
    const site = `${text.id}:${foreach.offset}`;
    for (const value of values) {
      if (++this.loopWalks > MAX_LOOP_WALKS) return this.loopBudget();
      if (bound !== undefined) state.bindings.set(bound, { value, site });
      const walked = body();
      if (bound !== undefined) state.bindings.delete(bound);
      if (walked) return walked;
    }
    return undefined;
  }

  /**
   * The process a Start-Job block runs in, started from `state` with its environment and none of its variables; undefined
   * when the block is not a Start-Job argument. pwsh 7 starts it in -WorkingDirectory, which Windows PowerShell 5.1 lacks;
   * without one they differ (the current location, the Documents folder), so its directory is computed.
   */
  private jobProcess(range: PsRange, segments: readonly PsSegment[], state: ShellState): ShellState | string | undefined {
    const pieces = (range.pieces ?? []).map((k) => segments[k]!);
    const command = pieces[0]?.words[0];
    if (command === undefined || !PS_START_JOB.has(commandName(command))) return undefined;
    const words: Array<string | undefined> = [];
    const raws: string[] = [];
    pieces.forEach((piece, k) => {
      piece.raws.forEach((raw, j) => {
        if (k > 0 || j > 0) {
          words.push(piece.words[j] ?? this.psTemplate(piece.templates[j], state));
          raws.push(raw);
        }
      });
      // The script block after this part of the statement.
      words.push(undefined);
      raws.push('{}');
    });
    const bound = psBind('Start-Job', PS_JOB_PARAMETERS, words, raws, []);
    if ('blocked' in bound) return this.block(bound.blocked);
    const home = this.psHome(state);
    const directory = bound.named.get('directory');
    if (directory === undefined) return spawnedPowershell(state, undefined, home);
    const dir = directory.length === 1 ? directory[0] : undefined;
    const literal = dir?.replace(/^(microsoft\.powershell\.core\\)?filesystem::/i, '');
    // The job sets its location to the value as written, from a folder the text does not give, and fails on a pattern.
    if (literal === undefined || /[*?[]/.test(literal) || !(path.isAbsolute(literal) || /^~(?:[\\/]|$)/.test(literal))) return this.block('Start-Job starts in a computed directory, so it cannot be read.');
    const moved = this.psDirectories(dir!, [this.iso.workingFolder], bound.spelled.get('directory')![0], home);
    if (typeof moved === 'string') return moved;
    return spawnedPowershell(state, startingPlaces(moved), home);
  }

  private psStatement(segment: PsSegment, state: ShellState, text: PsText): string | undefined {
    // After a jump, or in a block an error or a jump may enter, a statement may run from any place the process stood in.
    if (PS_JUMPS.has(segment.raws[0]?.toLowerCase() ?? '')) state.scattered = true;
    if (segment.raws.some((raw) => PS_RUNS_TEXT.test(raw))) return this.block('The command runs text or sets variables in a way this check cannot read.');
    if (segment.raws.some((raw) => PS_LINK_CALL.test(raw))) return this.block('The command makes a link through .NET or Win32, whose target this check does not read.');
    const site = (offset: number): string => `${text.id}:${offset}`;
    const resolved = segment.words.map((word, k) => word ?? this.psTemplate(segment.templates[k], state));
    this.psSetters(segment, resolved, site);
    for (const [k, raw] of segment.raws.entries()) {
      const call = PS_SET_ENVIRONMENT.exec(raw);
      if (!call && PS_SET_ENVIRONMENT_NAME.test(raw)) return this.block('SetEnvironmentVariable is called in a form this check cannot read.');
      const blocked = call ? this.psSetEnvironmentVariable(raw, call.index + call[0].length, state, site(segment.offsets[k]!)) : undefined;
      if (blocked) return blocked;
    }
    const { words, written, heads, raws, offsets } = psCommandTokens(segment, resolved);
    const token = words.length === 1 ? psValue(raws[0]!, words[0]) : undefined;
    // The one string the statement after an assignment outputs, as a path function gives it.
    const output = token === undefined && segment.assigns.length > 0 ? this.psOutput(segment, state) : undefined;
    const value = token ?? output;
    // A plain `=` of one token or output to one variable, in a statement that runs exactly once where the walk reaches it.
    const defines = text.defining && segment.topLevel && segment.assigns.length === 1 && (segment.raws.length === 1 || output !== undefined);
    for (const { variable, operator, offset, plain } of segment.assigns) {
      const given = operator === '=' && !segment.feeds ? value : undefined;
      this.addSite(psSiteKey(variable), site(offset));
      const blocked = this.psAssign(variable, given, state, site(offset));
      if (blocked) return blocked;
      const reference = psReference(variable);
      if (!defines || !plain || given === undefined || reference === undefined) continue;
      // An empty value removes the variable, which PowerShell then binds as $null.
      if (reference.environment) this.export(state, reference.name, given === '' ? undefined : given, site(offset));
      else state.constants.set(reference.name, { value: given, site: site(offset) });
    }
    // An expression runs nothing itself; the pipeline after an assignment, a foreach header's `in`, return or throw does.
    let at = 0;
    for (;;) {
      const lowered = raws[at]?.toLowerCase();
      if (lowered === 'return' || lowered === 'throw') {
        at++;
        continue;
      }
      // A hashtable entry: its key is a bare word, and the pipeline after `=` runs.
      if (lowered !== undefined && PS_ASSIGNMENT_OPERATOR.test(raws[at + 1] ?? '')) {
        at += 2;
        continue;
      }
      // Told by the token as written, so a value read into it never makes an expression a command name.
      if (lowered === undefined || lowered === '&' || lowered === '.' || !psExpression(written[at], raws[at]!)) break;
      let k = at;
      while (k < raws.length && (raws[k] === ',' || psExpression(written[k], raws[k]!))) k++;
      if (!PS_ASSIGNMENT_OPERATOR.test(raws[k] ?? '') && !(k === at + 1 && raws[k]?.toLowerCase() === 'in')) return undefined;
      // A multiple assignment (`$env:GIT_DIR, $x = ...`) gives each variable a value the text does not show.
      for (let n = at; n < k; n++) {
        const variable = PS_VARIABLE_TOKEN.exec(raws[n]!)?.[1];
        if (variable === undefined) continue;
        this.addSite(psSiteKey(variable), site(offsets[n]!));
        const blocked = raws[n] === `$${variable}` ? this.psAssign(variable, undefined, state, site(offsets[n]!)) : undefined;
        if (blocked) return blocked;
      }
      at = k + 1;
    }
    // pwsh on Linux and macOS defines `exec` as `Switch-Process -WithCommand $args`, which runs its words as a program.
    const invoked = raws[at] === '&' || raws[at] === '.' || raws[at]?.toLowerCase() === 'exec';
    const from = at + (invoked ? 1 : 0);
    const first = words[from];
    if (first === undefined) return invoked && from < words.length ? this.block('The command name is computed, so its git target cannot be read.') : undefined;
    const args = words.slice(from + 1);
    const argHeads = heads.slice(from + 1);
    const argRaws = raws.slice(from + 1);
    const lowered = first.toLowerCase();
    // `cd..`, `cd\` and `cd~` are functions PowerShell defines on every platform.
    const builtin = lowered === 'cd..' ? '..' : lowered === 'cd\\' ? '\\' : lowered === 'cd~' ? '~' : undefined;
    const name = builtin === undefined ? commandName(first) : 'set-location';
    if (PS_VARIABLE_CMDLETS.has(name) || (PS_TEE.has(name) && argRaws.some((raw) => /^-v/i.test(raw)))) this.poison();
    // A function runs in place of a command of its name; one defined in a scope that has ended leaves the command to run.
    const defined = state.functions.get(first.toLowerCase());
    if (defined !== undefined) {
      const blocked = this.fixpoint(state, () => this.range(defined.start, defined.end, defined.inner, this.psWalker(defined.segments, defined.text, state)));
      if (blocked) return blocked;
    }
    // Dot-sourcing anything but a literal script block, and importing a module, run code the text does not show here.
    const sourced = raws[at] === '.' || PS_IMPORT_MODULE.has(name) || (name === 'using' && args[0]?.toLowerCase() === 'module');
    // A script file runs in this process and may change its environment; plain variables it changes only through `$global:` writes.
    if (sourced || /\.psm?1$/i.test(first)) {
      // A script block walked before may run after this point, so no position orders its reads before the barrier.
      if (this.reading.deferred) this.poison();
      else if (sourced) this.barrier(state);
      else this.environmentBarrier(state);
    }
    if (name === 'switch-process') return this.block('Switch-Process replaces PowerShell with a program this check cannot read.');
    if (PS_INVOKE_METHOD.has(name) || (name === 'new-object' && args.some((word, k) => /^-c/i.test(argRaws[k]!) || /(?:^|\.)diagnostics\.process$/i.test(word ?? argHeads[k]!)))) {
      return this.block('The command starts a process or runs text in a way this check cannot read.');
    }
    // An unknown location blocks only the commands that start or move in it; the others need none.
    const located = name === 'git' || name === 'cmd' || name === 'wsl' || SHELLS.has(name) || POWERSHELLS.has(name) || PS_LOCATION.has(name) || PS_START_PROCESS.has(name);
    if (state.places === undefined && located) return this.unreadDirectory(UNREAD_DIRECTORY, true);
    // Pop-Location -StackName pops a stack this reading does not follow.
    if (name === 'pop-location' || name === 'popd') return argRaws.some((raw) => /^-s/i.test(raw) || raw.startsWith('@')) ? this.lose(state) : this.popLocation(state, 'powershell');
    if (name === 'invoke-expression' || name === 'iex') {
      const blocked = this.invokeExpression(args, argRaws, segment.piped, state);
      if (state.places !== undefined) state.places = eitherExit(state.places);
      return blocked;
    }
    if (PS_ALIAS.has(name)) return this.defines();
    if (PS_NEW_DRIVE.has(name)) return this.block('The command defines a drive, so the directories it names cannot be read.');
    if (PS_START_PROCESS.has(name)) return this.startProcess(args, argRaws, state);
    const names = (drive: RegExp): boolean => args.some((word, k) => drive.test(word ?? argHeads[k]!));
    if ((PS_ITEM_WRITE.has(name) || PS_ITEM_TRANSFER.has(name)) && names(PS_COMMAND_DRIVE)) return this.defines();
    if (PS_ITEM_TRANSFER.has(name) && names(PS_ENV_MENTION)) return this.block('The command copies an environment variable, which this check cannot follow.');
    if (PS_ITEM_WRITE.has(name) && names(PS_ENV_MENTION)) return this.psEnvironmentItem(name, args, argRaws, segment.piped, state, site(offsets[from]!));
    if (name === 'new-item' || name === 'ni') return this.psNewLink(args, argRaws, segment.piped, state);
    if (PS_LOCATION.has(name)) return this.psLocation(name, builtin, args, argRaws, segment.piped, state);
    // PowerShell passes each element of an array argument to a native program as its own argument.
    // pwsh on Linux and macOS globs an unquoted native argument, so a pattern there names the paths it matches.
    const globbed = (k: number): boolean => process.platform !== 'win32' && !PS_QUOTED_TOKEN.test(argRaws[k]!) && /[*?[]/.test(args[k] ?? argRaws[k]!);
    const kept = argRaws.flatMap((raw, k) => (raw === ',' ? [] : [k]));
    const programArgs = kept.map((k) => (globbed(k) ? undefined : args[k]));
    // Windows PowerShell 5.1 drops the quotes a backtick escapes in a native argument, and no Windows path holds one.
    const programWords = name === 'git' ? programArgs.map((w) => w?.replaceAll('"', '')) : programArgs;
    // `--%` passes the rest of the statement as written, which this reading does not follow.
    const commandLine: CommandLine = (words, program) => (argRaws.includes('--%') ? undefined : psCommandLines(words, program));
    return this.program(name, programWords, state.env, state, kept.map((k) => argRaws[k]!), commandLine);
  }

  /** A token's text with each variable and subexpression it expands read as its value; undefined when one does not read. */
  private psTemplate(template: readonly PsPart[] | undefined, state: ShellState): string | undefined {
    if (template === undefined) return undefined;
    let text = '';
    for (const part of template) {
      if (typeof part === 'string') {
        text += part;
        continue;
      }
      if ('statement' in part) {
        const value = this.psStatementValue(part.statement, state);
        if (value === undefined) return undefined;
        text += value;
        continue;
      }
      const reference = psReference(part.variable);
      const value = reference === undefined ? undefined : this.lookup(state, reference.name, reference.key, reference.environment ? 'environment' : 'powershell');
      if (value === undefined) return undefined;
      text += value;
    }
    return text;
  }

  /**
   * The one string a subexpression's statement outputs: a string, a variable or a subexpression token, or a path
   * function with readable operands; undefined for anything else.
   */
  private psStatementValue(segment: PsSegment, state: ShellState): string | undefined {
    // An assignment outputs nothing.
    return segment.assigns.length > 0 ? undefined : this.psOutput(segment, state);
  }

  /** The one string the pipeline of a statement's tokens outputs, as for `psStatementValue`; any assignment is left out. */
  private psOutput(segment: PsSegment, state: ShellState): string | undefined {
    const { raws } = segment;
    if (raws.some((raw) => raw === '&' || PS_REDIRECTION.test(raw))) return undefined;
    const words = segment.words.map((word, k) => word ?? this.psTemplate(segment.templates[k], state));
    if (raws.length === 1 && psOperand(raws[0]!, segment.templates[0])) return words[0];
    const call = PS_COMBINE.exec(raws[0]!);
    if (call !== null) return raws.length === 1 ? this.psCombine(raws[0]!, call[0].length, state) : undefined;
    if (segment.words[0] === undefined || psExpression(segment.words[0], raws[0]!)) return undefined;
    const name = commandName(segment.words[0]);
    const args = words.slice(1);
    const argRaws = raws.slice(1);
    // A number in argument mode binds as the number's text, not as written.
    const operand = (bound: PsBound, kind: PsParameterKind): string | undefined => {
      const values = bound.named.get(kind);
      const spelled = bound.spelled.get(kind);
      return values?.length === 1 && spelled !== undefined && !/^[-+]?\.?\d/.test(spelled[0]!) ? values[0] : undefined;
    };
    if (name === 'join-path') {
      const bound = psBind('Join-Path', PS_JOIN_PARAMETERS, args, argRaws, ['path', 'child', 'unread']);
      if ('blocked' in bound || [...bound.named.keys()].some((kind) => kind !== 'path' && kind !== 'child')) return undefined;
      const parent = operand(bound, 'path');
      const child = operand(bound, 'child');
      return parent === undefined || child === undefined ? undefined : psJoinPath(parent, child, this.drives());
    }
    if (name === 'split-path') {
      const bound = psBind('Split-Path', PS_SPLIT_PARAMETERS, args, argRaws, ['path', 'unread']);
      if ('blocked' in bound) return undefined;
      const switches = [...bound.named].filter(([kind]) => kind !== 'path');
      // A switch given a value (`-Leaf:$false`) is not read.
      if (switches.length > 1 || switches.some(([, value]) => value.length > 0)) return undefined;
      const part = switches[0]?.[0] ?? 'parent';
      const text = operand(bound, 'path');
      return text === undefined || (part !== 'parent' && part !== 'leaf' && part !== 'qualifier') ? undefined : psSplitPath(text, part, this.drives());
    }
    return undefined;
  }

  /** The Windows drive letters known to exist, upper case: those of the working folder, the project, its repository and the home folder. */
  private drives(): ReadonlySet<string> {
    const paths = [this.iso.workingFolder, this.iso.projectPath, this.iso.repositoryRoot, this.iso.homeDir];
    return new Set(paths.flatMap((p) => /^([A-Za-z]):/.exec(p)?.[1]?.toUpperCase() ?? []));
  }

  /** `[IO.Path]::Combine(...)` in `raw`, its arguments from `open`, each a string, variable or subexpression token. */
  private psCombine(raw: string, open: number, state: ShellState): string | undefined {
    if (!this.combineArguments.has(raw)) {
      const found: PsSegment[] = [];
      const own = scanPowershell(raw, open, 1, found) === raw.length - 1 ? found.filter((segment) => segment.depth === 1) : [];
      this.combineArguments.set(raw, own.length === 1 ? own[0] : undefined);
    }
    const call = this.combineArguments.get(raw);
    if (call === undefined) return undefined;
    const args: string[] = [];
    for (let k = 0; k < call.raws.length; k += 2) {
      const value = call.words[k] ?? this.psTemplate(call.templates[k], state);
      if (value === undefined || !psOperand(call.raws[k]!, call.templates[k]) || (k + 1 < call.raws.length && call.raws[k + 1] !== ',')) return undefined;
      args.push(value);
    }
    return pathCombine(args);
  }

  /** The sites and poisons a statement shows once its words are read: output variables, splatting and `env:` paths. */
  private psSetters(segment: PsSegment, words: ReadonlyArray<string | undefined>, site: (offset: number) => string): void {
    for (const [k, raw] of segment.raws.entries()) {
      // A splatted hashtable binds parameters, -OutVariable among them, by keys the text holds as data.
      if (PS_SPLAT.test(raw)) this.poison();
      const parameter = /^-([A-Za-z]+)(:?)/.exec(raw);
      if (parameter && psOutVariable(parameter[1]!)) {
        const given = parameter[2] === ':' ? words[k]?.slice(parameter[0].length) : k + 1 < words.length ? words[k + 1] : '';
        const variable = given?.replace(/^\+/, '');
        if (variable === undefined) this.poison();
        else if (variable !== '') this.addSite(psSiteKey(variable), site(segment.offsets[k]!));
      }
      // An `env:` item path, which Remove-Item, Clear-Item or a pipeline from Get-Item can unset.
      const item = words[k] ?? segment.heads[k]!;
      const drive = PS_ENV_MENTION.exec(item);
      if (!drive) continue;
      const variable = item.slice(drive[0].length).replace(/^[\\/]/, '');
      if (words[k] === undefined || variable === '' || /[*?[]/.test(variable)) this.poison();
      else this.addSite(siteKey(variable), site(segment.offsets[k]!));
    }
  }

  private defines(): string {
    return this.block('The command defines an alias or a function, so the command it runs cannot be read.');
  }

  /** An assignment to a drive-qualified variable: `env:` sets an environment variable, `alias:` and `function:` define a command. */
  private psAssign(variable: string, value: string | undefined, state: ShellState, site: string): string | undefined {
    const { qualifier, name } = psVariable(variable);
    if (qualifier === 'env') return this.psSetVariable(name, value, state, site);
    return qualifier === 'alias' || qualifier === 'function' ? this.defines() : undefined;
  }

  /** Sets an environment variable PowerShell names case-insensitively, as git on Windows reads it. */
  private psSetVariable(name: string, value: string | undefined, state: ShellState, site: string): string | undefined {
    this.addSite(siteKey(name), site);
    const upper = name.toUpperCase();
    const blocked = this.gitVariable(upper, value, state);
    if (!blocked) widen(state.env, upper, value);
    return blocked;
  }

  /** `[Environment]::SetEnvironmentVariable(name, value[, target])`, its arguments from `open` in `raw`; every target counts. */
  private psSetEnvironmentVariable(raw: string, open: number, state: ShellState, site: string): string | undefined {
    const found: PsSegment[] = [];
    if (scanPowershell(raw, open, 1, found) === undefined) return this.block('SetEnvironmentVariable takes arguments this check cannot read.');
    const call = found.at(-1);
    if (call === undefined) return undefined;
    const words = call.words.map((word, k) => word ?? this.psTemplate(call.templates[k], state));
    const elements: Array<Array<string | undefined>> = [[]];
    call.raws.forEach((r, k) => (r === ',' ? elements.push([]) : elements.at(-1)!.push(words[k])));
    const [variable, value = []] = elements;
    if (variable!.length !== 1 || variable![0] === undefined) return this.block('SetEnvironmentVariable names a computed variable, so the git target cannot be read.');
    return this.psSetVariable(variable![0], value.length === 1 ? value[0] : undefined, state, site);
  }

  /** Set-Item, New-Item and the content cmdlets on the Env: drive. */
  private psEnvironmentItem(name: string, args: Array<string | undefined>, raws: readonly string[], piped: boolean, state: ShellState, site: string): string | undefined {
    const bound = psBind(name, PS_ITEM_PARAMETERS, args, raws, ['path', 'content']);
    if ('blocked' in bound) return this.block(bound.blocked);
    const content = name === 'add-content' || name === 'ac' ? [undefined] : bound.named.get('content') ?? (piped ? [undefined] : ['']);
    const value = content.length === 1 ? content[0] : undefined;
    const spelled = bound.spelled.get('path') ?? [];
    for (const [k, item] of (bound.named.get('path') ?? []).entries()) {
      if (item === undefined) return this.block('The command names an environment variable by computed text, so the git target cannot be read.');
      const drive = PS_ENV_MENTION.exec(item);
      if (!drive) continue;
      let variable: string | undefined = item.slice(drive[0].length).replace(/^[\\/]/, '');
      if (variable === '') {
        const named = bound.named.get('name');
        variable = named?.length === 1 ? named[0] : undefined;
      }
      if (variable === undefined || /[*?[]/.test(variable)) return this.block(worded(spelled[k], (word) => `${word} names environment variables this check cannot read.`, 'The command names environment variables this check cannot read.'));
      const blocked = this.psSetVariable(variable, value, state, site);
      if (blocked) return blocked;
    }
    return undefined;
  }

  /**
   * A link New-Item makes: a junction and a hard link read a relative target from the current location; a symbolic link
   * reads it from the link's folder in pwsh 7 and from the location in Windows PowerShell 5.1.
   */
  private psNewLink(args: Array<string | undefined>, raws: readonly string[], piped: boolean, state: ShellState): string | undefined {
    const bound = psBind('New-Item', PS_NEW_ITEM_PARAMETERS, args, raws, ['path']);
    if ('blocked' in bound) return this.block(bound.blocked);
    const kinds = psLinkKinds(bound.named.get('itemtype'));
    // -Value takes pipeline input; without a value New-Item makes no link.
    const value = bound.named.get('content') ?? (piped ? [undefined] : []);
    if (kinds.size === 0 || value.length === 0) return undefined;
    const target = value.length === 1 ? value[0] : undefined;
    if (target === undefined) return this.block('New-Item makes a link to a computed path, so where it reaches cannot be read.');
    if (state.places === undefined) return this.unreadDirectory(UNREAD_DIRECTORY, true);
    const literal = psFileSystemPath(target);
    if (/^[^\\/:]{2,}:/.test(literal)) return this.block('New-Item makes a link to a path on a drive this check cannot read.');
    if (state.home === undefined && /^~(?:[\\/]|$)/.test(literal)) return this.block('The home folder of this PowerShell process is computed, so where the link reaches cannot be read.');
    // The link is -Path, or -Path joined with -Name; without -Path, -Name in the current location.
    const names = bound.named.get('name') ?? [''];
    const links = (bound.named.get('path') ?? ['.']).flatMap((folder) => names.map((name) => (folder === undefined || name === undefined ? undefined : pathFor(process.platform).join(psFileSystemPath(folder), psFileSystemPath(name)))));
    const absolute = path.isAbsolute(shellPathText(literal, state.home, process.platform));
    if (kinds.has('symbolic') && !absolute && !allRead(links)) return this.block('New-Item makes a link in a computed folder, so where its relative target reaches cannot be read.');
    const spelled = bound.spelled.get('content')?.[0];
    for (const cwd of directories(state.places)) {
      const folders = kinds.has('symbolic') && !absolute ? (links as string[]).flatMap((link) => [nativeShellPath(link, cwd, state.home), this.physicalPath(link, cwd, state.home)].map((made) => path.dirname(made))) : [];
      const blocked = this.linkReaches(literal, [cwd, ...folders], state.home, spelled);
      if (blocked) return blocked;
    }
    return undefined;
  }

  /** Invoke-Expression runs its text in this scope, so its locations and variables reach the statements after it. */
  private invokeExpression(args: Array<string | undefined>, raws: readonly string[], piped: boolean, state: ShellState): string | undefined {
    const bound = psBind('Invoke-Expression', PS_IEX_PARAMETERS, args, raws, ['path']);
    if ('blocked' in bound) return this.block(bound.blocked);
    const text = bound.named.get('path');
    if (text === undefined && !piped) return undefined;
    if (text === undefined || text.length !== 1 || text[0] === undefined) return this.block('Invoke-Expression runs computed text, so its git target cannot be read.');
    state.depth++;
    const blocked = this.powershell(text[0], state, false);
    state.depth--;
    return blocked;
  }

  /** Start-Process starts its program in -WorkingDirectory, else in the current location, with this environment. */
  private startProcess(args: Array<string | undefined>, raws: readonly string[], state: ShellState): string | undefined {
    const bound = psBind('Start-Process', PS_START_PARAMETERS, args, raws, ['file', 'arguments']);
    if ('blocked' in bound) return this.block(bound.blocked);
    if (bound.named.has('environment')) return this.block('Start-Process -Environment sets variables this check cannot read.');
    const file = bound.named.get('file');
    if (file === undefined) return undefined;
    if (file.length !== 1 || file[0] === undefined) return this.block('Start-Process starts a computed program, so its git target cannot be read.');
    let cwds: Iterable<string> = directories(state.places!);
    const directory = bound.named.get('directory');
    if (directory !== undefined) {
      // -WorkingDirectory takes wildcards, as -Path does.
      if (directory.length !== 1 || directory[0] === undefined || PS_WILDCARD.test(directory[0])) return this.block('Start-Process starts in a computed directory, so it cannot be read.');
      const moved = this.psDirectories(psUnescape(directory[0]), cwds, bound.spelled.get('directory')![0], state.home);
      if (typeof moved === 'string') return moved;
      cwds = moved;
    }
    const name = commandName(file[0]);
    const elements = bound.named.get('arguments') ?? [];
    if (name === 'git' && elements.includes(undefined)) return this.block('Start-Process passes git a computed argument, so its target cannot be read.');
    // The elements reach the program as one command line, joined by spaces and split again by its runtime.
    const line = elements.includes(undefined) ? undefined : elements.join(' ');
    // A new environment, another user's or an elevated process's is built from the system, not from this process; a
    // parameter that may abbreviate one of them counts.
    const fresh = raws.some((raw) => {
      const spelled = /^-([a-z]+)/i.exec(raw)?.[1]?.toLowerCase();
      return spelled !== undefined && PS_FRESH_ENVIRONMENT.some((parameter) => parameter.startsWith(spelled));
    });
    // A word split from an element that expands a variable has no spelling of its own.
    const unspelled = (bound.spelled.get('arguments') ?? []).some((raw) => raw.includes('$'));
    for (const words of line === undefined ? [[undefined]] : nativeArgumentReadings(line, name)) {
      const started = spawned(state, startingPlaces(cwds), state.env, fresh ? unknownEnvironment() : inherit(state.environment));
      const blocked = this.program(name, words, state.env, started, unspelled ? words.map(() => undefined) : undefined, () => (line === undefined ? undefined : [line]));
      if (blocked) return blocked;
    }
    return undefined;
  }

  private psLocation(name: string, builtin: string | undefined, args: Array<string | undefined>, raws: readonly string[], piped: boolean, state: ShellState): string | undefined {
    let target: Array<string | undefined> | undefined = builtin === undefined ? undefined : [builtin];
    let spelled: string[] = [];
    let stackName = false;
    if (builtin === undefined) {
      const bound = psBind('Set-Location', PS_LOCATION_PARAMETERS, args, raws, ['path']);
      if ('blocked' in bound) return this.block(bound.blocked);
      stackName = bound.named.has('stackname');
      const literal = bound.named.get('literalpath');
      // -Path takes wildcards, and the folder a pattern matches is not in the text.
      target = bound.named.get('path')?.map((p) => (p === undefined || PS_WILDCARD.test(p) ? undefined : psUnescape(p)));
      if (literal !== undefined) target = [...(target ?? []), ...literal];
      spelled = [...(bound.spelled.get('path') ?? []), ...(bound.spelled.get('literalpath') ?? [])];
    }
    // A location cmdlet without a path in a later pipeline element takes it from the pipeline.
    if (target === undefined && piped) return this.block('Set-Location takes its directory from the pipeline, so it is computed.');
    const push = name === 'push-location' || name === 'pushd';
    // Push-Location without a path pushes the location and stays; Set-Location without one goes home.
    const targets = target ?? (push ? [] : ['~']);
    if (target?.length === 0 || !allRead(targets)) return this.block('The directory Set-Location changes to is computed, so it cannot be read.');
    // PowerShell's location history (`-`, `+`) holds only locations the process stood in.
    const history = targets.some((directory) => directory === '-' || directory === '+') ? state.seen : new Map<string, Place>();
    if (history === undefined) {
      this.stand(state, undefined);
      return undefined;
    }
    const next: Place[] = [];
    for (const place of state.places!) {
      // Push-Location pushes even where it fails to move, and Set-Location then stays put.
      const stack = push ? [...place.stack, place.dir] : place.stack;
      next.push({ ...place, stack, exits: targets.length === 0 ? SUCCEEDED : FAILED });
      for (const [k, directory] of targets.entries()) {
        const moved = directory === '-' || directory === '+' ? [...history.values()].map((seen) => seen.dir) : this.psDirectories(directory, [place.dir], spelled[k] ?? directory, state.home);
        if (typeof moved === 'string') return moved;
        for (const dir of moved) next.push({ dir, stack, previous: place.previous, exits: SUCCEEDED });
      }
    }
    // Another stack, or another default one, holds what Push-Location pushes and Pop-Location pops.
    if (stackName) return this.lose(state);
    if (push) this.narrow(state, joinPlaces(next));
    else this.stand(state, joinPlaces(next));
    return undefined;
  }

  /**
   * The folders a PowerShell directory names from each of `cwds`, `~` being `home`, or the block reason when one lies in a
   * protected area or `~` is computed; the reason names it as `spelled`.
   */
  private psDirectories(directory: string, cwds: Iterable<string>, spelled: string | undefined, home: string | undefined): string | Set<string> {
    const literal = directory.replace(/^(microsoft\.powershell\.core\\)?filesystem::/i, '');
    if (/^[^\\/:]{2,}:/.test(literal)) return this.block(worded(spelled, (word) => `${word} is on a drive this check cannot read.`, 'A path the command builds is on a drive this check cannot read.'));
    if (home === undefined && /^~(?:[\\/]|$)/.test(literal)) return this.block('The home folder of this PowerShell process is computed, so the directory cannot be read.');
    // pwsh on Linux and macOS turns every `\` of a provider path into `/` (FileSystemProvider.NormalizePath).
    const native = process.platform === 'win32' ? literal : literal.replaceAll('\\', '/');
    const next = new Set<string>();
    for (const cwd of cwds) {
      const candidate = nativeShellPath(native, cwd, home, process.platform);
      const area = this.landsGit(candidate);
      if (area) return this.block(inArea(spelled, area));
      next.add(candidate);
    }
    return next;
  }
}

/** A FileSystem provider path as PowerShell reads it: without a `FileSystem::` prefix, and off Windows each `\` a `/`. */
function psFileSystemPath(text: string): string {
  const literal = text.replace(/^(microsoft\.powershell\.core\\)?filesystem::/i, '');
  return process.platform === 'win32' ? literal : literal.replaceAll('\\', '/');
}

/**
 * An absolute Windows path as Win32 opens it (`GetFullPathName`): the last segment without its trailing dots and spaces,
 * and an earlier segment that ends in one `.` without it.
 */
function win32Trimmed(p: string): string {
  const { root } = path.win32.parse(p);
  const segments = p.slice(root.length).split(/[\\/]/);
  const last = segments.length - 1;
  return root + segments.map((segment, k) => (k === last ? segment.replace(/[. ]+$/, '') : segment.replace(/(?<=[^.])\.$/, ''))).join('\\');
}

/** A Windows command line split as the C runtime splits it: on whitespace outside double quotes, `\"` a literal quote. */
function windowsArguments(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && line[i + 1] === '"') {
      word += '"';
      inWord = true;
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
      inWord = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/**
 * The argument lists a program's runtime may split `line` into, a word undefined where computed text decides it: the C
 * runtime's split, and for git and the shells, which Git for Windows builds on MSYS2, also MSYS2's.
 */
function nativeArgumentReadings(line: string, name: string): Array<Array<string | undefined>> {
  const windows = windowsArguments(line).map((word) => (word.includes(COMPUTED_TEXT) ? undefined : word));
  return name === 'git' || SHELLS.has(name) ? [windows, msysArguments(line)] : [windows];
}

/**
 * A command line split as an MSYS2 program started from Windows splits it (`build_argv` and `globify` in `dcrt0.cc`):
 * `"` and `'` quote, and a word that globs, expands `~` or `{}`, reads an `@file`, or holds an escape whose reading
 * depends on the word's form is computed.
 */
function msysArguments(line: string): Array<string | undefined> {
  const words: Array<string | undefined> = [];
  for (let i = 0; i < line.length; ) {
    if (/[ \t\r\n]/.test(line[i]!)) {
      i++;
      continue;
    }
    const start = i;
    let literal = '';
    let computed = false;
    let pattern = false;
    for (; i < line.length && !/[ \t\r\n]/.test(line[i]!); i++) {
      const ch = line[i]!;
      if (ch !== '"' && ch !== "'") {
        pattern ||= /[*?[{]/.test(ch);
        literal += ch;
        continue;
      }
      let j = i + 1;
      for (; j < line.length && line[j] !== ch; j++) {
        // `\"` and `""` inside double quotes escape a quote, which changes where the word ends.
        if (ch === '"' && line[j] === '\\' && line[j + 1] === '"') computed = true;
        literal += line[j];
      }
      if (ch === '"' && line[j + 1] === '"') computed = true;
      i = j;
    }
    const raw = line.slice(start, i);
    const special = raw.startsWith('~') || /[?*["'(){}]/.test(raw);
    // globify reads `\` by the word's form: literal after a drive, an escape otherwise.
    const escapes = special && raw.includes('\\') && !/^["']?[A-Za-z]:/.test(raw);
    const unread = computed || pattern || raw.startsWith('~') || escapes || (words.length > 0 && raw.startsWith('@')) || raw.includes(COMPUTED_TEXT);
    words.push(unread ? undefined : special ? literal : raw);
  }
  return words;
}

/** The command lines an argument list gives the program `name` as the caller may build them, or undefined when an argument is computed. */
type CommandLine = (args: ReadonlyArray<string | undefined>, name: string) => readonly string[] | undefined;

/**
 * Git Bash's command line (MSYS2 `linebuf::fromargv`): an argument with whitespace or `"`, or an empty one, is quoted, its
 * `"` escaped and the backslashes before a `"` or its end doubled; a leading `//` with no later `/` loses one slash.
 */
const msysCommandLine: CommandLine = (args) => {
  if (!allRead(args)) return undefined;
  const quote = (arg: string): string => {
    const word = /^\/\/[^/]*$/.test(arg) ? arg.slice(1) : arg;
    if (word !== '' && !/[ \t\n\r"]/.test(word)) return word;
    return `"${word.replace(/(\\*)("|$)/g, (_, slashes: string, mark: string) => slashes + slashes + (mark === '"' ? '\\"' : ''))}"`;
  };
  return [args.map(quote).join(' ')];
};
