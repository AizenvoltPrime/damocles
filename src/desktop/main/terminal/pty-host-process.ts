import { StringDecoder } from 'node:string_decoder';
import { app, utilityProcess, type Details } from 'electron';
import { MAX_HOST_MESSAGE_CHARS, NODE_PTY_ARG_PREFIX, type HostRequest } from '../../pty-host/protocol';
import { hostEnvironment } from '../formatting/formatter-process';
import type { PtyHostExit, PtyHostProcess } from './terminal-service';

// The name app's child-process-gone reports the host by, as Details.name.
export const PTY_HOST_SERVICE_NAME = 'Damocles Terminal';
// Electron emits child-process-gone a few ms after the utility process's exit; an abnormal exit waits this long for its reason.
export const PTY_HOST_GONE_WAIT_MS = 500;

/** Starts dist/pty-host.js as a utility process that loads node-pty from nodePty; only its messages and the tail of its stderr are read. */
export function spawnPtyHost(script: string, nodePty: string): PtyHostProcess {
  const child = utilityProcess.fork(script, [`${NODE_PTY_ARG_PREFIX}${nodePty}`], {
    env: hostEnvironment(process.env),
    serviceName: PTY_HOST_SERVICE_NAME,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const decoder = new StringDecoder('utf8');
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = (stderr + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).slice(-MAX_HOST_MESSAGE_CHARS * 2);
  });
  let fatal: string | null = null;
  child.on('error', (type, location) => {
    fatal = `${type} at ${location}`;
  });
  const lastError = (): string | null => {
    if (fatal !== null) return fatal;
    const text = stderr.trim().slice(-MAX_HOST_MESSAGE_CHARS);
    return text === '' ? null : text;
  };
  return {
    postMessage: (message: HostRequest) => child.postMessage(message),
    onMessage: (listener) => child.on('message', listener),
    onExit: (listener) => child.once('exit', (code) => {
      if (code === 0) {
        listener({ code, reason: null, error: lastError() });
        return;
      }
      const finish = (reason: Details['reason'] | null): void => {
        app.off('child-process-gone', onGone);
        clearTimeout(timer);
        const exit: PtyHostExit = { code, reason, error: lastError() };
        listener(exit);
      };
      const onGone = (_event: unknown, details: Details): void => {
        if (details.type === 'Utility' && details.name === PTY_HOST_SERVICE_NAME) finish(details.reason);
      };
      const timer = setTimeout(() => finish(null), PTY_HOST_GONE_WAIT_MS);
      app.on('child-process-gone', onGone);
    }),
    kill: () => {
      child.kill();
    },
  };
}
