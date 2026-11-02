import { describe, expect, it, vi } from 'vitest';
import { SHELL_CHANNELS, type DamoclesShellApi } from '../shell-channels';

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

  it('sends a host card\'s anchor as a plain copy of its four fields, never the DOMRect it was given', async () => {
    await import('../shell');
    const api = H.exposed!;
    H.invoked.length = 0;
    // a DOMRect's fields are prototype getters beside top, right, bottom, left and toJSON
    class Rect {
      get x(): number { return 120; }
      get y(): number { return 6; }
      get width(): number { return 90; }
      get height(): number { return 28; }
      get top(): number { return 6; }
      get left(): number { return 120; }
      toJSON(): unknown { return {}; }
    }
    await api.showHostCard('h1', Object.assign(new Rect(), { extra: 1 }));
    expect(H.invoked).toEqual([['damocles:shell:hosts:show-card', { hostId: 'h1', anchor: { x: 120, y: 6, width: 90, height: 28 } }]]);
    const anchor = (H.invoked[0]![1] as { anchor: object }).anchor;
    expect(Object.getPrototypeOf(anchor)).toBe(Object.prototype);
    expect(Object.keys(anchor)).toEqual(['x', 'y', 'width', 'height']);
  });

  it('sends the Files transfer calls as their own fields only, on their own channels', async () => {
    await import('../shell');
    const api = H.exposed!;
    H.invoked.length = 0;
    const ref = { projectKey: 'p', relativePath: 'src', extra: 1 } as never;
    await api.copyFilesIn({ projectKey: 'p', relativeDir: 'src', paths: ['C:\\a.png'], withoutPath: 1, origin: 'drop', extra: 1 } as never);
    await api.pickFilesToCopyIn(ref);
    await api.dropFilesRow({ from: ref, toDir: ref, copy: true, extra: 1 } as never);
    await api.setFilesClipboard({ op: 'cut', ref, extra: 1 } as never);
    await api.clearFilesClipboard();
    await api.pasteFiles({ toDir: ref, extra: 1 } as never);
    await api.downloadFile(ref);
    await api.cancelFilesTransfer(7);
    const folder = { projectKey: 'p', relativePath: 'src' };
    expect(H.invoked).toEqual([
      ['damocles:shell:files:copy-in', { projectKey: 'p', relativeDir: 'src', paths: ['C:\\a.png'], withoutPath: 1, origin: 'drop' }],
      ['damocles:shell:files:pick-copy-in', folder],
      ['damocles:shell:files:drop-row', { from: folder, toDir: folder, copy: true }],
      [SHELL_CHANNELS.filesClipboardSet, { op: 'cut', ref: folder }],
      [SHELL_CHANNELS.filesClipboardClear, {}],
      ['damocles:shell:files:paste', { toDir: folder }],
      ['damocles:shell:files:download', folder],
      ['damocles:shell:files:transfer-cancel', { transferId: 7 }],
    ]);
  });
});
