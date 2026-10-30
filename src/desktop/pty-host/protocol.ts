// The pty host's messages, shared by main and the host; no electron import.

import {
  MAX_KEPT_SHELL_SEQUENCE_CHARS,
  MAX_KEPT_SHELL_SEQUENCES,
  MAX_SHELL_SEQUENCE_CHARS,
  MAX_TERMINAL_ACK_CHARS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ID_LENGTH,
  MAX_TERMINAL_INPUT_CHARS,
  MAX_TERMINAL_ROWS,
  MAX_TERMINAL_SCREEN_CHARS,
  MAX_TERMINAL_SCREEN_MARKS,
  TERMINAL_ICONS,
  type TerminalIcon,
} from '../preload/terminal-channels';

// The host sends a pty's output every TERMINAL_BATCH_MS, or as soon as TERMINAL_BATCH_CHARS are buffered, in messages of at
// most TERMINAL_BATCH_CHARS.
export const TERMINAL_BATCH_MS = 5;
export const TERMINAL_BATCH_CHARS: number = 64 * 1024;
// The executable, the cwd and each argument main sends.
export const MAX_HOST_PATH_CHARS = 4096;
export const MAX_HOST_ARGS = 16;
export const MAX_HOST_ENV_ENTRIES = 4096;
// Characters of one environment variable's name plus value; Windows caps a whole block at 32,767.
export const MAX_HOST_ENV_CHARS = 32_767;
// Characters of an error message the host reports; the rest is cut.
export const MAX_HOST_MESSAGE_CHARS = 2000;
// Characters of a foreground process name the host reports; the rest is cut.
export const MAX_HOST_PROCESS_NAME_CHARS = 256;
// The host's argv entry naming the node-pty package it loads.
export const NODE_PTY_ARG_PREFIX = '--node-pty=';
// The daemon's argv entry: each pty's output is acknowledged once its screen consumed it, so no client paces a pty.
export const SELF_ACKNOWLEDGE_ARG = '--self-acknowledge';
// The scrollback of a screen the host keeps; the terminal scrollback setting's maximum.
export const MAX_SCREEN_SCROLLBACK = 100_000;

const TERMINAL_ID = /^term-[1-9][0-9]{0,14}$/;
// A shell-integration nonce: newShellNonce's 32 hex digits.
const NONCE = /^[0-9a-f]{32}$/;

// What another client needs to show a daemon's terminal: its root key's part after the authority key (the same on every
// client), the profile it started with, its start folder and its shell-integration nonce. A pty host ignores it.
export interface TerminalView {
  readonly root: string;
  readonly profile: { readonly id: string; readonly name: string; readonly file: string; readonly args: readonly string[]; readonly icon: TerminalIcon };
  readonly startCwd: string;
  readonly nonce: string;
}

/**
 * main → host. killAll kills every pty (the window closed); shutdown kills every pty and ends the host; clearAck forgets a
 * pty's unacknowledged output (a reloaded shell); serialize answers the pty's screen after every data message before it;
 * clear clears that screen as the shell's Clear does; scrollback sets the scrollback that screen keeps; detach: a client's
 * view closed, which only a daemon's hub reads.
 */
export type HostRequest =
  | {
      readonly type: 'spawn';
      readonly id: string;
      readonly file: string;
      readonly args: readonly string[];
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly cols: number;
      readonly rows: number;
      readonly scrollback: number;
      // a remote terminal's, which the daemon lists to its other clients
      readonly view?: TerminalView;
    }
  | { readonly type: 'input'; readonly id: string; readonly data: string }
  | { readonly type: 'resize'; readonly id: string; readonly cols: number; readonly rows: number }
  | { readonly type: 'ack'; readonly id: string; readonly chars: number }
  | { readonly type: 'clearAck'; readonly id: string }
  | { readonly type: 'serialize'; readonly id: string }
  | { readonly type: 'clear'; readonly id: string }
  | { readonly type: 'scrollback'; readonly id: string; readonly scrollback: number }
  | { readonly type: 'kill'; readonly id: string }
  | { readonly type: 'detach'; readonly id: string }
  | { readonly type: 'killAll' }
  | { readonly type: 'shutdown' };

// Where the OSC 633 sequence with this index since the spawn stood: its absolute line in the screen's buffer.
export interface ScreenMark {
  readonly index: number;
  readonly line: number;
}

// An OSC 633 payload of a type main parses (KEPT_SHELL_SEQUENCE), as the screen parsed it: its index since the spawn, its text
// after `633;` and the host's clock in ms when it was parsed. Untrusted: main applies one only after its own nonce check.
export interface KeptShellSequence {
  readonly index: number;
  readonly body: string;
  readonly time: number;
}

// The payload types parseShellSequence reads: prompt start, command start, executed, finished, command line and property.
export const KEPT_SHELL_SEQUENCE: RegExp = /^[ABCDEP](?:;|$)/;

/**
 * host → main. error: the pty could not start; exitCode is the process's. process: node-pty's foreground process name changed
 * (macOS and Linux). screen: the answer to serialize; sequences is the index the next OSC 633 sequence after it gets,
 * shellSequences the latest kept payloads in index order and processName the last process name posted (feature
 * terminals.screenShellState), now the host's clock at the serialize, which each kept time is read against (feature
 * terminals.screenHostClock).
 */
export type HostMessage =
  | { readonly type: 'ready'; readonly id: string; readonly pid: number }
  | { readonly type: 'data'; readonly id: string; readonly data: string }
  | {
      readonly type: 'screen';
      readonly id: string;
      readonly data: string;
      readonly cols: number;
      readonly rows: number;
      readonly marks: readonly ScreenMark[];
      readonly sequences: number;
      readonly shellSequences?: readonly KeptShellSequence[];
      readonly processName?: string;
      readonly now?: number;
    }
  | { readonly type: 'process'; readonly id: string; readonly name: string }
  | { readonly type: 'exit'; readonly id: string; readonly exitCode: number }
  | { readonly type: 'error'; readonly id: string; readonly message: string };

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

export const isTerminalId = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TERMINAL_ID_LENGTH && TERMINAL_ID.test(value);
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const isPath = (value: unknown): value is string => isText(value, MAX_HOST_PATH_CHARS) && value.length > 0 && !value.includes('\0');
const isInteger = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function parseArgs(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_HOST_ARGS) return undefined;
  return (raw as unknown[]).every((arg) => isText(arg, MAX_HOST_PATH_CHARS) && !arg.includes('\0')) ? [...(raw as string[])] : undefined;
}

/** An environment variable the host accepts; main drops any other before it sends a spawn. */
export function isHostEnvEntry(key: string, value: unknown): value is string {
  return key.length > 0 && !key.includes('=') && !key.includes('\0') && typeof value === 'string' && !value.includes('\0') && key.length + value.length <= MAX_HOST_ENV_CHARS;
}

/** A terminal's view as a spawn carries it and a daemon lists it; anything outside the contract is undefined. */
export function parseTerminalView(raw: unknown): TerminalView | undefined {
  const value = record(raw);
  const profile = value && record(own(value, 'profile'));
  if (!value || !profile) return undefined;
  const root = own(value, 'root');
  const startCwd = own(value, 'startCwd');
  const nonce = own(value, 'nonce');
  const id = own(profile, 'id');
  const name = own(profile, 'name');
  const file = own(profile, 'file');
  const args = parseArgs(own(profile, 'args'));
  const icon = own(profile, 'icon');
  if (!isText(root, MAX_HOST_PATH_CHARS) || root.length === 0 || !isPath(startCwd) || typeof nonce !== 'string' || !NONCE.test(nonce)) return undefined;
  if (!isPath(id) || !isText(name, MAX_HOST_PATH_CHARS) || !isPath(file) || !args || !(TERMINAL_ICONS as readonly unknown[]).includes(icon)) return undefined;
  return { root, profile: { id, name, file, args, icon: icon as TerminalIcon }, startCwd, nonce };
}

function parseEnv(raw: unknown): Record<string, string> | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const entries = Object.entries(value);
  if (entries.length > MAX_HOST_ENV_ENTRIES) return undefined;
  const env: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!isHostEnvEntry(key, entry)) return undefined;
    env[key] = entry;
  }
  return env;
}

/** A request from main, which builds every one; anything outside the contract is undefined. */
export function parseHostRequest(raw: unknown): HostRequest | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const type = own(value, 'type');
  if (type === 'shutdown' || type === 'killAll') return { type };
  const id = own(value, 'id');
  if (!isTerminalId(id)) return undefined;
  switch (type) {
    case 'spawn': {
      const file = own(value, 'file');
      const args = parseArgs(own(value, 'args'));
      const cwd = own(value, 'cwd');
      const env = parseEnv(own(value, 'env'));
      const cols = own(value, 'cols');
      const rows = own(value, 'rows');
      const scrollback = own(value, 'scrollback');
      const rawView = own(value, 'view');
      const view = rawView === undefined ? undefined : parseTerminalView(rawView);
      if (!isPath(file) || !args || !isPath(cwd) || !env || !isInteger(cols, 1, MAX_TERMINAL_COLS) || !isInteger(rows, 1, MAX_TERMINAL_ROWS) || !isInteger(scrollback, 0, MAX_SCREEN_SCROLLBACK)) return undefined;
      if (rawView !== undefined && !view) return undefined;
      return { type, id, file, args, cwd, env, cols, rows, scrollback, ...(view ? { view } : {}) };
    }
    case 'input': {
      const data = own(value, 'data');
      return isText(data, MAX_TERMINAL_INPUT_CHARS) ? { type, id, data } : undefined;
    }
    case 'resize': {
      const cols = own(value, 'cols');
      const rows = own(value, 'rows');
      return isInteger(cols, 1, MAX_TERMINAL_COLS) && isInteger(rows, 1, MAX_TERMINAL_ROWS) ? { type, id, cols, rows } : undefined;
    }
    case 'ack': {
      const chars = own(value, 'chars');
      return isInteger(chars, 1, MAX_TERMINAL_ACK_CHARS) ? { type, id, chars } : undefined;
    }
    case 'scrollback': {
      const scrollback = own(value, 'scrollback');
      return isInteger(scrollback, 0, MAX_SCREEN_SCROLLBACK) ? { type, id, scrollback } : undefined;
    }
    case 'clearAck':
    case 'serialize':
    case 'clear':
    case 'kill':
    case 'detach':
      return { type, id };
    default:
      return undefined;
  }
}

function parseMarks(raw: unknown): ScreenMark[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_TERMINAL_SCREEN_MARKS) return undefined;
  const marks: ScreenMark[] = [];
  for (const entry of raw as unknown[]) {
    const mark = record(entry);
    const index = mark && own(mark, 'index');
    const line = mark && own(mark, 'line');
    if (!isInteger(index, 0, Number.MAX_SAFE_INTEGER) || !isInteger(line, 0, Number.MAX_SAFE_INTEGER)) return undefined;
    marks.push({ index, line });
  }
  return marks;
}

// Strictly ascending indexes below the screen's count, within both kept bounds.
function parseShellSequences(raw: unknown, sequences: number): KeptShellSequence[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_KEPT_SHELL_SEQUENCES) return undefined;
  const kept: KeptShellSequence[] = [];
  let chars = 0;
  let next = 0;
  for (const entry of raw as unknown[]) {
    const value = record(entry);
    const index = value && own(value, 'index');
    const body = value && own(value, 'body');
    const time = value && own(value, 'time');
    if (!isInteger(index, next, sequences - 1) || !isText(body, MAX_SHELL_SEQUENCE_CHARS) || !KEPT_SHELL_SEQUENCE.test(body) || !isInteger(time, 0, Number.MAX_SAFE_INTEGER)) return undefined;
    chars += body.length;
    if (chars > MAX_KEPT_SHELL_SEQUENCE_CHARS) return undefined;
    next = index + 1;
    kept.push({ index, body, time });
  }
  return kept;
}

export type ScreenOptionalField = 'shellSequences' | 'processName' | 'now';

/**
 * A message from the host as main reads it: anything outside the contract is undefined, except that a screen's optional
 * field outside it is left out and named to dropped, so it costs that field and never the host with every terminal.
 */
export function parseHostMessage(raw: unknown, dropped?: (field: ScreenOptionalField, id: string) => void): HostMessage | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const type = own(value, 'type');
  const id = own(value, 'id');
  if (!isTerminalId(id)) return undefined;
  switch (type) {
    case 'ready': {
      const pid = own(value, 'pid');
      return isInteger(pid, 0, Number.MAX_SAFE_INTEGER) ? { type, id, pid } : undefined;
    }
    case 'data': {
      const data = own(value, 'data');
      return isText(data, TERMINAL_BATCH_CHARS) && data.length > 0 ? { type, id, data } : undefined;
    }
    case 'process': {
      const name = own(value, 'name');
      return isText(name, MAX_HOST_PROCESS_NAME_CHARS) ? { type, id, name } : undefined;
    }
    case 'screen': {
      const data = own(value, 'data');
      const cols = own(value, 'cols');
      const rows = own(value, 'rows');
      const marks = parseMarks(own(value, 'marks'));
      const sequences = own(value, 'sequences');
      if (!isText(data, MAX_TERMINAL_SCREEN_CHARS) || !isInteger(cols, 1, MAX_TERMINAL_COLS) || !isInteger(rows, 1, MAX_TERMINAL_ROWS) || !marks || !isInteger(sequences, 0, Number.MAX_SAFE_INTEGER)) return undefined;
      const optional = <T>(field: ScreenOptionalField, parse: (raw: unknown) => T | undefined): T | undefined => {
        const rawField = own(value, field);
        if (rawField === undefined) return undefined;
        const parsed = parse(rawField);
        if (parsed === undefined) dropped?.(field, id);
        return parsed;
      };
      const shellSequences = optional('shellSequences', (rawField) => parseShellSequences(rawField, sequences));
      const processName = optional('processName', (rawField) => (isText(rawField, MAX_HOST_PROCESS_NAME_CHARS) ? rawField : undefined));
      const now = optional('now', (rawField) => (isInteger(rawField, 0, Number.MAX_SAFE_INTEGER) ? rawField : undefined));
      return { type, id, data, cols, rows, marks, sequences, ...(shellSequences ? { shellSequences } : {}), ...(processName !== undefined ? { processName } : {}), ...(now !== undefined ? { now } : {}) };
    }
    case 'exit': {
      const exitCode = own(value, 'exitCode');
      return isInteger(exitCode, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) ? { type, id, exitCode } : undefined;
    }
    case 'error': {
      const message = own(value, 'message');
      return isText(message, MAX_HOST_MESSAGE_CHARS) ? { type, id, message } : undefined;
    }
    default:
      return undefined;
  }
}
