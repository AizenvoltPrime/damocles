import { describe, expect, it } from 'vitest';
import { bypassAllowed, currentPin, runPinnedTurn } from '../../../core/client-snapshots';
import type { RemoteHost } from '../../../platform/remote-host';
import type { ClientPolicy, ClientUser } from '../../../shared/remote-user';
import { createCoreEndpoint, createLoopback, createMainEndpoint } from '../../core-protocol';
import { processActor } from '../../core-protocol/actor';
import type { CoreInit } from '../../core-protocol/messages';
import { createClientSnapshots } from '../platform/clients';

const quiet = (): void => undefined;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const user = (deny: string[]): ClientUser => ({ settings: {}, permissionRules: [{ allow: [], ask: [], deny, dir: '.damocles' }] });
const policy = (allowBypass: boolean): ClientPolicy => ({ voice: true, allowBypass });

// a daemon's core with devices a and b attached; the daemon's mirror names b as the client that sent core a message last
function setUp() {
  const loop = createLoopback();
  const daemon = createMainEndpoint(loop.main, quiet);
  const core = createCoreEndpoint(loop.core, quiet);
  const auth = { providers: { anthropic: { type: 'oauth' as const, expiresIn: 60_000, hasKey: false, flatFee: false } } };
  const clients = createClientSnapshots(core, {
    mirrors: {
      clientAuth: { 'client-a': auth, 'client-b': auth },
      clientUser: { 'client-a': user([]), 'client-b': user(['Bash(git push)']) },
      clientPolicy: { 'client-a': policy(true), 'client-b': policy(false) },
      actingClient: { clientId: 'client-b' },
    },
  } as unknown as CoreInit);
  const remote = { hostId: 'h', clients } as unknown as RemoteHost;
  return { daemon, clients, remote };
}

describe('the acting client of a daemon\'s core', () => {
  it('is the device whose request or panel message the work came from, else the one that sent core a message last', () => {
    const { clients } = setUp();
    expect(clients.actor()).toBeUndefined();
    expect(clients.acting()).toBe('client-b');
    expect(processActor.run('client-a', () => [clients.actor(), clients.acting()])).toEqual(['client-a', 'client-a']);
  });

  it('is not a detached device that work made inside its request still names, such as a timer that outlived its connection', async () => {
    const { daemon, clients } = setUp();
    daemon.publish('clientAuth', { clientId: 'client-a' });
    await flush();
    expect(processActor.run('client-a', () => [clients.actor(), clients.acting()])).toEqual(['client-a', 'client-b']);
  });

  it('a turn pins the device whose view sent its prompt: a deny rule only on another device never changes it, and policy checks use the issuing device\'s', async () => {
    const { remote } = setUp();
    const turn = processActor.run('client-a', () => runPinnedTurn(remote, 'panel-1', async () => {
      await Promise.resolve();
      // device b sends a message mid-turn
      return processActor.run('client-b', () => ({ rules: currentPin(remote).user?.permissionRules, bypass: bypassAllowed({ remote }) }));
    }));
    expect(await turn).toEqual({ rules: user([]).permissionRules, bypass: true });
    expect(processActor.run('client-b', () => bypassAllowed({ remote }))).toBe(false);
    expect(processActor.run('client-a', () => bypassAllowed({ remote }))).toBe(true);
  });

  it('knows which devices are attached: a detach keeps the device\'s last clientAuth for its pinned turns, a reattach under the same id is attached again', async () => {
    const { daemon, clients } = setUp();
    expect(clients.attached('client-a')).toBe(true);
    daemon.publish('clientAuth', { clientId: 'client-a' });
    await flush();
    expect(clients.attached('client-a')).toBe(false);
    expect(clients.auth('client-a')?.providers['anthropic']?.type).toBe('oauth');
    daemon.publish('clientAuth', { clientId: 'client-a', value: { providers: {} } });
    await flush();
    expect(clients.attached('client-a')).toBe(true);
  });
});
