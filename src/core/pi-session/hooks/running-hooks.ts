import type { WindDownHook } from '../../../shared/types/wind-down';
import type { ConfiguredHook } from './types';

/** The longest label shown, in code points; a longer one is cut to this and ends in an ellipsis. */
export const MAX_HOOK_LABEL_LENGTH = 48;

// A command line can carry credentials and the label is often on a shared screen, so it never shows an argument
// (OWASP Logging Cheat Sheet, "Data to exclude"): only a program's or a script's file name.
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'node', 'tsx', 'python', 'py', 'uv']);

// An option after which an interpreter without an operand rule runs inline code instead of a script file.
const INLINE_CODE: Partial<Record<string, RegExp>> = {
  pwsh: /^-(?:c|com\w*|e|ec|enc\w*)$/i,
  powershell: /^-(?:c|com\w*|e|ec|enc\w*)$/i,
  node: /^(?:-e|-p|--eval|--print)(?:=|$)/,
  tsx: /^(?:-e|-p|--eval|--print)(?:=|$)/,
};

// An option whose value is the next word, which is a module to preload rather than the script.
const PRELOAD_OPTION: Partial<Record<string, RegExp>> = {
  node: /^(?:-r|--require|--import|--loader|--experimental-loader)$/,
  tsx: /^(?:-r|--require|--import|--loader|--experimental-loader)$/,
};

// Only an argument naming a script file counts as one, so an option's value is never taken for it.
const SCRIPT_FILE = /^[^\s"'`$;&|<>()=?*]+\.(?:sh|bash|zsh|ps1|psm1|cmd|bat|js|mjs|cjs|ts|mts|cts|py|pyw)$/i;
const PATH_NAME = /^[^\s"'`$;&|<>()=?*]+$/;

// bash(1) and dash(1) "Invocation": each o or O in an option word takes the next word, -c runs inline code, -s reads stdin.
function shellOperand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--' || arg === '-') return args[i + 1];
    if (arg.startsWith('--')) {
      if (arg === '--rcfile' || arg === '--init-file') i++;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(arg)) {
      if (arg.startsWith('-') && /[cs]/.test(arg)) return undefined;
      i += (arg.match(/[oO]/g) ?? []).length;
      continue;
    }
    return arg;
  }
  return undefined;
}

// python(1) "Command line": -c and -m run inline code or a module, - reads stdin, -W and -X take a value attached or next.
function pythonOperand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-') return undefined;
    if (arg === '--') return args[i + 1];
    if (arg.startsWith('--')) {
      if (arg === '--check-hash-based-pycs') i++;
      continue;
    }
    if (arg.startsWith('-')) {
      for (let j = 1; j < arg.length; j++) {
        if (arg[j] === 'c' || arg[j] === 'm') return undefined;
        if (arg[j] === 'W' || arg[j] === 'X') {
          if (j === arg.length - 1) i++;
          break;
        }
      }
      continue;
    }
    return arg;
  }
  return undefined;
}

// The py launcher takes one version selector (-3, -3.12-64, -V:Company/Tag) ahead of python's own options.
function pyOperand(args: readonly string[]): string | undefined {
  return pythonOperand(/^-(?:\d|V:)/.test(args[0] ?? '') ? args.slice(1) : args);
}

// Interpreters whose options are a closed set, so the word they run as their script is known.
const OPERAND: Partial<Record<string, (args: readonly string[]) => string | undefined>> = {
  bash: shellOperand,
  sh: shellOperand,
  zsh: shellOperand,
  dash: shellOperand,
  ksh: shellOperand,
  python: pythonOperand,
  py: pyOperand,
};

const ASSIGNMENT = /^[A-Za-z_]\w*=/;

// env(1), GNU and BSD: u, C, P, L and U take a value, attached or the next word; -S splits a command line it is not read for.
function envCommand(args: readonly string[]): readonly string[] | undefined {
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      i++;
      break;
    }
    if (arg === '-') continue;
    if (arg.startsWith('--')) {
      if (arg.startsWith('--split-string')) return undefined;
      if (arg === '--unset' || arg === '--chdir') i++;
      continue;
    }
    if (!arg.startsWith('-')) break;
    for (let j = 1; j < arg.length; j++) {
      if (arg[j] === 'S') return undefined;
      if ('uCPLU'.includes(arg[j]!)) {
        if (j === arg.length - 1) i++;
        break;
      }
    }
  }
  while (i < args.length && ASSIGNMENT.test(args[i]!)) i++;
  return args.slice(i);
}

// A registry package name with an optional version; a git, file or URL spec is never shown.
const PACKAGE_SPEC = /^(?:@[\w.-]+\/)?[\w.-]+(?:@[\w.^~<>=*-]*)?$/;
const RUNNER_FLAG = /^(?:-[yq]|--(?:yes|no|no-install|quiet|silent|bun|prefer-offline|prefer-online|offline|ignore-existing))$/;

/**
 * The command npx, bunx, pnpm dlx or yarn dlx runs, from its package's program on. Any option outside the known flags may
 * take a value, so it ends the reading, as -c and --shell-mode do, which run a command line.
 */
function packageCommand(args: readonly string[]): readonly string[] | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-p' || arg === '--package') i++;
    else if (arg.startsWith('--package=') || RUNNER_FLAG.test(arg)) continue;
    else if (arg === '--') return programOf(args[i + 1], args.slice(i + 2));
    else if (arg.startsWith('-')) return undefined;
    else return programOf(arg, args.slice(i + 1));
  }
  return undefined;
}

function programOf(spec: string | undefined, args: readonly string[]): readonly string[] | undefined {
  return spec !== undefined && PACKAGE_SPEC.test(spec) ? [spec.replace(/(?!^)@.*$/, ''), ...args] : undefined;
}

/** The command a wrapper (env, a package runner) runs, or undefined when `name` is none or what it runs is not read. */
function wrappedCommand(name: string, args: readonly string[]): readonly string[] | undefined {
  if (name === 'env') return envCommand(args);
  if (name === 'npx' || name === 'bunx') return packageCommand(args);
  if ((name === 'pnpm' || name === 'yarn') && args[0] === 'dlx') return packageCommand(args.slice(1));
  return undefined;
}

/** A script operand shown when it names a script file or is a path with a folder part; a bare word or a URL never shows. */
function shownOperand(operand: string | undefined): string | undefined {
  if (operand === undefined || operand.includes('://')) return undefined;
  const name = baseName(operand);
  if (SCRIPT_FILE.test(name)) return operand;
  return /[\\/]/.test(operand) && PATH_NAME.test(name) ? operand : undefined;
}

/**
 * The words of a shell command line up to its first operator, quotes removed, and the text from that operator on.
 * Backslashes stay, as Windows paths hold them.
 */
function shellWords(command: string): { words: string[]; rest: string } {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | null = null;
  let index = 0;
  for (; index < command.length; index++) {
    const ch = command[index]!;
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (';&|<>()'.includes(ch)) {
      break;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return { words, rest: command.slice(index) };
}

/** The words of the command a shell command line runs: past each leading `cd <dir> &&` and its variable assignments. */
function commandWords(command: string): string[] {
  let { words, rest } = shellWords(command);
  while (/^(?:cd|pushd)$/i.test(words[0] ?? '') && rest.startsWith('&&')) ({ words, rest } = shellWords(rest.slice(2)));
  const start = words.findIndex((word) => !ASSIGNMENT.test(word));
  return start < 0 ? [] : words.slice(start);
}

const baseName = (file: string): string => file.split(/[\\/]/).filter(Boolean).at(-1) ?? '';

const programName = (program: string): string => baseName(program).toLowerCase().replace(/\.(?:exe|cmd)$/, '');

function interpreterOf(program: string): string | undefined {
  const name = programName(program).replace(/^pythonw?[\d.]*$/, 'python');
  return INTERPRETERS.has(name) ? name : undefined;
}

/**
 * The script an interpreter runs: for one with a closed option set, its operand; for any other, the first argument naming a
 * script file, unless inline code comes first.
 */
function scriptOf(interpreter: string, args: readonly string[]): string | undefined {
  const operand = OPERAND[interpreter];
  if (operand) return shownOperand(operand(args));
  const inlineCode = INLINE_CODE[interpreter];
  const preload = PRELOAD_OPTION[interpreter];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (inlineCode?.test(arg)) return undefined;
    if (preload?.test(arg)) i++;
    else if (SCRIPT_FILE.test(baseName(arg)) && !arg.includes('://')) return arg;
  }
  return undefined;
}

/** The file name a command is shown by, before sanitizing. */
function labelOf(words: readonly string[]): string {
  const [program, ...args] = words;
  if (program === undefined) return '';
  const wrapped = wrappedCommand(programName(program), args);
  if (wrapped?.length) return labelOf(wrapped);
  const interpreter = interpreterOf(program);
  const script = interpreter ? scriptOf(interpreter, args) : undefined;
  return baseName(script ?? program);
}

function sanitized(label: string): string {
  const chars = [...label.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()];
  return chars.length > MAX_HOOK_LABEL_LENGTH ? `${chars.slice(0, MAX_HOOK_LABEL_LENGTH - 1).join('')}…` : chars.join('');
}

/**
 * What a hook is called while it runs: its program's file name, or for an interpreter given a script file, the script's.
 * env and package runners are looked through to the command they run; a shell command's leading `cd <dir> &&` and
 * variable assignments are skipped.
 */
export function hookLabel(command: string | readonly string[]): string {
  return sanitized(labelOf(typeof command === 'string' ? commandWords(command) : command));
}

// Process-global, as the pi extension that runs the hooks is: keyed by session id, each entry removed as its hook ends.
const running = new Map<string, Set<WindDownHook>>();
const listeners = new Set<(sessionId: string) => void>();

function changed(sessionId: string): void {
  for (const listener of listeners) listener(sessionId);
}

/** Records `hook` as running for `sessionId` until the returned release is called. */
export function trackRunningHook(sessionId: string, hook: ConfiguredHook): () => void {
  const shown: WindDownHook = { label: hookLabel(hook.command), scope: hook.scope };
  let hooks = running.get(sessionId);
  if (!hooks) running.set(sessionId, (hooks = new Set()));
  const own = hooks;
  own.add(shown);
  changed(sessionId);
  return () => {
    if (!own.delete(shown)) return;
    if (own.size === 0 && running.get(sessionId) === own) running.delete(sessionId);
    changed(sessionId);
  };
}

/** The tracked hooks running for `sessionId`, in the order they started. */
export function runningHooks(sessionId: string): WindDownHook[] {
  return [...(running.get(sessionId) ?? [])];
}

/** Calls `listener` with the session id whenever a tracked hook of that session starts or ends. */
export function onRunningHooksChange(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
