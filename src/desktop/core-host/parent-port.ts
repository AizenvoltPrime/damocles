import type { Disposable } from '../../platform/disposable';
import type { CoreTransport } from '../core-protocol';
import type { ParentPort } from '../local-services/parent-channel';

export interface ParentPortTransport extends CoreTransport {
  // main's first message on the channel: the init handshake
  readonly init: Promise<unknown>;
  // Delivers what arrived since the init, in order, then each message as it arrives; core opens once its services serve.
  open(): void;
}

/**
 * The core side of the one ordered channel to main. Listening starts at once, so nothing main posts before core's services
 * exist is lost; it is held until open().
 */
export function createParentPortTransport(port: ParentPort): ParentPortTransport {
  const listeners = new Set<(raw: unknown) => void>();
  const held: unknown[] = [];
  let opened = false;
  let resolveInit!: (raw: unknown) => void;
  let initReceived = false;
  const init = new Promise<unknown>((resolve) => {
    resolveInit = resolve;
  });
  const deliver = (raw: unknown): void => {
    for (const listener of [...listeners]) listener(raw);
  };
  port.on('message', ({ data }) => {
    if (!initReceived) {
      initReceived = true;
      resolveInit(data);
      return;
    }
    if (opened) deliver(data);
    else held.push(data);
  });
  return {
    init,
    post: (message) => port.postMessage(message),
    onMessage: (listener): Disposable => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    open: () => {
      if (opened) return;
      opened = true;
      for (const raw of held.splice(0)) deliver(raw);
    },
  };
}
