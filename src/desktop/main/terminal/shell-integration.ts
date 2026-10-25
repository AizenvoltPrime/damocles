// Shell integration in main (D57): OSC 633 parsing, adapted from VS Code's shellIntegrationAddon.ts (MIT).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import { MAX_SHELL_SEQUENCE_CHARS, MAX_TERMINAL_CWD_CHARS, MAX_TERMINAL_TITLE_CHARS } from '../../preload/terminal-channels';
import type { LinkPathStyle } from './terminal-links';

/** A fresh 128-bit nonce for one shell process; only main and that process's integration script ever hold it. */
export function newShellNonce(): string {
  return randomBytes(16).toString('hex');
}

const ESC = '\x1b';
const BEL = '\x07';
const CAN = '\x18';
const SUB = '\x1a';
const DEL = '\x7f';
// C1 OSC, which xterm also reads as an OSC introducer; such a sequence is stripped like the 7-bit one.
const C1_OSC = '\x9d';
// C1 ST ends an OSC as BEL does; any other C1 control ends one unhandled and is read again outside it (xterm's
// VT500_TRANSITION_TABLE).
const C1_ST = '\x9c';
// The ident before `;`: 633 with any leading zeros, as xterm parses it. An ident that is still all zeros or a 633 prefix
// at this many digits is stripped through its end, so the held introducer stays bounded.
const MAX_IDENT_DIGITS = 16;
const IDENT_PREFIX = /^0*(?:6(?:3(?:3)?)?)?$/;
const IDENT_633 = /^0*633$/;
// xterm's PAYLOAD_LIMIT (common/parser/Constants.ts): its OSC handler never sees a longer payload.
const XTERM_OSC_PAYLOAD_LIMIT = 10_000_000;
// A raw C0 control or DEL inside a body: the scripts escape every one, so the sequence is malformed. A C1 control ends
// the sequence before it reaches a body.
// eslint-disable-next-line no-control-regex -- the C0 controls and DEL are what this matches
const RAW_CONTROL = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex -- the C0 controls xterm never puts into an OSC payload
const C0_CONTROLS = /[\x00-\x1f]/g;

// xterm's EXECUTABLES: run at once after a lone ESC, which still waits, and ignored inside an OSC, where BEL ends it instead.
function isExecutable(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x18 || code === 0x19 || (code >= 0x1c && code < 0x20);
}

const isC1 = (char: string): boolean => char >= '\x80' && char <= '\x9f';

// An ident's digits without leading zeros while it may still be 633, else 'x'.
function identSoFar(digits: string): string {
  const id = digits.replace(/^0+/, '');
  return IDENT_PREFIX.test(id) ? id : 'x';
}

interface Discard {
  readonly kind: 'discard';
  readonly escape: boolean;
  // the ident as identSoFar reads it while xterm still reads it; null after it
  readonly ident: string | null;
  // after the ident: xterm hands the end to its 633 handler unless the payload passes its limit
  readonly handled: boolean;
  // the characters xterm has put into the payload
  readonly payload: number;
}

type ParserState =
  | { readonly kind: 'ground' }
  // a lone ESC at the end of the input so far
  | { readonly kind: 'escape' }
  // after ESC ] or C1 OSC, reading the ident
  | { readonly kind: 'ident'; readonly digits: string }
  // escape: an ESC was read and the next character decides between ST and an abort
  | { readonly kind: 'body'; readonly body: string; readonly malformed: boolean; readonly escape: boolean }
  // past MAX_IDENT_DIGITS or MAX_SHELL_SEQUENCE_CHARS: stripped through its end, counted as xterm counts it
  | Discard;

// One more character of a discarded sequence, as xterm's OscParser reads it.
function discarded(state: Discard, char: string): Discard {
  if (isExecutable(char)) return state;
  if (state.ident === null) return { ...state, payload: state.payload + 1 };
  if (char >= '0' && char <= '9') return { ...state, ident: identSoFar(state.ident + char) };
  return { ...state, ident: null, handled: char === ';' && state.ident === '633' };
}

// Whether xterm hands this sequence's end to its 633 handler.
function handled(state: Extract<ParserState, { kind: 'body' | 'discard' }>): boolean {
  if (state.kind === 'body') return true;
  return state.ident === null ? state.handled && state.payload <= XTERM_OSC_PAYLOAD_LIMIT : state.ident === '633';
}

export interface ParsedChunk {
  // the input without its OSC 633 sequences, minus a partial introducer held for the next chunk
  readonly data: string;
  // the complete, well-formed sequences' fields (after `633;`, split on ';'), each at its offset into data, with its index
  // among the sequences since the stream began
  readonly sequences: ReadonlyArray<{ readonly offset: number; readonly fields: readonly string[]; readonly index: number }>;
  // characters that will never be forwarded, counted as soon as they are known to belong to a 633 sequence
  readonly stripped: number;
}

/**
 * One terminal's output stream with every OSC 633 sequence removed, trusted or not, read as xterm's parser reads it. A
 * sequence ends at BEL, C1 ST or ESC \; an ESC not followed by \ ends it too and starts what follows; CAN, SUB or another
 * C1 control cancels it. A partial sequence waits for the next chunk and no character of a 633 sequence is ever forwarded.
 * Only an introducer that may still turn out to be another OSC is held back unacknowledged, so flow control never stalls on
 * a long or endless sequence.
 */
export class Osc633Stream {
  private state: ParserState = { kind: 'ground' };
  // Every sequence xterm hands its OSC 633 handler counts, malformed and ended by ESC included, so an index names the same
  // sequence as the pty host's screen counts it (pty-host/screen.ts); a cancelled one is not counted.
  private dispatched: number;
  // ESC, `]` or C1 OSC and ident digits: forwarded if the sequence is not 633, stripped if it is
  private held = '';

  // next: the index of the stream's first sequence, a restored screen's count when the stream starts after it
  constructor(next = 0) {
    this.dispatched = next;
  }

  /** The index the next sequence gets. */
  get next(): number {
    return this.dispatched;
  }

  push(chunk: string): ParsedChunk {
    let out = '';
    let stripped = 0;
    const sequences: Array<{ offset: number; fields: string[]; index: number }> = [];
    const release = (): void => {
      out += this.held;
      this.held = '';
      this.state = { kind: 'ground' };
    };
    const enterBody = (malformed: boolean): void => {
      stripped += this.held.length;
      this.held = '';
      this.state = { kind: 'body', body: '', malformed, escape: false };
    };
    const end = (state: Extract<ParserState, { kind: 'body' | 'discard' }>): void => {
      if (handled(state)) {
        const index = this.dispatched++;
        if (state.kind === 'body' && !state.malformed) sequences.push({ offset: out.length, fields: state.body.split(';'), index });
      }
      this.state = { kind: 'ground' };
    };
    let i = 0;
    while (i < chunk.length) {
      const state = this.state;
      if (state.kind === 'ground') {
        let next = i;
        while (next < chunk.length && chunk[next] !== ESC && chunk[next] !== C1_OSC) next += 1;
        out += chunk.slice(i, next);
        if (next === chunk.length) break;
        this.held = chunk[next]!;
        this.state = chunk[next] === ESC ? { kind: 'escape' } : { kind: 'ident', digits: '' };
        i = next + 1;
        continue;
      }
      const char = chunk[i]!;
      if (state.kind === 'escape') {
        if (char === ']') {
          this.held += char;
          this.state = { kind: 'ident', digits: '' };
          i += 1;
        } else if (isExecutable(char) || char === DEL) {
          // xterm runs it, or ignores DEL, and still waits on the ESC
          out += char;
          i += 1;
        } else {
          // not an OSC: the ESC goes out and this character is read again from the ground state
          release();
        }
        continue;
      }
      if (state.kind === 'ident') {
        const digit = char >= '0' && char <= '9' && IDENT_PREFIX.test(state.digits + char);
        if (digit && state.digits.length < MAX_IDENT_DIGITS) {
          this.held += char;
          this.state = { kind: 'ident', digits: state.digits + char };
          i += 1;
        } else if (digit) {
          stripped += this.held.length + 1;
          this.held = '';
          this.state = { kind: 'discard', escape: false, ident: identSoFar(state.digits + char), handled: false, payload: 0 };
          i += 1;
        } else if (IDENT_633.test(state.digits) && char === ';') {
          stripped += 1;
          i += 1;
          enterBody(false);
        } else if (IDENT_633.test(state.digits) && (char === BEL || char === ESC || char === C1_ST)) {
          // `633` with no fields: nothing to trust; this character ends it as it would end a body
          enterBody(true);
        } else if (isExecutable(char) && char !== BEL) {
          // xterm ignores it inside an OSC
          stripped += 1;
          i += 1;
        } else {
          // another OSC (title, hyperlink, ...): forwarded untouched, this character read again from the ground state
          release();
        }
        continue;
      }
      if (state.escape) {
        if (char === '\\') {
          stripped += 2;
          i += 1;
          end(state);
        } else {
          // the ESC ended the sequence and starts whatever follows, this character read again after it
          if (handled(state)) this.dispatched++;
          this.held = ESC;
          this.state = { kind: 'escape' };
        }
        continue;
      }
      if (isC1(char) && char !== C1_ST) {
        // the sequence ends unhandled and this control is read again from the ground state
        this.state = { kind: 'ground' };
        continue;
      }
      i += 1;
      if (char === ESC) {
        this.state = { ...state, escape: true };
        continue;
      }
      stripped += 1;
      if (char === BEL || char === C1_ST) {
        end(state);
      } else if (char === CAN || char === SUB) {
        this.state = { kind: 'ground' };
      } else if (state.kind === 'discard') {
        this.state = discarded(state, char);
      } else {
        const body = state.body + char;
        this.state = state.body.length >= MAX_SHELL_SEQUENCE_CHARS
          ? { kind: 'discard', escape: false, ident: null, handled: true, payload: body.replace(C0_CONTROLS, '').length }
          : { ...state, body, malformed: state.malformed || RAW_CONTROL.test(char) };
      }
    }
    return { data: out, sequences, stripped };
  }
}

/** VS Code's deserializeMessage: `\\` is a backslash and `\xAB` the character AB; nothing else is an escape. */
export function deserializeShellValue(value: string): string {
  return value.replace(/\\(\\|x([0-9a-f]{2}))/gi, (_match, op: string, hex: string | undefined) => (hex !== undefined ? String.fromCharCode(parseInt(hex, 16)) : op));
}

// Control, format (bidi, zero-width, tags), separator and lone surrogate characters; ZWNJ and ZWJ are kept.
const REFUSED = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const REFUSED_GLOBAL = new RegExp(REFUSED.source, 'gu');
// A command line keeps its line breaks and tabs (multi-line commands, rerun); nothing else refused.
const COMMAND_LINE_REFUSED = /(?![\n\t\u200C\u200D])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
// An exit code as the scripts print it; anything else (hex, exponent, spaces) is refused.
const EXIT_CODE = /^-?\d{1,10}$/;
const MIN_EXIT_CODE = -2_147_483_648;
const MAX_EXIT_CODE = 4_294_967_295;
const WSL_MOUNT = /^\/mnt\/([a-z])(?:\/(.*))?$/i;
const WIN32_DRIVE_ABSOLUTE = /^[a-z]:[\\/]/i;

export type ShellSequence =
  | { readonly type: 'promptStart' }
  | { readonly type: 'commandStart' }
  | { readonly type: 'commandExecuted' }
  | { readonly type: 'commandFinished'; readonly exitCode: number | null }
  | { readonly type: 'commandLine'; readonly commandLine: string }
  | { readonly type: 'cwd'; readonly cwd: string | null };

function nonceMatches(field: string, nonce: string): boolean {
  const given = Buffer.from(field, 'utf8');
  const expected = Buffer.from(nonce, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** An absolute working directory in main's path form (a WSL /mnt/<drive> path mapped to Windows), or null when refused. */
export function parseShellCwd(value: string, style: LinkPathStyle): string | null {
  if (value.length === 0 || value.length > MAX_TERMINAL_CWD_CHARS || REFUSED.test(value)) return null;
  if (style === 'posix') return value.startsWith('/') ? path.posix.normalize(value) : null;
  if (style === 'wsl') {
    const mount = WSL_MOUNT.exec(value);
    return mount ? path.win32.normalize(`${mount[1]!.toUpperCase()}:\\${mount[2] ?? ''}`) : null;
  }
  // A drive path, `\` or `/` separated (Git Bash reports `cygpath -m`); UNC, device and drive-relative paths are refused.
  return WIN32_DRIVE_ABSOLUTE.test(value) ? path.win32.normalize(value) : null;
}

/**
 * A sequence from the terminal's own integration script: the exact field count for its type, and the nonce as its last
 * field. Anything else, including a property other than Cwd, is undefined and changes nothing.
 */
export function parseShellSequence(fields: readonly string[], nonce: string, style: LinkPathStyle): ShellSequence | undefined {
  const last = fields.at(-1);
  if (fields.length < 2 || last === undefined || !nonceMatches(last, nonce)) return undefined;
  const [type, value] = fields;
  if (fields.length === 2) {
    if (type === 'A') return { type: 'promptStart' };
    if (type === 'B') return { type: 'commandStart' };
    if (type === 'C') return { type: 'commandExecuted' };
    return undefined;
  }
  if (fields.length !== 3 || value === undefined) return undefined;
  if (type === 'D') {
    if (value === '') return { type: 'commandFinished', exitCode: null };
    if (!EXIT_CODE.test(value)) return undefined;
    const exitCode = Number(value);
    return exitCode >= MIN_EXIT_CODE && exitCode <= MAX_EXIT_CODE ? { type: 'commandFinished', exitCode } : undefined;
  }
  if (type === 'E') {
    const commandLine = deserializeShellValue(value);
    return COMMAND_LINE_REFUSED.test(commandLine) ? undefined : { type: 'commandLine', commandLine };
  }
  if (type === 'P' && value.startsWith('Cwd=')) return { type: 'cwd', cwd: parseShellCwd(deserializeShellValue(value.slice('Cwd='.length)), style) };
  return undefined;
}

/**
 * Text main shows as a terminal's title or description: its first line, refused characters removed, whitespace collapsed,
 * cut to MAX_TERMINAL_TITLE_CHARS with '…'; null when nothing is left.
 */
export function sanitizeTitle(text: string): string | null {
  return sanitizeDisplayText(text, MAX_TERMINAL_TITLE_CHARS);
}

/** sanitizeTitle's cleaning with another length, such as a profile's executable path shown as a description. */
export function sanitizeDisplayText(text: string, maxChars: number): string | null {
  const line = (text.split('\n', 1)[0] ?? '').replace(/\t/g, ' ').replace(REFUSED_GLOBAL, '').replace(/\s+/g, ' ').trim();
  if (line.length === 0) return null;
  if (line.length <= maxChars) return line;
  // A cut inside a surrogate pair drops its high half.
  return `${line.slice(0, maxChars - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/** The description's folder: the cwd's last segment when the cwd is not the project folder itself. */
export function cwdFolderName(cwd: string, projectPath: string, style: LinkPathStyle): string | null {
  const flavor = style === 'posix' ? path.posix : path.win32;
  // win32's relative compares case-insensitively, as Windows paths do.
  return flavor.relative(projectPath, cwd) === '' ? null : sanitizeTitle(flavor.basename(cwd) || cwd);
}
