import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RelocationView } from '../../../../core/project-relocation/types';
import { createCoreEndpoint, createLoopback, createMainEndpoint } from '../../../core-protocol';
import { CoreClient } from '../../core-client';
import { authorityProjectKeys, LOCAL_PROJECT_KEYS } from '../remote-project-keys';

const view: RelocationView = {
  id: 'r1', seq: 1, requestedBy: 'daemon', mode: 'locate', from: '/srv/old', to: '/srv/new', state: 'running', step: 'sessions', progress: { done: 0, total: 1 }, chats: 1,
};

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function connect(relocates: boolean | undefined, abandons?: boolean) {
  const { main, core } = createLoopback();
  const mainEnd = createMainEndpoint(main, () => undefined);
  const coreEnd = createCoreEndpoint(core, () => undefined);
  const keys = authorityProjectKeys('ssh+prod', () => undefined);
  const client = relocates === undefined ? new CoreClient(mainEnd, (_view, attach) => attach(), keys) : new CoreClient(mainEnd, (_view, attach) => attach(), keys, relocates, abandons);
  const asked = vi.fn();
  coreEnd.serve('projects.relocationPreflight', (request) => { asked('projects.relocationPreflight', request); return { ok: false as const, refusal: { code: 'fromExists' } }; });
  coreEnd.serve('projects.relocate', (request) => { asked('projects.relocate', request); return { id: 'r1' }; });
  coreEnd.serve('projects.relocationRetry', (request) => { asked('projects.relocationRetry', request); });
  coreEnd.serve('projects.relocationAbandon', (request) => { asked('projects.relocationAbandon', request); return request.id === 'r1' ? { abandoned: true as const } : { refusal: { code: 'notPaused' } }; });
  coreEnd.serve('projects.relocationsFrom', (request) => { asked('projects.relocationsFrom', request); return [view]; });
  coreEnd.serve('projects.applyHostState', (request) => { asked('projects.applyHostState', request); });
  coreEnd.serve('projects.movedFrom', (request) => { asked('projects.movedFrom', request); return []; });
  closers.push(() => {
    client.dispose();
    mainEnd.close('closed');
    coreEnd.close('closed');
  });
  return { client, core: coreEnd, asked };
}

const request = { from: '/srv/old', to: '/srv/new', listed: ['/srv/old'] };

describe('the relocation contract of a daemon\'s core', () => {
  it('sends none of the relocation requests and reads no relocations mirror unless the daemon listed projects.relocate', async () => {
    for (const relocates of [false, undefined]) {
      const { client, core, asked } = connect(relocates);
      const changed = vi.fn();
      client.onRelocationsChanged(changed);
      const calls = [
        client.relocationPreflight(request),
        client.relocate(request),
        client.relocationRetry('r1'),
        client.relocationsFrom(['ssh+prod|/srv/old']),
        client.applyRelocationHostState('r1'),
        client.movedFrom('/srv/new'),
      ];
      for (const call of calls) await expect(call).rejects.toThrow('does not move project folders');
      core.publish('relocations', { records: [view] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(asked).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(client.relocates).toBe(false);
      expect(client.relocations()).toEqual([]);
    }
  });

  it('sends them to a daemon that listed it, naming its projects by the target\'s folder keys, and reads its relocations mirror', async () => {
    const { client, core, asked } = connect(true);
    const changed = vi.fn();
    client.onRelocationsChanged(changed);
    expect(await client.relocationsFrom(['ssh+prod|/srv/old'])).toEqual([view]);
    expect(asked).toHaveBeenCalledWith('projects.relocationsFrom', { keys: ['/srv/old'] });
    expect(await client.relocate(request)).toEqual({ id: 'r1' });
    core.publish('relocations', { records: [view] });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(client.relocations()).toEqual([view]);
  });

  it('sends Stop moving only to a daemon that listed projects.relocationAbandon beside projects.relocate, and answers its refusal', async () => {
    for (const [relocates, abandons] of [[true, false], [true, undefined], [false, true]] as const) {
      const { client, asked } = connect(relocates, abandons);
      expect(client.abandons).toBe(false);
      await expect(client.relocationAbandon('r1')).rejects.toThrow('does not stop moving project folders');
      expect(asked).not.toHaveBeenCalled();
    }
    const { client, asked } = connect(true, true);
    expect(await client.relocationAbandon('r1')).toBeUndefined();
    expect(asked).toHaveBeenCalledWith('projects.relocationAbandon', { id: 'r1' });
    expect(await client.relocationAbandon('r2')).toEqual({ code: 'notPaused' });
  });

  it('is served by this computer\'s core without a feature', () => {
    const { main } = createLoopback();
    const mainEnd = createMainEndpoint(main, () => undefined);
    const client = new CoreClient(mainEnd, (_view, attach) => attach(), LOCAL_PROJECT_KEYS);
    closers.push(() => {
      client.dispose();
      mainEnd.close('closed');
    });
    expect(client.relocates).toBe(true);
    expect(client.abandons).toBe(true);
  });
});
