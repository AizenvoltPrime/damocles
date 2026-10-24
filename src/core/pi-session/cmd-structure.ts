// cmd.exe's reading of the command line it is started with: its switches, the /c quote rule, phase 1 (`%NAME%`),
// phase 2 (carets, quotes, separators, redirections) and phase 5 (`!`), as `cmd /?` documents them and real cmd behaves.
import { COMPUTED_TEXT } from './readonly-shell';

/** What `%NAME%` gives phase 1: its value, nothing (an unset name stays as written), a computed word, or text that may hold syntax. */
export type CmdVariable = { readonly value: string } | 'unset' | 'computed' | 'syntax';

export interface CmdBlocked {
  readonly blocked: string;
}

export interface CmdSwitches {
  /** `/d`: the AutoRun command does not run first. */
  readonly noAutoRun: boolean;
  /** `/s`: the quote rule always strips. */
  readonly strip: boolean;
  /** False for `/e:off`. */
  readonly extensions: boolean;
  /** True for `/v:on`, false for `/v:off`; undefined leaves delayed expansion to the registry. */
  readonly delayed: boolean | undefined;
}

/** cmd's switches and the text after `/c` or `/r`. */
export interface CmdStart {
  readonly switches: CmdSwitches;
  readonly command: string;
}

/** `/?` among the switches: cmd prints its help and runs nothing. */
export interface CmdHelp {
  readonly help: true;
}

export interface CmdCommand {
  /** An internal command's name in lower case, or the program as written without quotes; undefined when computed. */
  readonly name: string | undefined;
  readonly internal: boolean;
  /** The text after the name: what the internal command reads, or the arguments the program's runtime splits. */
  readonly rest: string;
}

export interface CmdSegment {
  /** The command's text after phase 2: carets, redirections and a leading `@` removed, quotes and `!` kept. */
  readonly text: string;
  /** In a pipeline, whose sides cmd runs in child cmd processes that read their text again. */
  readonly piped: boolean;
  /** Each way cmd may take the command token. */
  readonly commands: readonly CmdCommand[];
}

export interface CmdLine {
  readonly switches: CmdSwitches;
  /** The segments of each text cmd may run: the quote rule, an unproven `%NAME%` and delayed expansion can each give more than one. */
  readonly readings: ReadonlyArray<readonly CmdSegment[]>;
}

const FROM_INPUT = 'cmd reads its commands from input, so its git target cannot be read.';
const UNKNOWN_SWITCH = 'cmd takes a switch this check cannot read.';
const MORE_READINGS = 'cmd expands more variables than this check follows, so its text cannot be read.';
// cmd's whitespace (iswspace), measured as cd's delimiter over the BMP; JavaScript's \s differs at U+0085, U+180E and U+FEFF.
const SPACE = '\\t-\\r \\u0085\\u00a0\\u1680\\u180e\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
/** A regex source for one character cmd takes as whitespace; `cd` trims these from the end of its operand. */
export const CMD_SPACE: string = `[${SPACE}]`;
/** A regex source for one character phase 2 reads as a space: it ends a token, and a run of them is skipped before a command. */
export const CMD_DELIMITER: string = `[${SPACE},;=]`;
const DELIMITER = new RegExp(CMD_DELIMITER);
const LEADING = new RegExp(`^${CMD_DELIMITER}*(?:@${CMD_DELIMITER}*)*`);
const COMMAND_START = new RegExp(`${LEADING.source}$`);
const LEADING_SPACE = new RegExp(`^${CMD_SPACE}+`);
const SPACE_CHARACTER = new RegExp(CMD_SPACE);
const SWITCH_END = `(?=[${SPACE}"/]|$)`;
const TARGET_END = new RegExp(`[${SPACE},;=&|<>]`);
const DIGIT_BEFORE_REDIRECTION = new RegExp(`(?:^|${CMD_DELIMITER})\\d$`);
// An internal command's name ends at a delimiter or one of these, which start its text (`cd..`, `cd\`, `cd/d`, `echo(`).
const BOUNDARY = /[.\\/:+[\](]/;
const INTERNAL: readonly string[] = [
  'cd', 'chdir', 'pushd', 'popd', 'set', 'setlocal', 'endlocal', 'start', 'call', 'for', 'if', 'goto', 'rem', 'echo', 'type',
  'dir', 'exit', 'cls', 'title', 'color', 'ver', 'vol', 'path', 'prompt', 'md', 'mkdir', 'rd', 'rmdir', 'del', 'erase', 'copy',
  'move', 'ren', 'rename', 'mklink', 'date', 'time', 'verify', 'break', 'shift', 'assoc', 'ftype', 'pause',
];
// Past this many texts one line may run, from the quote rule, unproven names and delayed expansion, the line blocks.
const MAX_READINGS = 16;

/** cmd's switches up to `/c` or `/r`, and the text after it; cmd reads a switch inside quotes as one outside them. */
export function cmdSwitches(line: string): CmdStart | CmdHelp | CmdBlocked {
  let noAutoRun = false;
  let strip = false;
  let extensions = true;
  let delayed: boolean | undefined;
  for (let i = 0; i < line.length; ) {
    if (line[i] === '"' || SPACE_CHARACTER.test(line[i]!)) {
      i++;
      continue;
    }
    if (line[i] !== '/') return { blocked: UNKNOWN_SWITCH };
    const letter = line[i + 1]?.toLowerCase();
    if (letter === 'c' || letter === 'r') return { switches: { noAutoRun, strip, extensions, delayed }, command: line.slice(i + 2) };
    if (letter === 'k') return { blocked: FROM_INPUT };
    if (new RegExp(`^/\\?${SWITCH_END}`).test(line.slice(i))) return { help: true };
    const toggle = new RegExp(`^/([evf]):(on|off)${SWITCH_END}`, 'i').exec(line.slice(i));
    const plain = toggle ? null : new RegExp(`^/([dsqau]|t:[0-9a-f]{1,2})${SWITCH_END}`, 'i').exec(line.slice(i));
    if (toggle) {
      const on = toggle[2]!.toLowerCase() === 'on';
      if (toggle[1]!.toLowerCase() === 'e') extensions = on;
      if (toggle[1]!.toLowerCase() === 'v') delayed = on;
    } else if (plain) {
      noAutoRun ||= plain[1]!.toLowerCase() === 'd';
      strip ||= plain[1]!.toLowerCase() === 's';
    } else {
      return { blocked: UNKNOWN_SWITCH };
    }
    i += (toggle ?? plain)![0].length;
  }
  return { blocked: FROM_INPUT };
}

/**
 * The texts `/c` may run by the documented quote rule, after cmd skips its whitespace (a line feed included): without its
 * first and last quote, and also as written when every condition for keeping them holds but "names an executable file",
 * which the text does not show. cmd tests that name before expanding it, so a name holding `%` or `!` keeps the quotes
 * only for a file named with those characters, which is not read.
 */
function quoteReadings(command: string, strip: boolean): string[] {
  const text = command.replace(LEADING_SPACE, '');
  if (!text.startsWith('"')) return [text];
  const last = text.lastIndexOf('"');
  const stripped = last === 0 ? text.slice(1) : text.slice(1, last) + text.slice(last + 1);
  const between = text.slice(1, last);
  const keeps = !strip && last > 0 && text.split('"').length === 3 && !/[&<>()@^|%!]/.test(between) && SPACE_CHARACTER.test(between);
  return keeps ? [text, stripped] : [stripped];
}

/**
 * Phase 1: each `%NAME%` as `lookup` gives it. cmd leaves an unset name as written and reads its closing `%` as the next
 * opening one, so a name that may be unset gives a second text read that way.
 */
function expand(text: string, lookup: (name: string) => CmdVariable): string[] | CmdBlocked {
  const results: string[] = [];
  const walk = (from: number, prefix: string): CmdBlocked | undefined => {
    let out = prefix;
    for (let i = from; i < text.length; ) {
      if (text[i] !== '%') {
        out += text[i++];
        continue;
      }
      const close = text.indexOf('%', i + 1);
      if (close < 0) {
        out += text.slice(i);
        break;
      }
      const name = text.slice(i + 1, close);
      const colon = name.indexOf(':');
      const found = name === '' ? 'unset' : name.includes(COMPUTED_TEXT) ? 'computed' : lookup(colon < 0 ? name : name.slice(0, colon));
      if (found === 'syntax') return { blocked: 'cmd expands a variable the command sets, so its text cannot be read.' };
      if (found === 'unset') {
        out += `%${name}`;
        i = close;
        continue;
      }
      if (colon >= 0) {
        // A replacement puts the command's own text into the value; a proven value's substring may cut syntax out of it.
        if (name.includes('=', colon)) return { blocked: 'cmd replaces text inside a variable, so its text cannot be read.' };
        if (typeof found === 'object' && /[&|<>^"()\n]/.test(found.value)) return { blocked: 'cmd expands part of a variable that holds syntax, so its text cannot be read.' };
      }
      if (typeof found === 'object' && colon < 0) {
        out += found.value;
        i = close + 1;
        continue;
      }
      if (found === 'computed' && text.includes('%', close + 1)) {
        const unset = walk(close, `${out}%${name}`);
        if (unset) return unset;
      }
      out += COMPUTED_TEXT;
      i = close + 1;
    }
    results.push(out);
    return results.length > MAX_READINGS ? { blocked: MORE_READINGS } : undefined;
  };
  return walk(0, '') ?? results;
}

/**
 * Phase 2 of a text phase 1 gave, after cmd removes its carriage returns and ignores everything from the first line feed:
 * its commands split at `&`, `&&`, `||` and `|`, with carets, redirections and a leading `@` removed. A `(` where a command
 * starts opens a block, which blocks; every other parenthesis is text, which for a `)` starting a command reads more than
 * cmd runs. Labels block. Each reading is one way delayed expansion may be set (`cmdDelayed`).
 */
export function cmdSegments(phase1: string, delayed: boolean | undefined): CmdSegment[][] | CmdBlocked {
  const unreturned = phase1.replaceAll('\r', '');
  const text = unreturned.includes('\n') ? unreturned.slice(0, unreturned.indexOf('\n')) : unreturned;
  const bodies: Array<{ readonly text: string; readonly piped: boolean }> = [];
  let current = '';
  let quoted = false;
  let piped = false;
  const end = (pipe: boolean): CmdBlocked | undefined => {
    const body = current.replace(LEADING, '');
    current = '';
    quoted = false;
    if (body.startsWith(':')) return { blocked: 'cmd reads a label, which this check cannot follow.' };
    if (body.trim() !== '') bodies.push({ text: body, piped: piped || pipe });
    piped = pipe;
    return undefined;
  };
  // A redirection at `at` and its target, which are data; returns the index of its last character.
  const redirection = (at: number): number => {
    if (DIGIT_BEFORE_REDIRECTION.test(current)) current = current.slice(0, -1);
    let j = at + 1;
    if (text[at] === '>' && text[j] === '>') j++;
    if (text[j] === '&' && /\d/.test(text[j + 1] ?? '')) return j + 1;
    while (j < text.length && DELIMITER.test(text[j]!)) j++;
    for (let inQuote = false; j < text.length; j++) {
      if (text[j] === '"') inQuote = !inQuote;
      else if (!inQuote && TARGET_END.test(text[j]!)) break;
      else if (!inQuote && text[j] === '^') j++;
    }
    current += ' ';
    return j - 1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    let blocked: CmdBlocked | undefined;
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
    } else if (quoted) current += ch;
    else if (ch === '^') current += text[++i] ?? '';
    else if (ch === '(' && COMMAND_START.test(current)) return { blocked: 'cmd groups commands in parentheses, which this check cannot read.' };
    else if (ch === '&' || ch === '|') {
      const doubled = text[i + 1] === ch;
      if (doubled) i++;
      blocked = end(ch === '|' && !doubled);
    } else if (ch === '<' || ch === '>') i = redirection(i);
    else current += ch;
    if (blocked) return blocked;
  }
  return end(false) ?? cmdDelayed(bodies, delayed);
}

/**
 * The readings of phase 5. With delayed expansion off a `!` is text; otherwise it is computed, and where expansion is on,
 * each part of a command holding a `!` (`cmdCommands`) also loses its carets. A pipe's sides keep their text, which the
 * child cmd that runs each reads with its own delayed expansion.
 */
function cmdDelayed(bodies: ReadonlyArray<{ readonly text: string; readonly piped: boolean }>, delayed: boolean | undefined): CmdSegment[][] {
  const off = bodies.map(({ text, piped }) => ({ text, piped, commands: cmdCommands(delayed === false ? text : text.replaceAll('!', COMPUTED_TEXT)) }));
  const differs = delayed !== false && bodies.some(({ text, piped }) => !piped && text.includes('!') && text.includes('^'));
  if (!differs) return [off];
  const on = bodies.map(({ text, piped }, k) => (piped ? off[k]! : { text, piped, commands: cmdCommands(text, true) }));
  return delayed ? [on] : [off, on];
}

/** Phase 5 of one part of a command: where it holds a `!`, each caret goes and keeps the next character, and `!` is computed. */
function delayedPart(part: string): string {
  return part.includes('!') ? part.replace(/\^([\s\S]?)/g, '$1').replaceAll('!', COMPUTED_TEXT) : part;
}

/**
 * The ways cmd takes a command's token: an internal command when its name ends at a delimiter or a boundary character;
 * otherwise a program, and when the token holds an unquoted `/` or `(`, also the program named before the first one
 * (`cmd/c`, `"cmd"/c`, `.\x(y`). `delayed` applies phase 5 to the name and the rest apart, as cmd does.
 */
export function cmdCommands(text: string, delayed = false): CmdCommand[] {
  const phase5 = (part: string): string => (delayed ? delayedPart(part) : part);
  let end = 0;
  let split = -1;
  for (let quoted = false; end < text.length; end++) {
    if (text[end] === '"') quoted = !quoted;
    else if (!quoted && DELIMITER.test(text[end]!)) break;
    else if (!quoted && split < 0 && (text[end] === '/' || text[end] === '(')) split = end;
  }
  const token = text.slice(0, end);
  const after = text.slice(end);
  const lowered = token.toLowerCase();
  const internal = token.startsWith('"') ? undefined : INTERNAL.find((name) => lowered.startsWith(name) && (lowered.length === name.length || BOUNDARY.test(lowered[name.length]!)));
  if (internal !== undefined) return [{ name: internal, internal: true, rest: phase5(token.slice(internal.length) + after) }];
  const program = (written: string, rest: string): CmdCommand => {
    const name = phase5(written).replaceAll('"', '');
    return { name: name.includes(COMPUTED_TEXT) ? undefined : name, internal: false, rest: phase5(rest) };
  };
  const prefix = token.slice(0, Math.max(split, 0)).replaceAll('"', '');
  // `C:/x` is one name cmd does not find, while `C:(x` changes drive.
  const named = prefix !== '' && !(text[split] === '/' && /^[A-Za-z]:$/.test(prefix));
  return named ? [program(token, after), program(token.slice(0, split), token.slice(split) + after)] : [program(token, after)];
}

/** The tokens of an internal command's text, split at unquoted delimiters, quotes kept, each with its offset. */
export function cmdTokens(text: string): Array<{ readonly text: string; readonly offset: number }> {
  const tokens: Array<{ text: string; offset: number }> = [];
  for (let i = 0; i < text.length; ) {
    if (DELIMITER.test(text[i]!)) {
      i++;
      continue;
    }
    const offset = i;
    for (let quoted = false; i < text.length && (quoted || !DELIMITER.test(text[i]!)); i++) if (text[i] === '"') quoted = !quoted;
    tokens.push({ text: text.slice(offset, i), offset });
  }
  return tokens;
}

/** The command cmd runs after the switches `cmdSwitches` read, read as cmd reads it; `lookup` gives each `%NAME%` (phase 1). */
export function parseCmdLine({ switches, command }: CmdStart, lookup: (name: string) => CmdVariable): CmdLine | CmdBlocked {
  const readings: CmdSegment[][] = [];
  for (const text of quoteReadings(command, switches.strip)) {
    const expanded = expand(text, lookup);
    if ('blocked' in expanded) return expanded;
    for (const each of expanded) {
      const read = cmdSegments(each, switches.delayed);
      if ('blocked' in read) return read;
      readings.push(...read);
    }
  }
  return readings.length > MAX_READINGS ? { blocked: MORE_READINGS } : { switches, readings };
}
