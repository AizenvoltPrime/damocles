import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnCredentialVariables } from '../../../core/scm/askpass/credential-relay';
import { createEndpoint, type CoreTransport } from '../../core-protocol/endpoint';
import { ERROR_CODEC } from '../../core-protocol/errors';
import { CLIENT_TO_WORKSPACE, WORKSPACE_TO_CLIENT, type ClientToWorkspace, type WorkspaceToClient } from '../../workspace/messages';
import { createCredentialRelay, daemonCredentialRelay } from '../serve';
import type { TerminalHub } from '../terminal-hub';
import { createWorkspaceHost, type WorkspaceModules } from '../workspace-host';

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
    hub: { detach: () => undefined } as unknown as TerminalHub,
    terminalCredentials,
    watchLimits: { roots: () => [], onReached: () => ({ dispose: () => undefined }), limit: async () => null },
  } as unknown as WorkspaceModules, () => undefined);
  const [clientEnd, hostEnd] = channel();
  const served = host.serve('test-connection', clientId, hostEnd, (reason) => { throw new Error(reason); });
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
    const daemonRelay = await createCredentialRelay('/srv/damocles');
    relays.push(daemonRelay);
    const relay = daemonCredentialRelay(daemonRelay.identity(), '/srv/damocles');
    expect(relay).toEqual({ ...daemonRelay.identity(), node: process.execPath, main: path.join('/srv/damocles', 'dist', 'askpass-main.js') });
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
