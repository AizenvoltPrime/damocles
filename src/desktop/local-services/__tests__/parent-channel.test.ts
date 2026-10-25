import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { parentChannel, type ParentPort } from '../parent-channel';

type Listener = (...args: unknown[]) => void;

function fakeForkedProcess(connected = true) {
  const listeners = new Map<string, Listener[]>();
  const sent: unknown[] = [];
  const host = {
    env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' } as NodeJS.ProcessEnv,
    connected,
    send: vi.fn((message: unknown) => {
      sent.push(message);
      return true;
    }),
    on: (event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return host;
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
  return { host, sent };
}

describe('parentChannel', () => {
  it('is the utility process parentPort when there is one', () => {
    const received: unknown[] = [];
    const posted: unknown[] = [];
    const port: ParentPort & { deliver(data: unknown): void } = {
      on: (_event, listener) => {
        port.deliver = (data) => listener({ data });
      },
      postMessage: (message) => posted.push(message),
      deliver: () => undefined,
    };
    const channel = parentChannel({ parentPort: port, env: {}, on: () => process, connected: false } as never)!;
    channel.on('message', ({ data }) => received.push(data));
    port.deliver({ kind: 'init' });
    channel.postMessage({ kind: 'reply' });
    expect(received).toEqual([{ kind: 'init' }]);
    expect(posted).toEqual([{ kind: 'reply' }]);
  });

  it('wraps a forked child\'s IPC messages as { data }, drops ELECTRON_RUN_AS_NODE, and reports the disconnect', () => {
    const { host, sent } = fakeForkedProcess();
    const channel = parentChannel(host as never)!;
    expect(host.env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(host.env['PATH']).toBe('/bin');
    const received: unknown[] = [];
    channel.on('message', (event) => received.push(event));
    host.emit('message', { kind: 'init', bytes: new Uint8Array([1]) });
    expect(received).toEqual([{ data: { kind: 'init', bytes: new Uint8Array([1]) } }]);
    channel.postMessage({ kind: 'reply' });
    expect(sent).toEqual([{ kind: 'reply' }]);
    let disconnected = 0;
    channel.onDisconnect(() => disconnected++);
    host.connected = false;
    host.emit('disconnect');
    expect(disconnected).toBe(1);
    // a post after the parent went away reaches nobody and throws nothing
    channel.postMessage({ kind: 'late' });
    expect(sent).toEqual([{ kind: 'reply' }]);
  });

  it('is undefined for a process nobody started with a channel', () => {
    expect(parentChannel({ env: {}, on: () => process, connected: false } as never)).toBeUndefined();
  });
});

describe('a forked child', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-parent-channel-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reaches its parent through parentChannel() and exits once the IPC channel disconnects', async () => {
    const entry = path.join(dir, 'child.ts');
    fs.writeFileSync(entry, [
      `import { parentChannel } from ${JSON.stringify(path.resolve(__dirname, '../parent-channel.ts'))};`,
      'const channel = parentChannel();',
      'if (!channel) process.exit(2);',
      'channel.onDisconnect(() => process.exit(7));',
      'channel.on("message", ({ data }) => channel.postMessage({ echo: data, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }));',
    ].join('\n'));
    const bundle = path.join(dir, 'child.js');
    buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
    const child = fork(bundle, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, serialization: 'advanced', stdio: 'ignore' });
    const reply = once(child, 'message');
    child.send({ ping: new Uint8Array([7, 8]) });
    expect((await reply)[0]).toEqual({ echo: { ping: new Uint8Array([7, 8]) }, runAsNode: null });
    const exited = once(child, 'exit');
    child.disconnect();
    expect((await exited)[0]).toBe(7);
  });
});
