// The pty host's messages, shared by main and the host; no electron import.

import {
  MAX_TERMINAL_ACK_CHARS,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ID_LENGTH,
  MAX_TERMINAL_INPUT_CHARS,
  MAX_TERMINAL_ROWS,
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

const TERMINAL_ID = /^term-[1-9][0-9]{0,14}$/;

/**
 * main → host. killAll kills every pty (the window closed); shutdown kills every pty and ends the host; clearAck forgets a
 * pty's unacknowledged output (a reloaded shell).
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
    }
  | { readonly type: 'input'; readonly id: string; readonly data: string }
  | { readonly type: 'resize'; readonly id: string; readonly cols: number; readonly rows: number }
  | { readonly type: 'ack'; readonly id: string; readonly chars: number }
  | { readonly type: 'clearAck'; readonly id: string }
  | { readonly type: 'kill'; readonly id: string }
  | { readonly type: 'killAll' }
  | { readonly type: 'shutdown' };

/** host → main. error: the pty could not start; exitCode is the process's. process: node-pty's foreground process name changed (macOS and Linux). */
export type HostMessage =
  | { readonly type: 'ready'; readonly id: string; readonly pid: number }
  | { readonly type: 'data'; readonly id: string; readonly data: string }
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
      if (!isPath(file) || !args || !isPath(cwd) || !env || !isInteger(cols, 1, MAX_TERMINAL_COLS) || !isInteger(rows, 1, MAX_TERMINAL_ROWS)) return undefined;
      return { type, id, file, args, cwd, env, cols, rows };
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
    case 'clearAck':
    case 'kill':
      return { type, id };
    default:
      return undefined;
  }
}

/** A message from the host as main reads it: anything outside the contract is undefined. */
export function parseHostMessage(raw: unknown): HostMessage | undefined {
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
