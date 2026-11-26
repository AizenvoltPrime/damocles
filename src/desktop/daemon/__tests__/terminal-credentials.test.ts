import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL } from '../../../remote/mux';
import { spawnCredentialVariables } from '../../../core/scm/askpass/credential-relay';
import { createEndpoint, type CoreTransport } from '../../core-protocol/endpoint';
import { ERROR_CODEC } from '../../core-protocol/errors';
import { CLIENT_TO_WORKSPACE, WORKSPACE_TO_CLIENT, type ClientToWorkspace, type WorkspaceToClient } from '../../workspace/messages';
import { CLI_HOOK_ENV } from '../../workspace/terminal/terminal-env';
import { activeLinkPath } from '../active-link';
import type { CoreAttach } from '../control-messages';
import type { ForkedChild } from '../process-starts';
import { createCredentialRelay, daemonCredentialRelay, type DaemonStarters } from '../serve';
import type { TerminalHub } from '../terminal-hub';
import { localRunPaths } from '../token';
import { createWorkspaceHost, type WorkspaceModules } from '../workspace-host';
import { startInProcessDaemon, startTestHost, type InProcessDaemon, type TestHost } from './in-process-daemon';
import { connectClient, type TestClient } from './test-client';

// Two ends of an in-memory channel; each message arrives on a later task, structured-cloned as the wire copies it.
function channel(): readonly [CoreTransport, CoreTransport] {
  const listeners = [new Set<(raw: unknown) => void>(), new Set<(raw: unknown) => void>()] as const;
  const end = (own: 0 | 1): CoreTransport => ({
    post: (message) => {
      const copy = structuredClone(message);
      setImmediate(() => listeners[own === 0 ? 1 : 0].forEach((listener) => listener(copy)));
    },
    onMessage: (listener) => {
      listeners[own].add(listener);
      return { dispose: () => listeners[own].delete(listener) };
    },
  });
  return [end(0), end(1)];
}

// A new terminal's environment as clientId's connection to the daemon's workspace host asks for it.
async function terminalEnvironment(
  base: Readonly<Record<string, string>>,
  clientId: string,
  terminalCredentials: WorkspaceModules['terminalCredentials'],
): Promise<Readonly<Record<string, string>>> {
  const unused = new Proxy({}, { get: (_target, key) => { throw new Error(`the test workspace host has no ${String(key)}`); } });
  const host = createWorkspaceHost({
    files: unused,
    tree: unused,
    search: unused,
    quickOpen: unused,
    format: unused,
    terminals: { ...(unused as WorkspaceModules['terminals']), environment: async () => base },
    hub: { detach: () => undefined, onResponding: () => ({ dispose: () => undefined }) } as unknown as TerminalHub,
    terminalCredentials,
    cli: { connected: () => ({ dispose: () => undefined }) },
    watchLimits: { roots: () => [], onReached: () => ({ dispose: () => undefined }), limit: async () => null },
  } as unknown as WorkspaceModules, () => undefined);
  const [clientEnd, hostEnd] = channel();
  const served = host.serve('test-connection', clientId, hostEnd, (reason) => { throw new Error(reason); }, () => undefined, () => false, () => new Set());
  const endpoint = createEndpoint<ClientToWorkspace, WorkspaceToClient>({ transport: clientEnd, outgoing: CLIENT_TO_WORKSPACE, incoming: WORKSPACE_TO_CLIENT, log: () => undefined, errors: ERROR_CODEC });
  try {
    return await endpoint.request('terminals.environment', { locale: 'en-US' });
  } finally {
    endpoint.close('done');
    served.dispose();
  }
}

describe('a daemon terminal\'s environment', () => {
  const relays: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    for (const relay of relays.splice(0)) await relay.close();
  });

  it('has the daemon\'s relay from its start, before any core listens, with the pair after the inherited ones and the agent socket, never a prompt capability', async () => {
    const root = path.join(path.sep, 'srv', 'damocles', '3.8.0-linux-x64');
    const active = path.join(path.sep, 'home', 'ada', '.damocles', 'server', 'run-1', 'active');
    const daemonRelay = await createCredentialRelay(root);
    relays.push(daemonRelay);
    const relay = daemonCredentialRelay(daemonRelay.identity(), root, active);
    // each path of the package through the active link; Node from outside the package as it is
    expect(relay).toEqual({ ...daemonRelay.identity(), helper: path.join(active, path.relative(root, daemonRelay.identity().helper)), node: process.execPath, main: path.join(active, 'dist', 'askpass-main.js') });
    expect(daemonCredentialRelay(daemonRelay.identity(), path.dirname(process.execPath), active).node).toBe(path.join(active, path.basename(process.execPath)));
    const env = await terminalEnvironment(
      { PATH: '/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Ada' },
      'test-client',
      (base) => spawnCredentialVariables(base, relay, { socket: '/run/user/1000/damocles-x/agent-1.sock' }),
    );
    expect(env).toEqual({
      PATH: '/bin',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Ada',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: `!'${relay.helper}'`,
      DAMOCLES_ASKPASS_NODE: relay.node,
      DAMOCLES_ASKPASS_MAIN: relay.main,
      DAMOCLES_ASKPASS_HANDLE: relay.handle,
      DAMOCLES_CREDENTIAL_NONCE: relay.nonce,
      SSH_AUTH_SOCK: '/run/user/1000/damocles-x/agent-1.sock',
    });
  });

  it('gets the agent socket of the client that asked for it, and none inherited when that client does not forward', async () => {
    const base = { PATH: '/bin', SSH_AUTH_SOCK: '/tmp/ssh-started-the-daemon/agent.1' };
    const sockets = new Map([['laptop', '/run/user/1000/damocles-x/agent-laptop.sock']]);
    const credentials: WorkspaceModules['terminalCredentials'] = (env, asking) => spawnCredentialVariables(env, undefined, { socket: sockets.get(asking) });
    expect(await terminalEnvironment(base, 'laptop', credentials)).toEqual({ PATH: '/bin', SSH_AUTH_SOCK: '/run/user/1000/damocles-x/agent-laptop.sock' });
    expect(await terminalEnvironment(base, 'desktop', credentials)).toEqual({ PATH: '/bin' });
  });
});

describe('a daemon terminal as its terminal host starts it', { timeout: 60_000 }, () => {
  const SPAWN = { type: 'spawn', id: 'term-1', file: '/bin/sh', args: [], cwd: '/', cols: 80, rows: 24, scrollback: 1000 } as const;
  const CORE_ATTACH: CoreAttach = {
    attach: 1,
    hostId: 'client-host',
    appInfo: { version: '0.0.0-test', host: 'desktop' },
    secretsPersistent: true,
    chatBrowserPane: true,
    mirrors: { trust: { keys: [] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'en' }, clientAuth: { providers: {} }, clientUser: { settings: {}, permissionRules: [] }, clientPolicy: { voice: false, allowBypass: false } },
  };
  const NO_FORMATTER: DaemonStarters = { startFormatterHost: () => { throw new Error('no formatter host in this test'); } };
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  // A Damocles Core that reports itself running once it has its init and answers core.shutdown; the test listens at the relay.
  const runningCore = (): ForkedChild => {
    let receive: (message: unknown) => void = () => undefined;
    let exit: (end: { code: number; signal: string | null; error: string | null }) => void = () => undefined;
    let started = false;
    return {
      pid: 4244,
      postMessage: (message) => {
        const envelope = message as { kind?: string; id?: number; method?: string };
        if (!started) {
          started = true;
          setImmediate(() => receive({ kind: 'mirror', topic: 'folderTargets', version: 1, patch: { defaultKey: '/srv/app', targets: [] } }));
        }
        if (envelope.kind === 'request' && envelope.method === 'core.shutdown') receive({ kind: 'response', id: envelope.id, ok: true, result: undefined });
      },
      onMessage: (listener) => { receive = listener; },
      onExit: (listener) => { exit = listener; },
      kill: () => exit({ code: 0, signal: null, error: null }),
    };
  };

  // an in-process daemon with its relay, whose terminal host runs in this process, and a client of it
  async function daemonWithHost(): Promise<{ daemon: InProcessDaemon; client: TestClient; host: () => TestHost | undefined }> {
    let host: TestHost | undefined;
    const daemon = await startInProcessDaemon({
      starters: NO_FORMATTER,
      credentialRelay: true,
      forkCore: runningCore,
      startTerminalHost: async () => {
        host = await startTestHost(await localRunPaths());
        return host.pid;
      },
    });
    cleanups.push(async () => {
      await daemon.shutdown();
      if (host && !host.hasExited()) await host.stop();
    });
    const client = await connectClient(await daemon.connect());
    return { daemon, client, host: () => host };
  }

  it('names the host\'s own CLI socket and credential relay with the host\'s nonce, and the package\'s paths through the active link', async () => {
    const { daemon, client, host } = await daemonWithHost();
    const active = activeLinkPath(daemon.paths.runDir);
    const identity = daemon.relay!.identity();
    const env = await client.workspace.request('terminals.environment', { locale: 'en-US' });
    // what the daemon names, which the host replaces
    expect(env['DAMOCLES_ASKPASS_HANDLE']).toBe(identity.handle);
    expect(env['DAMOCLES_CREDENTIAL_NONCE']).toBe(identity.nonce);
    client.workspace.emit('terminals.post', { request: { ...SPAWN, env } });
    const shell = await vi.waitFor(() => {
      const started = host()?.ptys[0]?.env;
      expect(started).toBeDefined();
      return started!;
    });
    const windows = process.platform === 'win32';
    const relayHandle = shell['DAMOCLES_ASKPASS_HANDLE']!;
    expect(relayHandle).not.toBe(identity.handle);
    expect(relayHandle).toMatch(windows ? /^\\\\\.\\pipe\\damocles-relay-[0-9a-f]{32}$/ : /[\\/]askpass-[0-9a-f]{24}\.sock$/);
    expect(shell['DAMOCLES_CREDENTIAL_NONCE']).toMatch(/^[0-9a-f]{64}$/);
    expect(shell['DAMOCLES_CREDENTIAL_NONCE']).not.toBe(identity.nonce);
    expect(shell[CLI_HOOK_ENV]).toMatch(windows ? /^\\\\\.\\pipe\\damocles-cli-[0-9a-f]{32}$/ : /[\\/]cli-[0-9a-f]{24}\.sock$/);
    expect(shell['DAMOCLES_ASKPASS_MAIN']).toBe(path.join(active, 'dist', 'askpass-main.js'));
    // a checkout daemon's Node is no file of its package
    expect(shell['DAMOCLES_ASKPASS_NODE']).toBe(process.execPath);
    const helper = Object.entries(shell).find(([key, value]) => key.startsWith('GIT_CONFIG_VALUE_') && value.startsWith('!'))?.[1];
    expect(helper).toBe(`!'${path.join(active, 'dist', 'git-credential', windows ? 'git-credential-relay.cmd' : 'git-credential-relay.sh')}'`);
    expect(shell['BROWSER']).toBe(path.join(active, 'dist', 'server-bin', 'helpers', windows ? 'browser.exe' : 'browser.sh'));
    expect(Object.entries(shell).find(([key]) => key.toUpperCase() === 'PATH')?.[1]?.split(path.delimiter)[0]).toBe(path.join(active, 'dist', 'server-bin', 'remote-cli'));

    // a helper's request on the host's relay reaches the daemon's relay handle, where core listens, with the host's nonce; it
    // waits for core to run, which the client's attach starts; what core sends the client goes unread
    client.mux.messageChannel(CHANNEL.core, 64 * 1024 * 1024);
    await client.control.request('attachCore', CORE_ATTACH);
    const request = `${JSON.stringify({ nonce: shell['DAMOCLES_CREDENTIAL_NONCE'], kind: 'credential', op: 'get', cwd: '/', fields: { protocol: 'https', host: 'example.com' } })}\n`;
    const core = net.createServer((socket) => socket.once('data', (chunk: Buffer) => {
      received.push(chunk.toString('utf8'));
      socket.end('{"kind":"none"}\n');
    }));
    const received: string[] = [];
    const answer = new Promise<string>((resolve, reject) => {
      const helper = net.connect(relayHandle, () => helper.write(request));
      let text = '';
      helper.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
      helper.on('error', reject);
      helper.on('close', () => resolve(text));
    });
    // core's relay listens a moment after core runs, and the request finds it then
    await new Promise((resolve) => setTimeout(resolve, 500));
    await new Promise<void>((resolve) => core.listen(identity.handle, resolve));
    cleanups.push(() => new Promise<void>((resolve) => core.close(() => resolve())));
    expect(await answer).toBe('{"kind":"none"}\n');
    expect(received).toEqual([request]);
  });
});
