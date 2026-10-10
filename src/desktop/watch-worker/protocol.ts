// Watch worker messages, shared by main and the worker thread; no electron import.
import type { RawEventType } from './fs-watch-tree';

/** main → worker. close: stop every watch, wait for the scans still running, then answer closed. */
export type WatchRequest =
  | { readonly kind: 'watch'; readonly id: number; readonly dir: string; readonly report: boolean }
  | { readonly kind: 'unwatch'; readonly id: number }
  | { readonly kind: 'close' };

export type WatchEvent = readonly [RawEventType, string];

/**
 * worker → main. events: everything one watch emitted in one turn of the worker's loop, in order. lost: the watch's root is
 * gone, after its deletes. failed: the watch could not start.
 */
export type WatchReply =
  | { readonly kind: 'events'; readonly id: number; readonly events: readonly WatchEvent[] }
  | { readonly kind: 'lost'; readonly id: number }
  | { readonly kind: 'failed'; readonly id: number; readonly message: string }
  | { readonly kind: 'log'; readonly line: string }
  | { readonly kind: 'closed' };

const EVENT_TYPES: ReadonlySet<unknown> = new Set<RawEventType>(['create', 'change', 'delete']);

function record(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isEvents(raw: unknown): raw is WatchEvent[] {
  return Array.isArray(raw) && raw.every((event: unknown) => Array.isArray(event) && event.length === 2 && EVENT_TYPES.has(event[0]) && typeof event[1] === 'string');
}

/** A reply from the worker, checked as untrusted data: anything outside the contract is undefined. */
export function parseWatchReply(raw: unknown): WatchReply | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const kind = own(value, 'kind');
  if (kind === 'closed') return { kind };
  if (kind === 'log') {
    const line = own(value, 'line');
    return typeof line === 'string' ? { kind, line } : undefined;
  }
  const id = own(value, 'id');
  if (!isId(id)) return undefined;
  if (kind === 'lost') return { kind, id };
  if (kind === 'failed') {
    const message = own(value, 'message');
    return typeof message === 'string' ? { kind, id, message } : undefined;
  }
  if (kind !== 'events') return undefined;
  const events = own(value, 'events');
  return isEvents(events) ? { kind, id, events } : undefined;
}
