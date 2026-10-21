// D62: a worktree chat stays inside its worktree. The gate blocks, in every mode, writes and working directories in the
// project folder or another worktree of the project, and git commands aimed there. It reads paths and command text, so it is
// a guard against wrong-copy mistakes, not a sandbox (docs/invariants.md "Worktree chats").
import * as path from 'node:path';
import { canonicalPath, spelledPath } from '../canonical-path';
import { TOOL_BASH, TOOL_POWERSHELL, WRITE_TOOLS } from '../../shared/tool-names';
import { folderContains } from '../worktrees/records';
import { COMPUTED_TEXT, DECLARATION_BUILTINS, parseShellStructure, type ShellStructure } from './readonly-shell';
import { resolveToCwd } from './tools/search-tools';

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
}

const PROJECT_FOLDER = 'the project folder';
const OTHER_WORKTREE = 'another worktree of the project';
const PROJECT_REPOSITORY = "the project's repository";

interface Area {
  readonly name: string;
  readonly roots: readonly string[];
}

/** A shell path as Windows sees it: `~`, and the `/c/...`, `/cygdrive/c/...` and `/mnt/c/...` drive forms of Git Bash and WSL. */
function shellPathText(text: string, homeDir: string, platform: NodeJS.Platform): string {
  let p = text;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = pathFor(platform).join(homeDir, p.slice(1));
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
export function nativeShellPath(text: string, cwd: string, homeDir: string, platform: NodeJS.Platform = process.platform): string {
  return pathFor(platform).resolve(cwd, shellPathText(text, homeDir, platform));
}

function reason(iso: WorktreeIsolation, detail: string): string {
  return `${WORKTREE_ISOLATION_REASON} ${detail} Work in ${iso.workingFolder} instead.`;
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
    const run = new IsolationRun(iso, command);
    return run.powershell(command, run.initialState());
  }
  // pi's bash tool runs `${commandPrefix}\n${command}` when the prefix is set.
  const script = iso.commandPrefix ? `${iso.commandPrefix}\n${command}` : command;
  const run = new IsolationRun(iso, script);
  return run.script(parseShellStructure(script), run.initialState());
}

const GIT_PATH_ENV: ReadonlySet<string> = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']);
// Variables whose text git runs through a shell, its PAGER, EDITOR and VISUAL fallbacks included.
const COMMAND_ENV: ReadonlySet<string> = new Set(['GIT_SSH_COMMAND', 'GIT_PAGER', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_EXTERNAL_DIFF', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND', 'PAGER', 'EDITOR', 'VISUAL']);
// Configuration keys whose value git runs through a shell (a credential helper after its `!`).
const GIT_COMMAND_CONFIG = /^(core\.(sshcommand|pager|editor|askpass|fsmonitor|gitproxy)|sequence\.editor|diff\.external|interactive\.difffilter|pager\.[^=]+|filter\.[^=]+\.(clean|smudge|process)|diff\.[^=]+\.(command|textconv)|merge\.[^=]+\.driver|credential(\.[^=]+)?\.helper|gpg(\.[^=]+)?\.program|remote\.[^=]+\.(uploadpack|receivepack))=/i;
// Variables through which git takes configuration (core.worktree among it) from the environment.
const GIT_CONFIG_ENV = /^GIT_CONFIG(_PARAMETERS|_COUNT|_KEY_\d+|_VALUE_\d+|_GLOBAL|_SYSTEM)?$/;

/** A variable whose computed value hides where git or a cd goes. */
function targetVariable(name: string): boolean {
  return GIT_PATH_ENV.has(name) || COMMAND_ENV.has(name) || GIT_CONFIG_ENV.test(name) || name === 'CDPATH';
}

/** The name a bash variable is checked and kept under: git on Windows reads its environment without case, bash reads CDPATH with case. */
function envName(name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return name;
  const upper = name.toUpperCase();
  return upper === 'CDPATH' ? name : upper;
}

// Variables bash sets itself, some from text the command chose (`read` sets REPLY, `cd` PWD).
const SHELL_SET_VARIABLE = /^(_|REPLY|MAPFILE|OPTARG|OPTIND|PWD|OLDPWD|DIRSTACK|COPROC|FUNCNAME|HISTCMD|BASH\w*|COMP\w*|READLINE\w*)$/;

/** Whether the command cannot set `name`: every mention of it is a plain `$name` or `${name}` and bash does not set it. */
function fromOutside(name: string, script: string): boolean {
  if (SHELL_SET_VARIABLE.test(name)) return false;
  for (const mention of script.matchAll(new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'g'))) {
    const before = script.slice(0, mention.index);
    if (before.endsWith('$') || (before.endsWith('${') && script[mention.index + name.length] === '}')) continue;
    return false;
  }
  return true;
}

/**
 * The text a command variable's written value gives the shell git starts, each `$name` or `${name}` the command cannot set
 * written as computed text; undefined when another part is computed. That shell parses the expanded text again, so a
 * variable the command sets could carry a whole command.
 */
function outsideValueText(raw: string, script: string): string | undefined {
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
      const reference = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/.exec(raw.slice(i));
      if (reference) {
        if (!fromOutside(reference[1] ?? reference[2]!, script)) return undefined;
        text += COMPUTED_TEXT;
        i += reference[0].length - 1;
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
// These take options after operands too (GNU getopt's permutation).
const PERMUTING: ReadonlySet<string> = new Set(['script', 'su', 'runuser']);
// The separators before GNU parallel's input sources.
const PARALLEL_SOURCES: ReadonlySet<string> = new Set([':::', '::::', ':::+', '::::+']);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;
const READERS: ReadonlySet<string> = new Set(['read', 'mapfile', 'readarray', 'printf', 'getopts']);
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'fish', 'tcsh', 'csh']);
// Long options of those shells that take no value; any other long option may consume the next word.
const SHELL_FLAG_OPTIONS: ReadonlySet<string> = new Set(['--login', '--noprofile', '--norc', '--posix', '--restricted', '--verbose', '--version', '--noediting', '--debugger', '--help', '--interactive', '--no-config', '--private']);
const SHELL_VALUE_OPTIONS: ReadonlySet<string> = new Set(['--rcfile', '--init-file']);
// Only fish's -C (--init-command) takes a value; in the other shells -C is the noclobber flag.
const FISH_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '--init-command']);
// git's global options that take no value; any other option before the subcommand either is handled below or blocks.
const GIT_FLAG_OPTIONS: ReadonlySet<string> = new Set(['-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-advice', '--version', '--help', '--html-path', '--man-path', '--info-path', '--no-lazy-fetch']);
const POWERSHELLS: ReadonlySet<string> = new Set(['pwsh', 'powershell']);
// wsl.exe's arguments, from `wsl.h` and the parser in `WslClient.cpp` (microsoft/WSL).
const WSL_GUID = /^(?:\{[0-9a-f-]{36}\}|[0-9a-f-]{36})$/i;
const WSL_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-d', '--distribution', '--distribution-id', '-u', '--user', '--parent-console']);
const WSL_MANAGEMENT: ReadonlySet<string> = new Set([
  '--help', '--update', '--export', '--import', '--import-in-place', '-l', '--list', '-s', '--setdefault', '--set-default', '-t', '--terminate',
  '--unregister', '--set-default-version', '--shutdown', '--manage', '--set-version', '--mount', '--unmount', '--install', '--status', '-v',
  '--version', '--uninstall',
]);
const CD_COMMANDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'chdir']);
// Past this many possible working directories the parse stops following them and blocks a later git or cd.
const MAX_CWD_CANDIDATES = 32;
const MAX_DEPTH = 6;

function commandName(word: string): string {
  return path.basename(word.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
}

/** Every value each variable may hold, undefined for a computed one. */
type Env = Map<string, ReadonlySet<string | undefined>>;

/** An assignment may run in a subshell or a branch not taken, so the earlier values stay possible, as directories do. */
function widen(env: Env, name: string, value: string | undefined): void {
  env.set(name, new Set([...(env.get(name) ?? []), value]));
}

// /dev/stdin and the descriptor files: a script operand there is read from input.
const INPUT_FILE = /^\/(?:dev\/(?:stdin|fd\/\d+)|proc\/[^/]+\/(?:task\/[^/]+\/)?fd\/\d+)$/;

interface ShellState {
  /** Every directory the shell may be in: a cd that fails or runs in a subshell leaves the earlier ones possible. */
  cwds: Set<string> | undefined;
  readonly stack: Array<Set<string> | undefined>;
  readonly env: Env;
  /** The trap actions this shell set; each may run again wherever the shell has moved by then. */
  readonly traps: string[];
  depth: number;
}

class IsolationRun {
  private readonly iso: WorktreeIsolation;
  /** The whole command checked, bash's command prefix and every encoded PowerShell command it decodes included. */
  private text: string;
  private readonly canonical = new Map<string, string>();
  private readonly forms = new Map<string, readonly string[]>();
  private areas: { working: readonly string[]; edits: readonly Area[]; git: readonly Area[] } | undefined;

  constructor(iso: WorktreeIsolation, text = '') {
    this.iso = iso;
    this.text = text;
  }

  initialState(): ShellState {
    return { cwds: new Set([this.iso.workingFolder]), stack: [], env: new Map(), traps: [], depth: 0 };
  }

  private block(detail: string): string {
    return reason(this.iso, detail);
  }

  private canonicalOf(p: string): string {
    let resolved = this.canonical.get(p);
    if (resolved === undefined) {
      resolved = canonicalPath(p);
      this.canonical.set(p, resolved);
    }
    return resolved;
  }

  // Both the link-resolved and the as-spelled forms, so a link, junction, 8.3 name or `\\?\` prefix lands on one of them.
  private formsOf(p: string): readonly string[] {
    let result = this.forms.get(p);
    if (result === undefined) {
      result = [...new Set([this.canonicalOf(p), spelledPath(p), path.resolve(p)])];
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

  private landsGit(target: string): string | undefined {
    const areas = this.protectedAreas();
    return this.lands(target, areas.git, areas.working);
  }

  /** A path the OS opens or changes to: each `..` leaves the directory the prefix really is, through any link. */
  private physicalPath(text: string, cwd: string): string {
    const p = shellPathText(text, this.iso.homeDir, process.platform);
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

  /** A whole shell script: its commands, then the traps it set, which run where the shell has moved by then. */
  script(structure: ShellStructure, state: ShellState): string | undefined {
    const blocked = this.bash(structure, state);
    if (blocked) return blocked;
    for (let runs = 0; state.traps.length > 0; runs++) {
      if (runs > MAX_DEPTH) return this.block('The command sets too many traps to read its git target.');
      const later = this.nested(state.traps.shift()!, state);
      if (later) return later;
    }
    return undefined;
  }

  /** Text the current shell runs itself (eval, a trap), so its cd and variables reach the commands after it. */
  private nested(text: string, state: ShellState): string | undefined {
    state.depth++;
    const blocked = this.bash(parseShellStructure(text), state);
    state.depth--;
    return blocked;
  }

  /** A new shell process: it starts where this one may be and none of its changes come back. */
  private childShell(text: string, state: ShellState, env: Env, extraCwd?: string): string | undefined {
    const cwds = state.cwds === undefined ? undefined : new Set(extraCwd === undefined ? state.cwds : [...state.cwds, extraCwd]);
    return this.script(parseShellStructure(text), { cwds, stack: [], env: new Map(env), traps: [], depth: state.depth + 1 });
  }

  private bash(structure: ShellStructure, state: ShellState): string | undefined {
    if (structure.unparsable) return this.block('The command could not be parsed, so its git target cannot be read.');
    if (state.depth > MAX_DEPTH) return this.block('The command nests too deeply to read its git target.');
    for (const segment of structure.segments) {
      for (const inner of segment.substitutions) {
        // A substitution runs in a subshell, with its own variables, directory stack and traps.
        const blocked = this.script(inner, { ...state, env: new Map(state.env), stack: [...state.stack], traps: [], depth: state.depth + 1 });
        if (blocked) return blocked;
      }
      const localEnv = new Map(state.env);
      for (const { name, value, raw } of segment.assignments) {
        const blocked = this.checkEnv(name, value, state, raw);
        if (blocked) return blocked;
        localEnv.set(envName(name), new Set([value]));
      }
      if (segment.words.length === 0) {
        for (const { name, value } of segment.assignments) widen(state.env, envName(name), value);
        continue;
      }
      const blocked = this.command([...segment.words], localEnv, state, segment.rawWords);
      if (blocked) return blocked;
    }
    return undefined;
  }

  /** A bash assignment's check; `raw` is its value as written, when the text gives it. */
  private checkEnv(name: string, value: string | undefined, state: ShellState, raw?: string): string | undefined {
    return this.gitVariable(envName(name), value, state, raw === undefined ? undefined : () => outsideValueText(raw, this.text));
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
    if (state.cwds === undefined) return this.block('The working directory cannot be read.');
    const parts = name === 'CDPATH' || name === 'GIT_ALTERNATE_OBJECT_DIRECTORIES' ? value.split(/[:;]/) : [value];
    for (const cwd of state.cwds) {
      for (const part of parts) {
        if (part === '') continue;
        // cd takes CDPATH entries as it takes its operand; git opens its paths through the file system.
        const target = name === 'CDPATH' ? nativeShellPath(part, cwd, this.iso.homeDir) : this.physicalPath(part, cwd);
        const area = this.landsGit(target);
        if (area) return this.block(`${name} points git at ${area}.`);
      }
    }
    return undefined;
  }

  /** Text git hands to a shell, from the working directory or the worktree's top level. */
  private gitRunsCommand(text: string, state: ShellState): string | undefined {
    return text === '' ? undefined : this.childShell(text, state, state.env, this.iso.workingFolder);
  }

  private command(words: Array<string | undefined>, env: Env, state: ShellState, rawWords: readonly string[] = []): string | undefined {
    const first = words[0];
    if (first === undefined || first.startsWith('-')) return this.block('The command name is computed, so its git target cannot be read.');
    const name = commandName(first);
    const args = words.slice(1);
    if (DECLARATION_BUILTINS.has(name)) return this.declare(words, rawWords, state);
    if (READERS.has(name)) {
      // These assign the variables they name from input or computed text; printf only through -v.
      const named = name === 'printf' ? (args[0] === '-v' ? [args[1]] : []) : args;
      if (named.some((word) => word === undefined || targetVariable(envName(word)))) return this.block(`${name} sets a variable git reads, so its target cannot be read.`);
      return undefined;
    }
    if (name === 'busybox') return args.length > 0 ? this.command(args, env, state, rawWords.slice(1)) : undefined;
    const wrapperOptions = WRAPPERS.get(name);
    if (wrapperOptions) return this.wrapper(name, wrapperOptions, words, rawWords, env, state);
    if (name === 'eval') {
      if (args.some((w) => w === undefined)) return this.block('eval runs computed text, so its git target cannot be read.');
      return this.nested(args.join(' '), state);
    }
    if (name === 'source' || name === '.') return this.source(name, args);
    if (name === 'trap') {
      const action = args.find((w) => w === undefined || !w.startsWith('-'));
      if (action === undefined && args.length > 0 && args.some((w) => w === undefined)) return this.block('trap runs computed text, so its git target cannot be read.');
      if (action === undefined) return undefined;
      state.traps.push(action);
      // A DEBUG or RETURN trap runs before later commands, so its cd reaches them.
      return this.nested(action, state);
    }
    if (name === 'find') return this.find(args, env, state);
    if (CD_COMMANDS.has(name)) {
      if (name === 'pushd' && args.some((w) => w === undefined || /^[-+]\d+$/.test(w) || w === '-n')) return this.block('This pushd changes to a directory that cannot be read.');
      const dashdash = args.indexOf('--');
      const operands = dashdash >= 0 ? args.slice(dashdash + 1) : args.filter((w) => w === undefined || !/^-[LPe@]+$/.test(w));
      if (name === 'pushd') state.stack.push(state.cwds === undefined ? undefined : new Set(state.cwds));
      return this.changeDirectory(operands.length === 0 ? '~' : operands[0], env, state);
    }
    if (name === 'popd') {
      // popd on an empty stack fails and stays put. A pushd that failed left the real stack shorter, so the popped set
      // joins the current one.
      if (state.stack.length === 0) return undefined;
      const popped = state.stack.pop();
      state.cwds = popped === undefined || state.cwds === undefined ? undefined : new Set([...state.cwds, ...popped]);
      return undefined;
    }
    return this.program(name, args, env, state);
  }

  /** A program either shell starts: git, and the shells whose text this check reads. */
  private program(name: string, args: Array<string | undefined>, env: Env, state: ShellState): string | undefined {
    if (name === 'git') return this.gitInvocation(args, env, state);
    if (SHELLS.has(name)) return this.shell(name, args, env, state);
    if (POWERSHELLS.has(name)) return this.nestedPowershell(args, env, state);
    if (name === 'cmd') return this.foreignShell(name, args);
    if (name === 'wsl') return this.wsl(args, state);
    return undefined;
  }

  /** wsl.exe's own arguments as `WslClient.cpp` reads them, then the command line it runs in the distribution. */
  private wsl(args: Array<string | undefined>, state: ShellState): string | undefined {
    const computed = (): string => this.block('wsl runs computed text, so its git target cannot be read.');
    let cwds = state.cwds;
    let useShell = true;
    let i = 0;
    // A distribution GUID, then `~`, may lead the arguments.
    if (args[i] !== undefined && WSL_GUID.test(args[i]!)) i++;
    if (args[i] === '~') {
      const moved = this.wslDirectory('~');
      if (typeof moved === 'string') return moved;
      cwds = moved;
      i++;
    }
    for (; i < args.length; i++) {
      const word = args[i];
      if (word === undefined) return computed();
      // These manage WSL and return without running anything in a distribution.
      if (WSL_MANAGEMENT.has(word)) return undefined;
      if (word === '--debug-shell') return this.block('wsl --debug-shell reads its commands from input, so its git target cannot be read.');
      if (WSL_VALUE_OPTIONS.has(word)) {
        i++;
        continue;
      }
      if (word === '--system') continue;
      if (word === '--cd') {
        const dir = args[++i];
        if (dir === undefined) return this.block('wsl starts in a computed directory, so it cannot be read.');
        // wsl.exe refuses a Windows path that is not absolute, and runs nothing.
        if (!/^[/~]/.test(dir) && !path.win32.isAbsolute(dir)) return undefined;
        const moved = this.wslDirectory(dir);
        if (typeof moved === 'string') return moved;
        cwds = moved;
        continue;
      }
      if (word === '--shell-type') {
        const type = args[++i];
        if (type === undefined) return computed();
        useShell = type !== 'none';
        continue;
      }
      if (word === '--' || word === '-e' || word === '--exec') {
        if (word !== '--') useShell = false;
        i++;
        break;
      }
      if (word.startsWith('-')) return this.block('wsl takes an option this check cannot read.');
      break;
    }
    const rest = args.slice(i);
    const child: ShellState = { cwds: cwds === undefined ? undefined : new Set(cwds), stack: [], env: new Map(), traps: [], depth: state.depth + 1 };
    // Without a shell wsl.exe runs the words as argv, and refuses an empty command line.
    if (!useShell) return rest.length === 0 ? undefined : this.command(rest, child.env, child);
    if (rest.length === 0) return this.block('wsl starts a shell that reads its commands from input, so its git target cannot be read.');
    if (rest.includes(undefined)) return computed();
    // The distribution's shell runs the command line through `$SHELL -c`, which reads it as bash does.
    return this.script(parseShellStructure(rest.join(' ')), child);
  }

  /** The folder `wsl --cd` starts in: a Linux path when it begins with `/` or `~`, else an absolute Windows path. */
  private wslDirectory(dir: string): string | Set<string> {
    // Linux takes `..` through links; Windows takes it lexically.
    const target = /^[/~]/.test(dir) ? this.physicalPath(dir, this.iso.workingFolder) : path.resolve(dir);
    const area = this.landsGit(target);
    return area ? this.block(`${dir} is in ${area}.`) : new Set([target]);
  }

  private declare(words: Array<string | undefined>, rawWords: readonly string[], state: ShellState): string | undefined {
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      const assigned = ASSIGNMENT.exec(word ?? rawWords[i] ?? '');
      if (!assigned) {
        if (word === undefined) return this.block('A declaration names a computed variable, so its git target cannot be read.');
        continue;
      }
      const value = word === undefined ? undefined : word.slice(word.indexOf('=') + 1);
      const raw = word === undefined ? rawWords[i]!.slice(assigned[0].length) : undefined;
      const blocked = this.checkEnv(assigned[1]!, value, state, raw);
      if (blocked) return blocked;
      widen(state.env, envName(assigned[1]!), value);
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
      else return this.block(`${name} ${args[i]} is an option this check cannot read.`);
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
    const unknown = (word: string): string => this.block(`${name} ${word} is an option this check cannot read.`);
    const given: Array<{ readonly option: WrapperOption; readonly value: string | undefined }> = [];
    const operands: string[] = [];
    let assigned = false;
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
        if (name === 'env' && word === '-' && !assigned) continue;
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
          if (value === undefined) return this.block(`${name} ${word} takes a value this check cannot read.`);
          given.push({ option: match, value });
        } else {
          given.push({ option: match, value: eq < 0 ? undefined : word.slice(eq + 1) });
        }
        continue;
      }
      for (let k = 1; k < word.length; k++) {
        const match = options.find((o) => o.short === word[k]);
        if (!match) return unknown(word);
        if (match.argument === 'none') {
          given.push({ option: match, value: undefined });
          continue;
        }
        const attached = word.slice(k + 1);
        const value = attached !== '' || match.argument === 'optional' ? attached : words[++i];
        if (value === undefined) return this.block(`${name} ${word} takes a value this check cannot read.`);
        given.push({ option: match, value: value === '' && match.argument === 'optional' ? undefined : value });
        break;
      }
    }
    let login = false;
    for (const { option: o, value } of given) {
      if (o.role === 'chroot') return this.block(`${name} changes the root directory, so its paths cannot be read.`);
      // sudo -e edits the files it names and doas -C checks a configuration; neither runs a command.
      if (o.role === 'noCommand') return undefined;
      if (o.role === 'chdir') {
        const blocked = this.changeDirectory(value, env, state);
        if (blocked) return blocked;
      }
      // sudo -i and su -l run in the target user's home, which the text does not give.
      if (o.role === 'login') login = true;
    }
    const runState = login ? { ...state, cwds: undefined } : state;
    const split = given.find((g) => g.option.role === 'split');
    if (split) return this.nested([split.value!, ...words.slice(i).map((w) => w ?? '$x')].join(' '), state);
    const script = given.find((g) => g.option.role === 'script');
    if (script) return this.shellText(name, script.value!, env, runState);
    if (PERMUTING.has(name)) {
      const rest = [...operands, ...words.slice(i)];
      // runuser -u runs its operands as a command; otherwise they follow the user and go to the user's shell.
      if (name === 'runuser' && given.some((g) => g.option.long === 'user')) return this.command(rest, env, runState);
      if (name !== 'script') return this.shell(name, rest.slice(1), env, runState);
      // Without -c, script runs an interactive shell; BSD script runs the command after its file.
      return rest.length > 1 ? this.command(rest.slice(1), env, runState) : this.block('script runs a shell that reads its commands from input, so its git target cannot be read.');
    }
    if (name === 'cross-env-shell') return this.shellText(name, words.slice(i).map((w) => w ?? '$x').join(' '), env, state);
    if (name === 'parallel') return this.parallel(words.slice(i), given, env, state);
    // The first operand of timeout is the duration, of taskset the CPU mask, of chrt the priority when given.
    if (name === 'timeout' || name === 'taskset' || (name === 'chrt' && /^\d+$/.test(words[i] ?? ''))) i++;
    if (name === 'flock') {
      // flock's first operand is the lock file; a -c after it takes a shell script.
      i++;
      if (words[i] === '-c' || words[i] === '--command') {
        const text = words[i + 1];
        return text === undefined ? this.block('flock -c runs computed text, so its git target cannot be read.') : this.childShell(text, state, env);
      }
    }
    if (i >= words.length) return undefined;
    let command = words.slice(i);
    // Without -x, watch joins its operands and runs them through `sh -c`.
    if (name === 'watch' && !given.some((g) => g.option.role === 'exec')) return this.childShell(command.map((w) => w ?? '$x').join(' '), state, env);
    if (name === 'xargs') {
      // xargs puts what it reads in place of its replace string, or after the command: both are computed words.
      const replacing = given.filter((g) => g.option.role === 'replace').at(-1);
      const replace = replacing === undefined ? undefined : replacing.value ?? '{}';
      command = replace !== undefined ? command.map((w) => (w === undefined || w.includes(replace) ? undefined : w)) : [...command, undefined];
    }
    return this.command(command, env, runState, rawWords.slice(i));
  }

  /** Text a runner hands to a shell: npm's and cross-env's shell is cmd on Windows. */
  private shellText(name: string, text: string, env: Env, state: ShellState): string | undefined {
    if ((name === 'npx' || name === 'cross-env-shell') && process.platform === 'win32') return this.foreignShell('cmd', [text]);
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
    const replacing = given.filter((g) => g.option.role === 'replace').at(-1);
    const replace = replacing === undefined ? undefined : replacing.value ?? '{}';
    const place = (word: string): string => (replace !== undefined ? word.replaceAll(replace, '$x') : word.replace(/\{[^}]*\}/g, '$x'));
    const text = template.map((w) => (w === undefined ? '$x' : place(w)));
    const placed = text.some((w, k) => w !== template[k]);
    return this.childShell([...text, ...(placed ? [] : ['$x'])].join(' '), state, env);
  }

  private shell(name: string, args: Array<string | undefined>, env: Env, state: ShellState): string | undefined {
    const fromInput = (): string => this.block(`${name} reads its commands from input, so its git target cannot be read.`);
    // -s reads the commands from input; operands become their arguments.
    let readsInput = false;
    for (let i = 0; i < args.length; i++) {
      const word = args[i];
      if (word === undefined) return this.block(`${name} runs computed text, so its git target cannot be read.`);
      // A lone `-` ends the options as `--` does.
      const ended = word === '--' || word === '-';
      if (ended || (!word.startsWith('-') && !word.startsWith('+'))) {
        if (readsInput || (ended && i + 1 >= args.length)) return fromInput();
        return this.scriptFile(name, ended ? args[i + 1] : word);
      }
      if (SHELL_VALUE_OPTIONS.has(word) || (name === 'fish' && FISH_VALUE_OPTIONS.has(word))) {
        i++;
        continue;
      }
      if (word.startsWith('--') && !SHELL_FLAG_OPTIONS.has(word)) return this.block(`${name} takes an option this check cannot read.`);
      // -c anywhere in a cluster (-lc, -ec) takes the script from the next operand.
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) {
        const script = args.slice(i + 1).find((w) => w === undefined || !w.startsWith('-'));
        if (script === undefined) return this.block(`${name} -c runs computed text, so its git target cannot be read.`);
        return this.childShell(script, state, env);
      }
      if (/^-[A-Za-z]*s[A-Za-z]*$/.test(word)) readsInput = true;
      if (word === '-o' || word === '-O' || word === '+o' || word === '+O') i++;
    }
    // No script operand: the shell reads its commands from input, which this text does not hold.
    return fromInput();
  }

  /** pwsh or powershell as a new process: it starts where this shell may be, with its environment, and nothing comes back. */
  private nestedPowershell(args: Array<string | undefined>, env: Env, state: ShellState): string | undefined {
    const computed = (): string => this.block('PowerShell runs computed text, so its git target cannot be read.');
    const fromInput = (): string => this.block('PowerShell reads its commands from input, so its git target cannot be read.');
    if (state.cwds === undefined) return this.block('The working directory cannot be read.');
    let cwds: ReadonlySet<string> = state.cwds;
    const child = (text: string): string | undefined => this.powershell(text, { cwds: new Set(cwds), stack: [], env: new Map(env), traps: [], depth: state.depth + 1 });
    for (let i = 0; i < args.length; i++) {
      const word = args[i];
      if (word === undefined) return computed();
      // Both PowerShells take a switch by any prefix, after `-`, `--` or `/`.
      const key = /^(?:--?|\/)([a-z]+)$/i.exec(word)?.[1]?.toLowerCase();
      if (key === undefined) continue;
      const is = (name: string, shortest = 1): boolean => key.length >= shortest && name.startsWith(key);
      if (is('command')) {
        const rest = args.slice(i + 1);
        if (rest.some((w) => w === undefined)) return computed();
        return rest.length === 1 && rest[0] === '-' ? fromInput() : child(rest.join(' '));
      }
      if (is('encodedcommand') || key === 'ec') {
        const encoded = args[i + 1];
        if (encoded === undefined) return computed();
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return this.block('The encoded PowerShell command cannot be read.');
        const text = Buffer.from(encoded, 'base64').toString('utf16le');
        this.text += `\n${text}`;
        return child(text);
      }
      if (is('file')) return undefined;
      if (is('workingdirectory', 2) || key === 'wd') {
        const dir = args[++i];
        if (dir === undefined) return this.block('PowerShell starts in a computed directory, so it cannot be read.');
        const moved = this.psDirectories(dir, cwds);
        if (typeof moved === 'string') return moved;
        cwds = new Set([...cwds, ...moved]);
      }
    }
    return fromInput();
  }

  private foreignShell(name: string, args: Array<string | undefined>): string | undefined {
    if (args.some((w) => w === undefined)) return this.block(`${name} runs computed text, so its git target cannot be read.`);
    const text = args.join(' ');
    // cmd removes ^ and expands %VAR% before it runs a line, so neither can be read from the text.
    if (/[\^%]/.test(text)) return this.block(`${name} runs text it rewrites first, so its git target cannot be read.`);
    for (const set of text.matchAll(/\bset\s+"?([A-Za-z_]\w*)=/gi)) {
      if (targetVariable(set[1]!.toUpperCase())) return this.block(`${name} sets ${set[1]}, which git reads, in a shell this check cannot read.`);
    }
    // cmd takes the text attached to a switch (`/cgit`), and `start /d` starts a program in the folder it names.
    const moves = [text, text.replace(/\/[a-z]/gi, ' ')].some((t) => /\b(git|cd|chdir|pushd)\b/i.test(t)) || /\bstart\b[^&|]*\s\/d/i.test(text);
    return moves ? this.block(`${name} runs git or changes directory in a shell this check cannot read.`) : undefined;
  }

  private find(args: Array<string | undefined>, env: Env, state: ShellState): string | undefined {
    for (let i = 0; i < args.length; i++) {
      const action = args[i] ?? '';
      if (!/^-(exec|execdir|ok|okdir)$/.test(action)) continue;
      const end = args.findIndex((w, j) => j > i && (w === ';' || w === '+'));
      // find puts each found path in place of {} anywhere in a word.
      const inner = args.slice(i + 1, end < 0 ? args.length : end).map((w) => (w === undefined || w.includes('{}') ? undefined : w));
      // -execdir and -okdir run in each found file's folder, which the text does not give.
      const cwds = action.endsWith('dir') || state.cwds === undefined ? undefined : new Set(state.cwds);
      const blocked = this.command(inner, env, { ...state, cwds });
      if (blocked) return blocked;
    }
    return undefined;
  }

  private changeDirectory(target: string | undefined, env: Env, state: ShellState): string | undefined {
    if (target === undefined) return this.block('The directory a cd changes to is computed, so it cannot be read.');
    if (state.cwds === undefined) return this.block('The working directory cannot be read.');
    if (target === '-') {
      state.cwds = undefined;
      return undefined;
    }
    const cdpaths = env.get('CDPATH') ?? new Set<string | undefined>();
    if (cdpaths.has(undefined)) return this.block('CDPATH is computed, so the directory a cd changes to cannot be read.');
    const bases = new Set(state.cwds);
    const relative = !path.isAbsolute(target) && !/^[~/]/.test(target) && !/^\.\.?([/\\]|$)/.test(target);
    const entries = relative ? [...cdpaths].flatMap((cdpath) => cdpath!.split(/[:;]/)) : [];
    for (const entry of entries) if (entry !== '') for (const cwd of state.cwds) bases.add(nativeShellPath(entry, cwd, this.iso.homeDir));
    const next = new Set(state.cwds);
    for (const base of bases) {
      // cd -P, and cd after set -P, takes `..` physically; both readings stay possible.
      for (const candidate of new Set([nativeShellPath(target, base, this.iso.homeDir), this.physicalPath(target, base)])) {
        const area = this.landsGit(candidate);
        if (area) return this.block(`${target} is in ${area}.`);
        next.add(candidate);
      }
    }
    state.cwds = next.size > MAX_CWD_CANDIDATES ? undefined : next;
    return undefined;
  }

  /**
   * git started with `args`, by either shell, with the variables `env` gives it, in any folder `state` may be in: the folder
   * and repository its global options, configuration and path variables point it at, and the commands it runs.
   */
  private gitInvocation(args: Array<string | undefined>, env: Env, state: ShellState): string | undefined {
    if (state.cwds === undefined) return this.block('The working directory of this git command cannot be read.');
    let cwds = [...state.cwds];
    const targets: string[] = [];
    let i = 0;
    for (; i < args.length; i++) {
      const word = args[i];
      if (word === undefined) return this.block('An option of this git command is computed, so its target cannot be read.');
      if (!word.startsWith('-')) break;
      if (word === '-C' || (word.startsWith('-C') && word.length > 2)) {
        const dir = word === '-C' ? args[++i] : word.slice(2);
        if (dir === undefined) return this.block('git -C names a computed directory, so its target cannot be read.');
        if (dir !== '') cwds = cwds.map((cwd) => this.physicalPath(dir, cwd));
        continue;
      }
      if (word === '-c' || word.startsWith('--config-env')) {
        const config = word === '-c' ? args[++i] : undefined;
        if (config === undefined) return this.block('This git command takes configuration this check cannot read.');
        if (/^core\.worktree=/i.test(config)) targets.push(config.slice(config.indexOf('=') + 1));
        if (/^alias\./i.test(config)) return this.block('A git alias defined on the command line runs commands this check cannot read.');
        if (/^include(if\.[^=]*)?\.path=/i.test(config)) return this.block('This git command includes a configuration file this check cannot read.');
        if (GIT_COMMAND_CONFIG.test(config)) {
          const blocked = this.gitRunsCommand(config.slice(config.indexOf('=') + 1).replace(/^!/, ''), { ...state, cwds: new Set(cwds) });
          if (blocked) return blocked;
        }
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
        targets.push(value);
        handled = true;
      }
      if (!handled) return this.block(`git ${word} is an option this check cannot read.`);
    }
    for (const variable of GIT_PATH_ENV) {
      for (const value of env.get(variable) ?? []) {
        if (value === undefined) return this.block(`${variable} is computed, so the git target cannot be read.`);
        if (value !== '') targets.push(value);
      }
    }
    for (const cwd of cwds) {
      const runsIn = this.landsGit(cwd);
      if (runsIn) return this.block(`This git command runs in ${runsIn}.`);
      for (const target of targets) {
        const area = this.landsGit(this.physicalPath(target, cwd));
        if (area) return this.block(`git is pointed at ${target}, in ${area}.`);
      }
      // `git worktree remove|move` acts on the folder its operand names, which may be another worktree of the project.
      if (args[i] === 'worktree' && (args[i + 1] === 'remove' || args[i + 1] === 'move')) {
        for (const operand of args.slice(i + 2)) {
          if (operand === undefined) return this.block('git worktree names a computed path, so its target cannot be read.');
          const area = operand.startsWith('-') ? undefined : this.landsGit(this.physicalPath(operand, cwd));
          if (area) return this.block(`git worktree is pointed at ${operand}, in ${area}.`);
        }
      }
    }
    return undefined;
  }

  /** A PowerShell script run in `state`: the locations it moves to, the variables it sets and the programs it starts. */
  powershell(command: string, state: ShellState): string | undefined {
    const parsed = powershellSegments(command);
    if (parsed === undefined || state.depth > MAX_DEPTH) return this.block('The command could not be parsed, so its git target cannot be read.');
    for (const segment of parsed) {
      const blocked = this.psStatement(segment, state);
      if (blocked) return blocked;
    }
    return undefined;
  }

  private psStatement(segment: PsSegment, state: ShellState): string | undefined {
    const cwds = state.cwds;
    if (cwds === undefined) return this.block('The working directory cannot be read.');
    if (segment.raws.some((raw) => PS_RUNS_TEXT.test(raw))) return this.block('The command runs text or sets variables in a way this check cannot read.');
    for (const raw of segment.raws) {
      const call = PS_SET_ENVIRONMENT.exec(raw);
      if (!call && PS_SET_ENVIRONMENT_NAME.test(raw)) return this.block('SetEnvironmentVariable is called in a form this check cannot read.');
      const blocked = call ? this.psSetEnvironmentVariable(raw, call.index + call[0].length, state) : undefined;
      if (blocked) return blocked;
    }
    const { words, heads, raws } = psCommandTokens(segment);
    for (const { variable, operator } of segment.assigns) {
      // Only a lone string or number literal is a value the text gives, and $null unsets; anything else is computed.
      const literal = words.length === 1 && /^['"\u2018\u2019\u201c\u201d@\d]/.test(raws[0]!) ? words[0] : words.length === 1 && raws[0]!.toLowerCase() === '$null' ? '' : undefined;
      const blocked = this.psAssign(variable, operator === '=' ? literal : undefined, state);
      if (blocked) return blocked;
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
      if (lowered === undefined || lowered === '&' || lowered === '.' || !psExpression(words[at], raws[at]!)) break;
      let k = at;
      while (k < raws.length && (raws[k] === ',' || psExpression(words[k], raws[k]!))) k++;
      if (!PS_ASSIGNMENT_OPERATOR.test(raws[k] ?? '') && !(k === at + 1 && raws[k]?.toLowerCase() === 'in')) return undefined;
      // A multiple assignment (`$env:GIT_DIR, $x = ...`) gives each variable a value the text does not show.
      for (const target of raws.slice(at, k)) {
        const variable = /^\$(\{[^}]*\}|[\w:?]+)$/.exec(target)?.[1];
        const blocked = variable === undefined ? undefined : this.psAssign(variable, undefined, state);
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
    if (name === 'switch-process') return this.block('Switch-Process replaces PowerShell with a program this check cannot read.');
    if (name === 'pop-location' || name === 'popd') {
      state.cwds = new Set([...cwds, ...(state.stack.pop() ?? [])]);
      return undefined;
    }
    if (name === 'invoke-expression' || name === 'iex') return this.invokeExpression(args, argRaws, segment.piped, state);
    if (PS_ALIAS.has(name)) return this.defines();
    if (PS_NEW_DRIVE.has(name)) return this.block('The command defines a drive, so the directories it names cannot be read.');
    if (PS_START_PROCESS.has(name)) return this.startProcess(args, argRaws, state);
    const names = (drive: RegExp): boolean => args.some((word, k) => drive.test(word ?? argHeads[k]!));
    if ((PS_ITEM_WRITE.has(name) || PS_ITEM_TRANSFER.has(name)) && names(PS_COMMAND_DRIVE)) return this.defines();
    if (PS_ITEM_TRANSFER.has(name) && names(PS_ENV_MENTION)) return this.block('The command copies an environment variable, which this check cannot follow.');
    if (PS_ITEM_WRITE.has(name) && names(PS_ENV_MENTION)) return this.psEnvironmentItem(name, args, argRaws, segment.piped, state);
    if (PS_LOCATION.has(name)) return this.psLocation(name, builtin, args, argRaws, segment.piped, state);
    // PowerShell passes each element of an array argument to a native program as its own argument.
    const programArgs = args.filter((_, k) => argRaws[k] !== ',');
    // Windows PowerShell 5.1 drops the quotes a backtick escapes in a native argument, and no Windows path holds one.
    return this.program(name, name === 'git' ? programArgs.map((w) => w?.replaceAll('"', '')) : programArgs, state.env, state);
  }

  private defines(): string {
    return this.block('The command defines an alias or a function, so the command it runs cannot be read.');
  }

  /** An assignment to a drive-qualified variable: `env:` sets an environment variable, `alias:` and `function:` define a command. */
  private psAssign(variable: string, value: string | undefined, state: ShellState): string | undefined {
    const scoped = /^\{?(env|alias|function):([^}]+)\}?$/i.exec(variable);
    if (!scoped) return undefined;
    return scoped[1]!.toLowerCase() === 'env' ? this.psSetVariable(scoped[2]!, value, state) : this.defines();
  }

  /** Sets an environment variable PowerShell names case-insensitively, as git on Windows reads it. */
  private psSetVariable(name: string, value: string | undefined, state: ShellState): string | undefined {
    const upper = name.toUpperCase();
    const blocked = this.gitVariable(upper, value, state);
    if (!blocked) widen(state.env, upper, value);
    return blocked;
  }

  /** `[Environment]::SetEnvironmentVariable(name, value[, target])`, its arguments from `open` in `raw`; every target counts. */
  private psSetEnvironmentVariable(raw: string, open: number, state: ShellState): string | undefined {
    const found: PsSegment[] = [];
    if (scanPowershell(raw, open, 1, found) === undefined) return this.block('SetEnvironmentVariable takes arguments this check cannot read.');
    const call = found.at(-1);
    if (call === undefined) return undefined;
    const elements: Array<Array<string | undefined>> = [[]];
    call.raws.forEach((r, k) => (r === ',' ? elements.push([]) : elements.at(-1)!.push(call.words[k])));
    const [variable, value = []] = elements;
    if (variable!.length !== 1 || variable![0] === undefined) return this.block('SetEnvironmentVariable names a computed variable, so the git target cannot be read.');
    return this.psSetVariable(variable![0], value.length === 1 ? value[0] : undefined, state);
  }

  /** Set-Item, New-Item and the content cmdlets on the Env: drive. */
  private psEnvironmentItem(name: string, args: Array<string | undefined>, raws: readonly string[], piped: boolean, state: ShellState): string | undefined {
    const bound = psBind(name, PS_ITEM_PARAMETERS, args, raws, ['path', 'content']);
    if ('blocked' in bound) return this.block(bound.blocked);
    const content = name === 'add-content' || name === 'ac' ? [undefined] : bound.named.get('content') ?? (piped ? [undefined] : ['']);
    const value = content.length === 1 ? content[0] : undefined;
    for (const item of bound.named.get('path') ?? []) {
      if (item === undefined) return this.block('The command names an environment variable by computed text, so the git target cannot be read.');
      const drive = PS_ENV_MENTION.exec(item);
      if (!drive) continue;
      let variable: string | undefined = item.slice(drive[0].length).replace(/^[\\/]/, '');
      if (variable === '') {
        const named = bound.named.get('name');
        variable = named?.length === 1 ? named[0] : undefined;
      }
      if (variable === undefined || /[*?[]/.test(variable)) return this.block(`${item} names environment variables this check cannot read.`);
      const blocked = this.psSetVariable(variable, value, state);
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
    const blocked = this.powershell(text[0], state);
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
    let cwds = state.cwds!;
    const directory = bound.named.get('directory');
    if (directory !== undefined) {
      if (directory.length !== 1 || directory[0] === undefined) return this.block('Start-Process starts in a computed directory, so it cannot be read.');
      const moved = this.psDirectories(directory[0], cwds);
      if (typeof moved === 'string') return moved;
      cwds = moved;
    }
    const name = commandName(file[0]);
    const elements = bound.named.get('arguments') ?? [];
    if (name === 'git' && elements.includes(undefined)) return this.block('Start-Process passes git a computed argument, so its target cannot be read.');
    // The elements reach the program as one command line, joined by spaces and split again.
    const words = elements.includes(undefined) ? [undefined] : windowsArguments(elements.join(' '));
    return this.program(name, words, state.env, { cwds: new Set(cwds), stack: [], env: new Map(state.env), traps: [], depth: state.depth + 1 });
  }

  private psLocation(name: string, builtin: string | undefined, args: Array<string | undefined>, raws: readonly string[], piped: boolean, state: ShellState): string | undefined {
    let target: Array<string | undefined> | undefined = builtin === undefined ? undefined : [builtin];
    if (builtin === undefined) {
      const bound = psBind('Set-Location', PS_LOCATION_PARAMETERS, args, raws, ['path']);
      if ('blocked' in bound) return this.block(bound.blocked);
      target = bound.named.get('path');
    }
    // A location cmdlet without a path in a later pipeline element takes it from the pipeline.
    if (target === undefined && piped) return this.block('Set-Location takes its directory from the pipeline, so it is computed.');
    target ??= ['~'];
    if (target.length === 0 || target.includes(undefined)) return this.block('The directory Set-Location changes to is computed, so it cannot be read.');
    const cwds = state.cwds!;
    if (name === 'push-location' || name === 'pushd') state.stack.push(new Set(cwds));
    const next = new Set(cwds);
    for (const spelled of target as string[]) {
      // PowerShell's own location history; every place it can return to is already a candidate.
      if (spelled === '-' || spelled === '+') continue;
      const moved = this.psDirectories(spelled, cwds);
      if (typeof moved === 'string') return moved;
      for (const candidate of moved) next.add(candidate);
    }
    if (next.size > MAX_CWD_CANDIDATES) return this.block('The working directory cannot be read.');
    state.cwds = next;
    return undefined;
  }

  /** The folders a PowerShell directory names from each of `cwds`, or the block reason when one lies in a protected area. */
  private psDirectories(spelled: string, cwds: ReadonlySet<string>): string | Set<string> {
    const literal = spelled.replace(/^(microsoft\.powershell\.core\\)?filesystem::/i, '');
    if (/^[^\\/:]{2,}:/.test(literal)) return this.block(`${spelled} is on a drive this check cannot read.`);
    // pwsh on Linux and macOS turns every `\` of a provider path into `/` (FileSystemProvider.NormalizePath).
    const native = process.platform === 'win32' ? literal : literal.replaceAll('\\', '/');
    const next = new Set<string>();
    for (const cwd of cwds) {
      const candidate = nativeShellPath(native, cwd, this.iso.homeDir, process.platform);
      const area = this.landsGit(candidate);
      if (area) return this.block(`${spelled} is in ${area}.`);
      next.add(candidate);
    }
    return next;
  }
}

const PS_LOCATION: ReadonlySet<string> = new Set(['set-location', 'sl', 'cd', 'chdir', 'push-location', 'pushd']);
const PS_NEW_DRIVE: ReadonlySet<string> = new Set(['new-psdrive', 'ndr', 'mount']);
const PS_ALIAS: ReadonlySet<string> = new Set(['set-alias', 'sal', 'new-alias', 'nal']);
const PS_START_PROCESS: ReadonlySet<string> = new Set(['start-process', 'saps', 'start']);
// Cmdlets that set an item or its content, and that copy or move one, with their aliases in pwsh 7 and Windows PowerShell 5.1.
const PS_ITEM_WRITE: ReadonlySet<string> = new Set(['set-item', 'si', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac']);
const PS_ITEM_TRANSFER: ReadonlySet<string> = new Set(['copy-item', 'copy', 'cp', 'cpi', 'move-item', 'move', 'mv', 'mi', 'rename-item', 'ren', 'rni']);
// A path on the Env: drive, given directly or as a parameter's attached value.
const PS_ENV_MENTION = /^(?:-\w+:)?(?:(?:microsoft\.powershell\.core\\)?environment::|env:)/i;
// An item on the Alias: or Function: drive, which defines a command.
const PS_COMMAND_DRIVE = /^(?:-\w+:)?(?:(?:microsoft\.powershell\.core\\)?(?:alias|function)::|(?:alias|function):)/i;
const PS_SET_ENVIRONMENT = /\[(?:system\.)?environment\]::setenvironmentvariable\s*\(/i;
// The method named in any other form, which the call reader does not take.
const PS_SET_ENVIRONMENT_NAME = /::\s*['"]?setenvironmentvariable/i;
// Text run as a script, a process started through .NET, or a variable set by name.
const PS_RUNS_TEXT = /scriptblock\]::create\s*\(|\.invokescript\s*\(|\.newscriptblock\s*\(|diagnostics\.process\]::start\s*\(|\.psvariable\.set\s*\(/i;
const PS_ASSIGNMENT_OPERATOR = /^(?:[-+*/%]|\?\?)?=$/;
// A redirection operator, alone or with its target attached; `n>&m` merges streams and takes no target.
const PS_REDIRECTION = /^[1-6*]?>>?(&[1-6])?/;
const PS_DASHES = /[\u2013\u2014\u2015]/g;
// Past this many nested subexpressions the parse stops and the command blocks, before the call stack runs out.
const MAX_PS_NESTING = 200;

interface PsParameter {
  readonly names: readonly string[];
  /** `switch` takes no value, `value` one this check ignores; any other kind names a value the check reads. */
  readonly kind: string;
}
const PS_COMMON_PARAMETERS: readonly PsParameter[] = [
  { names: ['verbose', 'vb'], kind: 'switch' },
  { names: ['debug', 'db'], kind: 'switch' },
  { names: ['erroraction', 'ea'], kind: 'value' },
  { names: ['warningaction', 'wa'], kind: 'value' },
  { names: ['informationaction', 'infa'], kind: 'value' },
  { names: ['progressaction', 'proga'], kind: 'value' },
  { names: ['errorvariable', 'ev'], kind: 'value' },
  { names: ['warningvariable', 'wv'], kind: 'value' },
  { names: ['informationvariable', 'iv'], kind: 'value' },
  { names: ['outvariable', 'ov'], kind: 'value' },
  { names: ['outbuffer', 'ob'], kind: 'value' },
  { names: ['pipelinevariable', 'pv'], kind: 'value' },
];
const PS_SHOULD_PROCESS: readonly PsParameter[] = [{ names: ['whatif', 'wi'], kind: 'switch' }, { names: ['confirm', 'cf'], kind: 'switch' }];
// Set-Location's and Push-Location's parameters.
const PS_LOCATION_PARAMETERS: readonly PsParameter[] = [
  { names: ['path'], kind: 'path' },
  { names: ['literalpath', 'pspath', 'lp'], kind: 'path' },
  { names: ['passthru'], kind: 'switch' },
  { names: ['stackname'], kind: 'value' },
  ...PS_SHOULD_PROCESS,
  ...PS_COMMON_PARAMETERS,
];
const PS_IEX_PARAMETERS: readonly PsParameter[] = [{ names: ['command'], kind: 'path' }, ...PS_COMMON_PARAMETERS];
// Start-Process in pwsh 7 (-Environment from 7.4) and Windows PowerShell 5.1.
const PS_START_PARAMETERS: readonly PsParameter[] = [
  { names: ['filepath', 'path', 'pspath'], kind: 'file' },
  { names: ['argumentlist', 'args'], kind: 'arguments' },
  { names: ['workingdirectory'], kind: 'directory' },
  { names: ['environment'], kind: 'environment' },
  { names: ['credential', 'cred'], kind: 'value' },
  { names: ['loaduserprofile', 'lup'], kind: 'switch' },
  { names: ['nonewwindow', 'nnw'], kind: 'switch' },
  { names: ['passthru'], kind: 'switch' },
  { names: ['redirectstandarderror', 'rse'], kind: 'value' },
  { names: ['redirectstandardinput', 'rsi'], kind: 'value' },
  { names: ['redirectstandardoutput', 'rso'], kind: 'value' },
  { names: ['verb'], kind: 'value' },
  { names: ['windowstyle'], kind: 'value' },
  { names: ['wait'], kind: 'switch' },
  { names: ['usenewenvironment'], kind: 'switch' },
  ...PS_SHOULD_PROCESS,
  ...PS_COMMON_PARAMETERS,
];
// Set-Item, New-Item, Set-Content and Add-Content.
const PS_ITEM_PARAMETERS: readonly PsParameter[] = [
  { names: ['path'], kind: 'path' },
  { names: ['literalpath', 'pspath', 'lp'], kind: 'path' },
  { names: ['value'], kind: 'content' },
  { names: ['name'], kind: 'name' },
  { names: ['itemtype', 'type'], kind: 'value' },
  { names: ['force'], kind: 'switch' },
  { names: ['passthru'], kind: 'switch' },
  { names: ['filter'], kind: 'value' },
  { names: ['include'], kind: 'value' },
  { names: ['exclude'], kind: 'value' },
  { names: ['credential'], kind: 'value' },
  { names: ['encoding'], kind: 'value' },
  { names: ['stream'], kind: 'value' },
  { names: ['nonewline'], kind: 'switch' },
  { names: ['asbytestream'], kind: 'switch' },
  ...PS_SHOULD_PROCESS,
  ...PS_COMMON_PARAMETERS,
];

/** The kind PowerShell binds `-spelled` to: an alias exactly, a name by any prefix; undefined when nothing matches. */
function psParameterKind(table: readonly PsParameter[], spelled: string): string | 'ambiguous' | undefined {
  const exact = table.find((p) => p.names.includes(spelled));
  if (exact) return exact.kind;
  const kinds = new Set(table.filter((p) => p.names[0]!.startsWith(spelled)).map((p) => p.kind));
  // Where a prefix also matches a parameter whose value the check reads, it is read as that parameter.
  const read = [...kinds].filter((kind) => kind !== 'switch' && kind !== 'value');
  if (read.length === 1) return read[0];
  if (kinds.size > 1) return 'ambiguous';
  return [...kinds][0];
}

/** Each parameter kind bound, its value a list of elements, an element undefined when computed. */
interface PsBound {
  readonly named: ReadonlyMap<string, Array<string | undefined>>;
}

/** A cmdlet's arguments bound as PowerShell binds them: `-Name value`, `-Name:value`, comma lists, and positional values in `positions` order. */
function psBind(cmdlet: string, table: readonly PsParameter[], args: ReadonlyArray<string | undefined>, raws: readonly string[], positions: readonly string[]): PsBound | { readonly blocked: string } {
  const named = new Map<string, Array<string | undefined>>();
  const positional: Array<Array<string | undefined>> = [];
  const list = (first: string | undefined, k: number): [Array<string | undefined>, number] => {
    const elements = [first];
    while (raws[k + 1] === ',' && k + 2 < args.length) {
      k += 2;
      elements.push(args[k]);
    }
    return [elements, k];
  };
  for (let i = 0; i < args.length; i++) {
    const raw = raws[i]!;
    if (raw === ',') continue;
    // A splatted variable binds parameters the text does not show.
    if (/^@[A-Za-z_]/.test(raw)) return { blocked: `${cmdlet} takes splatted parameters, so its target is computed.` };
    const parameter = /^-([A-Za-z_?][\w?]*)(:?)/.exec(raw);
    if (!parameter) {
      const [elements, end] = list(args[i], i);
      positional.push(elements);
      i = end;
      continue;
    }
    const kind = psParameterKind(table, parameter[1]!.toLowerCase());
    if (kind === undefined || kind === 'ambiguous') return { blocked: `${cmdlet} ${raw} is a parameter this check cannot read.` };
    // A switch takes an attached value only (`-WhatIf:$true`).
    if (kind === 'switch') continue;
    const attached = parameter[2] === ':' && raw.length > parameter[0].length;
    if (attached) {
      const word = args[i];
      const [elements, end] = list(word === undefined ? undefined : word.slice(parameter[0].length), i);
      named.set(kind, elements);
      i = end;
    } else if (i + 1 < args.length) {
      const [elements, end] = list(args[i + 1], i + 1);
      named.set(kind, elements);
      i = end;
    }
  }
  const open = positions.filter((kind) => !named.has(kind));
  positional.forEach((elements, k) => {
    if (k < open.length) named.set(open[k]!, elements);
  });
  return { named };
}

/** Whether a statement's token is an expression, not a command name: a literal, a variable, a subexpression or a type. */
function psExpression(word: string | undefined, raw: string): boolean {
  return word === undefined || /^['"\u2018\u2019\u201c\u201d@[\d]/.test(raw);
}

/** A statement's tokens without its redirections and a trailing background `&`. */
function psCommandTokens(segment: PsSegment): { words: Array<string | undefined>; heads: string[]; raws: string[] } {
  const kept = { words: [] as Array<string | undefined>, heads: [] as string[], raws: [] as string[] };
  for (let k = 0; k < segment.raws.length; k++) {
    const raw = segment.raws[k]!;
    const redirection = PS_REDIRECTION.exec(raw);
    if (redirection) {
      if (redirection[0] === raw && redirection[1] === undefined) k++;
      continue;
    }
    if (raw === '&' && k > 0 && k === segment.raws.length - 1) continue;
    kept.words.push(segment.words[k]);
    kept.heads.push(segment.heads[k]!);
    kept.raws.push(raw);
  }
  return kept;
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

interface PsSegment {
  readonly words: Array<string | undefined>;
  /** Each token's literal text before its first computed part. */
  readonly heads: string[];
  /** Each token as written; a lone `,` separates array elements. */
  readonly raws: string[];
  /** Whether a pipe feeds this statement. */
  readonly piped: boolean;
  /** The variables the statement's leading assignments set, as written after `$` (`env:GIT_DIR`), with their operators. */
  readonly assigns: ReadonlyArray<{ readonly variable: string; readonly operator: string }>;
}

// A statement's leading assignment: simple casts, the variable, member and index accesses, then the operator.
const PS_ASSIGNMENT = /^(?:\[[\w.]+(?:\[\])?\]\s*)*\$(\{[^}]*\}|[\w:?]+)(?:\.\w+|\[[^\]()\r\n]*\])*\s*((?:[-+*/%]|\?\?)?=)(?!=)/;

/** Statements split on `;`, `|`, `&&`, `||` and newlines; a token is undefined when it expands a variable or subexpression. */
function powershellSegments(source: string): PsSegment[] | undefined {
  // PowerShell reads an en or em dash as a parameter's dash.
  const command = source.replace(PS_DASHES, '-');
  const segments: PsSegment[] = [];
  return scanPowershell(command, 0, 0, segments) === undefined ? undefined : segments;
}

/**
 * The statements of `command` from `start` into `segments`, those of each subexpression before the statement holding it.
 * Returns the index of the `)` that ends a scan at `depth` above 0, or the text's length; undefined when the text cannot be read.
 */
function scanPowershell(command: string, start: number, depth: number, segments: PsSegment[]): number | undefined {
  if (depth > MAX_PS_NESTING) return undefined;
  const nested = depth > 0;
  let words: Array<string | undefined> = [];
  let heads: string[] = [];
  let raws: string[] = [];
  let assigns: Array<{ readonly variable: string; readonly operator: string }> = [];
  let piped = false;
  let value = '';
  let computed = false;
  let head = '';
  let inWord = false;
  let wordStart = start;
  let i = start;
  const begin = (): void => {
    if (!inWord) wordStart = i;
    inWord = true;
  };
  const markComputed = (): void => {
    if (!computed) head = value;
    computed = true;
  };
  const endWord = (end = i): void => {
    if (inWord) {
      words.push(computed ? undefined : value);
      heads.push(computed ? head : value);
      raws.push(command.slice(wordStart, end));
    }
    inWord = false;
    value = '';
    computed = false;
  };
  const endSegment = (thenPiped: boolean): void => {
    endWord();
    if (words.length === 0) {
      // A pipe followed by a line break still feeds the next statement; an assignment takes its value from the next line.
      piped ||= thenPiped;
      return;
    }
    segments.push({ words, heads, raws, piped, assigns });
    words = [];
    heads = [];
    raws = [];
    assigns = [];
    piped = thenPiped;
  };
  // A subexpression's statements run before the statement holding it, whose token it makes computed.
  const subexpression = (open: number): boolean => {
    markComputed();
    const end = scanPowershell(command, open + 1, depth + 1, segments);
    if (end === undefined) return false;
    i = end;
    return true;
  };
  for (; i < command.length; i++) {
    const ch = command[i]!;
    if (!inWord && words.length === 0 && (ch === '$' || ch === '[')) {
      const assignment = PS_ASSIGNMENT.exec(command.slice(i));
      if (assignment) {
        assigns.push({ variable: assignment[1]!, operator: assignment[2]! });
        i += assignment[0].length - 1;
        continue;
      }
    }
    if (ch === '<' && command[i + 1] === '#') {
      const end = command.indexOf('#>', i + 2);
      if (end < 0) return undefined;
      i = end + 1;
      continue;
    }
    if (ch === '#' && !inWord) {
      const end = command.indexOf('\n', i);
      i = end < 0 ? command.length : end - 1;
      continue;
    }
    if (ch === '`') {
      // A backtick before a line break continues the line.
      const lineBreak = /^\r?\n/.exec(command.slice(i + 1, i + 3));
      if (lineBreak) {
        endWord();
        i += lineBreak[0].length;
        continue;
      }
      begin();
      if (i + 1 < command.length) value += command[++i];
      continue;
    }
    if (ch === '@' && !inWord && (command[i + 1] === "'" || command[i + 1] === '"') && /^\r?\n/.test(command.slice(i + 2, i + 4))) {
      // A here-string runs to a line that starts with its closing quote and `@`.
      const quote = command[i + 1]!;
      const close = new RegExp(`\\r?\\n${quote}@`).exec(command.slice(i + 2));
      if (!close) return undefined;
      begin();
      const bodyStart = i + 2;
      const bodyEnd = bodyStart + close.index;
      value += command.slice(bodyStart, bodyEnd).replace(/^\r?\n/, '');
      if (quote === '"' && /[`$]/.test(command.slice(bodyStart, bodyEnd))) {
        markComputed();
        for (let k = bodyStart; k < bodyEnd; k++) {
          if (command[k] === '`') k++;
          else if (command[k] === '$' && command[k + 1] === '(') {
            const end = scanPowershell(command, k + 2, depth + 1, segments);
            if (end === undefined) return undefined;
            k = end;
          }
        }
      }
      i = bodyEnd + close[0].length - 1;
      continue;
    }
    if (ch === "'" || ch === '\u2018' || ch === '\u2019') {
      begin();
      let j = i + 1;
      for (; j < command.length; j++) {
        const c = command[j]!;
        if (c === "'" || c === '\u2018' || c === '\u2019') {
          if (command[j + 1] === c) {
            value += c;
            j++;
            continue;
          }
          break;
        }
        value += c;
      }
      if (j >= command.length) return undefined;
      i = j;
      continue;
    }
    if (ch === '"' || ch === '\u201c' || ch === '\u201d') {
      begin();
      let j = i + 1;
      for (; j < command.length && !'"\u201c\u201d'.includes(command[j]!); j++) {
        const c = command[j]!;
        if (c === '`') {
          value += command[++j] ?? '';
        } else if (c === '$' && command[j + 1] === '(') {
          markComputed();
          const end = scanPowershell(command, j + 2, depth + 1, segments);
          if (end === undefined) return undefined;
          j = end;
        } else if (c === '$' && /[A-Za-z_{:?]/.test(command[j + 1] ?? '')) {
          markComputed();
        } else {
          value += c;
        }
      }
      if (j >= command.length) return undefined;
      i = j;
      continue;
    }
    // A splatted variable binds parameters the text does not show.
    if (ch === '@' && /[A-Za-z_]/.test(command[i + 1] ?? '')) {
      begin();
      markComputed();
      while (/[A-Za-z0-9_:]/.test(command[i + 1] ?? '')) i++;
      continue;
    }
    if (ch === '$' && /[A-Za-z_{:?]/.test(command[i + 1] ?? '')) {
      begin();
      markComputed();
      while (/[A-Za-z0-9_:{}]/.test(command[i + 1] ?? '')) i++;
      continue;
    }
    if (ch === '(' || ((ch === '$' || ch === '@') && command[i + 1] === '(')) {
      begin();
      if (!subexpression(ch === '(' ? i : i + 1)) return undefined;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && command[i + 1] === '&')) {
      const pipe = ch === '|' && command[i + 1] !== '|';
      endSegment(pipe);
      if ((ch === '|' || ch === '&') && command[i + 1] === ch) i++;
      continue;
    }
    if (ch === ',' || (ch === '&' && !inWord)) {
      // An array's comma and the call operator are tokens of their own.
      endWord();
      begin();
      value = ch;
      endWord(i + 1);
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord();
      continue;
    }
    if (ch === ')') {
      endSegment(false);
      if (nested) return i;
      continue;
    }
    if (ch === '{' || ch === '}') {
      endSegment(false);
      continue;
    }
    begin();
    value += ch;
  }
  if (nested) return undefined;
  endSegment(false);
  return i;
}
