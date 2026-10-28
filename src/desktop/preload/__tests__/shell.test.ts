import { describe, expect, it, vi } from 'vitest';
import type { DamoclesShellApi } from '../shell-channels';

const H = vi.hoisted(() => ({
  exposed: undefined as DamoclesShellApi | undefined,
  invoked: [] as Array<[string, unknown]>,
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: DamoclesShellApi) => { H.exposed = api; } },
  ipcRenderer: {
    invoke: async (channel: string, payload: unknown) => {
      H.invoked.push([channel, payload]);
      return undefined;
    },
    on: () => undefined,
    send: () => undefined,
    removeListener: () => undefined,
  },
}));

describe('shell preload', () => {
  it('sends a worktree action and a folder switch as their own fields only, so a proxy or an extra key never reaches main', async () => {
    await import('../shell');
    const api = H.exposed!;
    await api.showFolder({ projectKey: 'p', show: 'project', extra: 1 } as never);
    await api.worktreeFinish({ projectKey: 'p', worktreeId: 'abcd1234', action: 'apply', extra: 1 } as never);
    expect(H.invoked.map(([, payload]) => payload)).toEqual([
      { projectKey: 'p', show: 'project' },
      { projectKey: 'p', worktreeId: 'abcd1234', action: 'apply' },
    ]);
  });

  it('sends the Projects section calls as plain copies on their own channels', async () => {
    await import('../shell');
    const api = H.exposed!;
    H.invoked.length = 0;
    await api.setProjectsView('grouped');
    await api.setProjectGroupCollapsed('ssh+h', true);
    await api.reorderProjects(['a', 'b']);
    await api.reorderProjectGroups(['ssh+h', 'local']);
    await api.openAsProject({ projectKey: 'p', relativePath: 'src/api', extra: 1 } as never);
    await api.openHostFolder('h');
    await api.renameHostOnCard('h');
    await api.openConnect();
    expect(H.invoked).toEqual([
      ['damocles:shell:projects:set-view', { view: 'grouped' }],
      ['damocles:shell:projects:set-group-collapsed', { group: 'ssh+h', collapsed: true }],
      ['damocles:shell:projects:reorder', { order: ['a', 'b'] }],
      ['damocles:shell:projects:reorder-groups', { groupOrder: ['ssh+h', 'local'] }],
      ['damocles:shell:projects:open-as-project', { projectKey: 'p', relativePath: 'src/api' }],
      ['damocles:shell:hosts:open-folder', { hostId: 'h' }],
      ['damocles:shell:hosts:rename-on-card', { hostId: 'h' }],
      ['damocles:shell:connect:open', {}],
    ]);
  });
});
