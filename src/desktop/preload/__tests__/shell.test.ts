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
});
