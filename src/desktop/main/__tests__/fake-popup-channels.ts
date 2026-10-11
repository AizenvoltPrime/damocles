import type { PopupAnswer } from '../../preload/overlay-channels';

type Handlers = Map<string, (...args: unknown[]) => unknown>;

/** A fake overlay's handleWhileOpen: answers as OverlayHost.handleWhileOpen does, into the fake's handler map. */
export function fakeHandleWhileOpen(handlers: Handlers) {
  return <T>(channel: string, isOpen: () => boolean, handler: (...args: unknown[]) => T | Promise<T>): void => {
    handlers.set(channel, async (...args: unknown[]): Promise<PopupAnswer<T>> => (isOpen() ? { ok: true, value: await handler(...args) } : { ok: false, reason: 'closed' }));
  };
}
