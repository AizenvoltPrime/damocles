// The formatter host's messages, shared by main and the host; no electron import.

import { MAX_EDITOR_TEXT_CHARS } from '../preload/shell-channels';

// A path main sends or the host reports: the confined file, the resolved Prettier entry, its config, a refused module.
export const MAX_HOST_PATH_CHARS = 4096;
// Characters of an error message the host reports; the rest is cut.
export const MAX_HOST_MESSAGE_CHARS = 4000;

/**
 * main → host: format `text` as the file at `file` with the Prettier whose CommonJS entry is `prettier`, configured by
 * exactly the file `config` (null: none), which main found inside the root; Prettier never searches for one itself.
 */
export interface HostRequest {
  readonly id: number;
  readonly prettier: string;
  readonly config: string | null;
  readonly file: string;
  readonly text: string;
}

/**
 * host → main. loaded: Prettier, the config and its plugins have loaded for the request, which then has its format budget,
 * and is sent once before the request's reply. ignored: Prettier ignores the file or infers no parser for it, so it stays as
 * it is. refused: Prettier tried to load a module whose real path is outside the root, and it was not loaded.
 */
export type HostReply =
  | { readonly id: number; readonly kind: 'loaded' }
  | { readonly id: number; readonly kind: 'formatted'; readonly text: string }
  | { readonly id: number; readonly kind: 'ignored' }
  | { readonly id: number; readonly kind: 'refused'; readonly path: string }
  | { readonly id: number; readonly kind: 'error'; readonly message: string };

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const isPath = (value: unknown): value is string => isText(value, MAX_HOST_PATH_CHARS) && value.length > 0 && !value.includes('\0');

export function parseHostRequest(raw: unknown): HostRequest | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const id = own(value, 'id');
  const prettier = own(value, 'prettier');
  const config = own(value, 'config');
  const file = own(value, 'file');
  const text = own(value, 'text');
  const configOk = config === null || isPath(config);
  return isId(id) && isPath(prettier) && configOk && isPath(file) && isText(text, MAX_EDITOR_TEXT_CHARS) ? { id, prettier, config, file, text } : undefined;
}

/** A reply from the host, which runs the project's code: anything outside the contract is undefined. */
export function parseHostReply(raw: unknown): HostReply | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const id = own(value, 'id');
  const kind = own(value, 'kind');
  if (!isId(id)) return undefined;
  if (kind === 'loaded' || kind === 'ignored') return { id, kind };
  if (kind === 'refused') {
    const refused = own(value, 'path');
    return isPath(refused) ? { id, kind, path: refused } : undefined;
  }
  if (kind === 'formatted') {
    const text = own(value, 'text');
    return isText(text, MAX_EDITOR_TEXT_CHARS) ? { id, kind, text } : undefined;
  }
  if (kind === 'error') {
    const message = own(value, 'message');
    return isText(message, MAX_HOST_MESSAGE_CHARS) ? { id, kind, message } : undefined;
  }
  return undefined;
}
