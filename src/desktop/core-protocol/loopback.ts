import type { Disposable } from '../../platform/disposable';
import type { CoreTransport } from './endpoint';

/**
 * The in-process transport: every message is structured-cloned, so a value that could not cross to the utility process fails
 * here too. Delivery is synchronous, so in process each call reaches the other side on the caller's stack, as the direct
 * calls it replaces did; a utility process's channel delivers asynchronously in the same order.
 */
export function createLoopback(): { readonly main: CoreTransport; readonly core: CoreTransport } {
  const listeners = { main: new Set<(raw: unknown) => void>(), core: new Set<(raw: unknown) => void>() };
  const end = (self: keyof typeof listeners, other: keyof typeof listeners): CoreTransport => ({
    post: (message) => {
      const copy = structuredClone(message);
      const targets = [...listeners[other]];
      if (targets.length === 0) throw new Error(`Nothing listens on the ${other} side of the core channel`);
      for (const listener of targets) listener(copy);
    },
    onMessage: (listener): Disposable => {
      listeners[self].add(listener);
      return { dispose: () => { listeners[self].delete(listener); } };
    },
  });
  return { main: end('main', 'core'), core: end('core', 'main') };
}
