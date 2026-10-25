// The core protocol over a daemon's `core` channel. Each client attach (control.attachCore) is its own endpoint lifetime, so
// every message carries the attach generation it belongs to: what an earlier generation left in flight is dropped, never
// read by the next endpoint.
import type { Disposable } from '../../platform/disposable';
import type { CoreTransport } from './endpoint';
import { MAX_DATA_CHARS } from './messages';

// the channel's decode bound: the protocol bounds strings in UTF-16 code units, and UTF-8 takes at most 3 bytes for one
export const CORE_MAX_MESSAGE_BYTES: number = 3 * MAX_DATA_CHARS;

export interface AttachedFrame {
  readonly attach: number;
  readonly envelope: unknown;
}

export function isAttachedFrame(raw: unknown): raw is AttachedFrame {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const attach = (raw as Record<string, unknown>)['attach'];
  return Object.hasOwn(raw, 'envelope') && typeof attach === 'number' && Number.isSafeInteger(attach) && attach > 0;
}

export interface AttachedTransport extends CoreTransport, Disposable {
  // sends what was posted before it, then every post at once; the client opens once attachCore answered
  open(): void;
}

/** The client's transport for attach generation `attach`: it reads only that generation's frames. */
export function attachedTransport(channel: CoreTransport, attach: number, onViolation: (reason: string) => void): AttachedTransport {
  const listeners = new Set<(raw: unknown) => void>();
  const queued: unknown[] = [];
  let opened = false;
  let disposed = false;
  const subscription = channel.onMessage((raw) => {
    if (disposed) return;
    if (!isAttachedFrame(raw)) {
      onViolation('a core channel message without its attach generation');
      return;
    }
    if (raw.attach !== attach) return;
    for (const listener of [...listeners]) listener(raw.envelope);
  });
  return {
    post: (envelope) => {
      if (disposed) return;
      if (opened) channel.post({ attach, envelope });
      else queued.push(envelope);
    },
    onMessage: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    open: () => {
      if (opened || disposed) return;
      opened = true;
      for (const envelope of queued.splice(0)) channel.post({ attach, envelope });
    },
    dispose: () => {
      disposed = true;
      queued.length = 0;
      listeners.clear();
      subscription.dispose();
    },
  };
}
