import { afterEach, describe, expect, it } from 'vitest';
import { createCoreEndpoint, createLoopback, createMainEndpoint } from '../../../core-protocol';
import { CoreClient } from '../../core-client';
import { LOCAL_PROJECT_KEYS } from '../../remote/remote-project-keys';
import { terminalManagedServers } from '../terminal-managed-servers';

const GITLAB = { id: 'gitlab.com', kind: 'gitlab' as const, webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true };
const GITHUB = { id: 'github.com', kind: 'github' as const, webUrl: 'https://github.com', gitHosts: ['github.com'], hasAccount: false };
const LAST = [{ webUrl: 'https://gitlab.example', gitHosts: ['gitlab.example'] }];

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function connect(): { client: CoreClient; core: ReturnType<typeof createCoreEndpoint> } {
  const { main, core } = createLoopback();
  const mainEnd = createMainEndpoint(main, () => undefined);
  const coreEnd = createCoreEndpoint(core, () => undefined);
  const client = new CoreClient(mainEnd, (_view, attach) => attach(), LOCAL_PROJECT_KEYS);
  closers.push(() => {
    client.dispose();
    mainEnd.close('closed');
    coreEnd.close('closed');
  });
  return { client, core: coreEnd };
}

describe('the managed servers a local terminal starts with', () => {
  it('waits for a new core that has not published its forge mirror, and takes the set its read published', async () => {
    const { client, core } = connect();
    let finishRead!: () => void;
    const read = new Promise<void>((resolve) => (finishRead = resolve));
    core.serve('forge.servers', async () => {
      await read;
      // as core does: the load publishes the mirror before the read answers
      core.publish('forge', { servers: [GITLAB, GITHUB], avatarKeys: [] });
      return { servers: [GITLAB, GITHUB].map(({ id, webUrl, gitHosts, hasAccount }) => ({ id, webUrl, gitHosts, hasAccount })) };
    });
    expect(client.forgeManagedServers()).toBeUndefined();
    expect(client.forgeServers()).toBeUndefined();
    let settled: readonly unknown[] | undefined;
    const started = terminalManagedServers(client, LAST).then((servers) => (settled = servers));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBeUndefined();
    finishRead();
    await started;
    expect(settled).toEqual([{ webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'] }]);
  });

  it('reads the mirror of a core that published it, and keeps the last set while no core runs', async () => {
    const { client, core } = connect();
    core.publish('forge', { servers: [GITHUB], avatarKeys: [] });
    expect(await terminalManagedServers(client, LAST)).toEqual([]);
    expect(await terminalManagedServers(undefined, LAST)).toBe(LAST);
  });
});
