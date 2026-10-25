// A host process's channel to the process that started it, whether Electron's utility process fork or Node's child_process.fork.

/** Electron's process.parentPort in a utility process; typed here, since the hosts never import electron. */
export interface ParentPort {
  on(event: 'message', listener: (event: { readonly data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
}

export interface ParentChannel extends ParentPort {
  // the IPC channel of a forked child closed; a utility process ends with its parent instead, so it never fires there
  onDisconnect(listener: () => void): void;
}

type HostProcess = Pick<NodeJS.Process, 'send' | 'connected' | 'on' | 'env'> & { readonly parentPort?: ParentPort };

/**
 * The parent's channel: process.parentPort in a utility process, else Node's IPC channel of a forked child with each message
 * as `{ data }`, else undefined. A forked child drops ELECTRON_RUN_AS_NODE, so nothing it starts inherits it.
 */
export function parentChannel(host: HostProcess = process as HostProcess): ParentChannel | undefined {
  const port = host.parentPort;
  if (port) return { on: (event, listener) => port.on(event, listener), postMessage: (message) => port.postMessage(message), onDisconnect: () => undefined };
  const send = host.send?.bind(host);
  if (!send) return undefined;
  delete host.env['ELECTRON_RUN_AS_NODE'];
  return {
    on: (_event, listener) => host.on('message', (data: unknown) => listener({ data })),
    // a post after the parent went away has nobody to reach; the disconnect ends the process
    postMessage: (message) => {
      if (host.connected) send(message);
    },
    onDisconnect: (listener) => {
      host.on('disconnect', listener);
    },
  };
}
