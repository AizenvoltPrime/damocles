import { describe, expect, it, vi } from 'vitest';
import { FORGE_CHANNELS, type CiChanged, type ForgeChanged } from '../../../preload/forge-channels';
import { OVERLAY_CHANNELS } from '../../../preload/overlay-channels';
import { registerForgeOverlayChannels, type ForgeOverlayActions } from '../forge-overlay-channels';

function setUp(open: { readonly settings?: boolean; readonly pipeline?: string; readonly clone?: { readonly recursive: boolean }; readonly publish?: string; readonly fork?: string; readonly protectedBranch?: string } = { settings: true }) {
  const handlers = new Map<string, (raw: unknown) => unknown>();
  let listener: ((changed: ForgeChanged) => void) | undefined;
  let ciListener: ((changed: CiChanged) => void) | undefined;
  const overlay = {
    handleWhileOpen: vi.fn((channel: string, isOpen: () => boolean, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, (raw) => (isOpen() ? handler(raw) : 'closed'));
    }),
    isOpen: vi.fn((kind: 'settings' | 'pipeline' | 'cloneFromAccount' | 'forgePublish' | 'forgeFork' | 'forgeProtectedBranch') => {
      if (kind === 'forgeProtectedBranch') return open.protectedBranch !== undefined;
      if (kind === 'forgePublish') return open.publish !== undefined;
      if (kind === 'forgeFork') return open.fork !== undefined;
      return kind === 'settings' ? open.settings === true : kind === 'pipeline' ? open.pipeline !== undefined : open.clone !== undefined;
    }),
    openRequestOf: vi.fn(((kind: 'pipeline' | 'cloneFromAccount' | 'forgePublish' | 'forgeFork' | 'forgeProtectedBranch') => {
      if (kind === 'forgeProtectedBranch') return open.protectedBranch !== undefined ? { kind, dialog: { requestId: open.protectedBranch } } : undefined;
      if (kind === 'forgePublish') return open.publish !== undefined ? { kind, dialog: { requestId: open.publish } } : undefined;
      if (kind === 'forgeFork') return open.fork !== undefined ? { kind, dialog: { requestId: open.fork } } : undefined;
      if (kind === 'cloneFromAccount') return open.clone ? { kind, recursive: open.clone.recursive } : undefined;
      return open.pipeline !== undefined ? { kind, repoId: open.pipeline, anchor: { x: 0, y: 0, width: 10, height: 10 } } : undefined;
    }) as Parameters<typeof registerForgeOverlayChannels>[0]['openRequestOf']),
    send: vi.fn(),
  };
  const actions: ForgeOverlayActions = {
    hostDefaults: vi.fn(async () => ({ state: 'loading' as const })),
    setHostDefault: vi.fn(async () => true),
    openAccounts: vi.fn(async () => undefined),
    onChanged: vi.fn((next) => {
      listener = next;
      return () => undefined;
    }),
    pipeline: vi.fn(async () => ({ status: 'none' as const })),
    jobAction: vi.fn(async () => true),
    jobLogOpen: vi.fn(async () => undefined),
    openOnServer: vi.fn(async () => 'gitlab.indigital.gr'),
    onCiChanged: vi.fn((next) => {
      ciListener = next;
      return () => undefined;
    }),
    cloneAccounts: vi.fn(async () => ({ empty: 'noAccount' as const })),
    cloneSearch: vi.fn(async (_picker: unknown, accountId: string, _query: string, requestId: number) => ({ requestId, accountId, rows: [] })),
    clonePaste: vi.fn(async () => ({ row: null })),
    cloneStart: vi.fn(async () => ({ kind: 'started' as const })),
    publishSubmit: vi.fn(() => 'started' as const),
    forkStart: vi.fn(() => 'ignored' as const),
    publishOwners: vi.fn(async () => ({ status: 'cancelled' as const })),
    protectedCheckName: vi.fn(async (_requestId: string, name: string) => ({ name })),
    protectedPush: vi.fn(() => 'started' as const),
  };
  registerForgeOverlayChannels(overlay, actions);
  return {
    call: (channel: string, raw: unknown) => handlers.get(channel)!(raw),
    overlay,
    actions,
    changed: (changed: ForgeChanged) => listener!(changed),
    ciChanged: (changed: CiChanged) => ciListener!(changed),
  };
}

describe('the settings modal\'s forge channels', () => {
  it('pass a well-formed call to the forge host and answer only while the settings modal is open', async () => {
    const { call, actions } = setUp();
    await call(FORGE_CHANNELS.hostDefaults, { authorityKey: 'ssh+h1' });
    expect(actions.hostDefaults).toHaveBeenCalledWith('ssh+h1');
    await call(FORGE_CHANNELS.setHostDefault, { authorityKey: 'ssh+h1', serverId: 'gitlab.com', accountId: null });
    expect(actions.setHostDefault).toHaveBeenCalledWith('ssh+h1', 'gitlab.com', null);
    await call(FORGE_CHANNELS.openAccounts, { serverId: 'gitlab.com', signIn: true });
    expect(actions.openAccounts).toHaveBeenCalledWith({ serverId: 'gitlab.com', signIn: true });
    expect(setUp({}).call(FORGE_CHANNELS.hostDefaults, { authorityKey: 'ssh+h1' })).toBe('closed');
  });

  it('refuses a malformed call', () => {
    const { call } = setUp();
    expect(() => call(FORGE_CHANNELS.hostDefaults, { authorityKey: '' })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.hostDefaults, { authorityKey: 'ssh+h1', extra: 1 })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.setHostDefault, { authorityKey: 'ssh+h1', serverId: 'gitlab.com', accountId: 7 })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.openAccounts, { signIn: false })).toThrow(/Malformed/);
  });

  it('forwards the forge host\'s changes to the page', () => {
    const { overlay, changed } = setUp();
    changed({ projectKeys: ['C:/work/damocles'] });
    expect(overlay.send).toHaveBeenCalledWith(OVERLAY_CHANNELS.forgeChanged, { projectKeys: ['C:/work/damocles'] });
  });
});

describe('the job list\'s forge channels', () => {
  it('answer only while a job list of the call\'s repository is open', async () => {
    const { call, actions } = setUp({ pipeline: 'repo-1' });
    await call(FORGE_CHANNELS.ciStatus, { repoId: 'repo-1' });
    expect(actions.pipeline).toHaveBeenCalledWith('repo-1');
    await call(FORGE_CHANNELS.jobAction, { repoId: 'repo-1', target: { jobId: 9102 }, action: 'retry' });
    expect(actions.jobAction).toHaveBeenCalledWith('repo-1', { jobId: 9102 }, 'retry');
    await call(FORGE_CHANNELS.jobAction, { repoId: 'repo-1', target: { pipelineId: 4312 }, action: 'cancel' });
    expect(actions.jobAction).toHaveBeenCalledWith('repo-1', { pipelineId: 4312 }, 'cancel');
    await call(FORGE_CHANNELS.jobLogOpen, { repoId: 'repo-1', jobId: 9101 });
    expect(actions.jobLogOpen).toHaveBeenCalledWith('repo-1', 9101);
    expect(await call(FORGE_CHANNELS.openOnServer, { repoId: 'repo-1', target: { pipelineId: 4312 } })).toBe('gitlab.indigital.gr');
    expect(() => call(FORGE_CHANNELS.ciStatus, { repoId: 'repo-2' })).toThrow(/does not show/);
    expect(setUp({ settings: true }).call(FORGE_CHANNELS.jobAction, { repoId: 'repo-1', target: { jobId: 1 }, action: 'retry' })).toBe('closed');
  });

  it('refuses a malformed call', () => {
    const { call } = setUp({ pipeline: 'repo-1' });
    expect(() => call(FORGE_CHANNELS.jobAction, { repoId: 'repo-1', target: { jobId: 0 }, action: 'retry' })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.jobAction, { repoId: 'repo-1', target: { jobId: 1, pipelineId: 2 }, action: 'retry' })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.jobAction, { repoId: 'repo-1', target: { jobId: 1 }, action: 'play' })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.jobLogOpen, { repoId: 'repo-1', jobId: 1.5 })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.openOnServer, { repoId: 'repo-1', target: { url: 'https://evil.test' } })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.ciStatus, { repoId: 'repo-1', extra: true })).toThrow(/Malformed/);
  });

  it('pushes the open job list\'s repository\'s changes only', () => {
    const { overlay, ciChanged } = setUp({ pipeline: 'repo-1' });
    ciChanged({ repoId: 'repo-2', status: { status: 'none' } });
    expect(overlay.send).not.toHaveBeenCalled();
    ciChanged({ repoId: 'repo-1', status: { status: 'loading' } });
    expect(overlay.send).toHaveBeenCalledWith(OVERLAY_CHANNELS.forgeCiChanged, { repoId: 'repo-1', status: { status: 'loading' } });
  });
});

describe('the clone picker\'s forge channels', () => {
  it('answer only while the picker is open, passing keys and pasted text on with the picker\'s own recursive flag', async () => {
    const { call, actions } = setUp({ clone: { recursive: true } });
    await call(FORGE_CHANNELS.cloneAccounts, {});
    expect(actions.cloneAccounts).toHaveBeenCalled();
    await call(FORGE_CHANNELS.cloneSearch, { accountId: 'gitlab.com|7', query: 'intra', requestId: 3 });
    expect(actions.cloneSearch).toHaveBeenCalledWith({ kind: 'cloneFromAccount', recursive: true }, 'gitlab.com|7', 'intra', 3);
    await call(FORGE_CHANNELS.clonePaste, { text: 'https://gitlab.com/grp/proj.git' });
    expect(actions.clonePaste).toHaveBeenCalledWith('https://gitlab.com/grp/proj.git');
    await call(FORGE_CHANNELS.cloneStart, { accountId: 'gitlab.com|7', key: 'k1' });
    expect(actions.cloneStart).toHaveBeenCalledWith({ kind: 'cloneFromAccount', recursive: true }, { accountId: 'gitlab.com|7', key: 'k1' });
    await call(FORGE_CHANNELS.cloneStart, { pasteText: 'git@gitlab.com:grp/proj.git' });
    expect(actions.cloneStart).toHaveBeenLastCalledWith({ kind: 'cloneFromAccount', recursive: true }, { pasteText: 'git@gitlab.com:grp/proj.git' });
    expect(setUp({ settings: true }).call(FORGE_CHANNELS.cloneAccounts, {})).toBe('closed');
  });

  it('refuses a URL in place of a key, a stray field, a bad requestId and an oversized query', () => {
    const { call } = setUp({ clone: { recursive: false } });
    expect(() => call(FORGE_CHANNELS.cloneStart, { accountId: 'gitlab.com|7', key: 'k1', url: 'https://evil.example/x.git' })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.cloneStart, { url: 'https://evil.example/x.git' })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.cloneStart, { accountId: 'gitlab.com|7', key: 'k1', recursive: true })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.cloneSearch, { accountId: 'gitlab.com|7', query: 'x', requestId: -1 })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.cloneSearch, { accountId: 'gitlab.com|7', query: 'x'.repeat(257), requestId: 1 })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.clonePaste, { text: 7 })).toThrow(/Malformed/);
  });
});

describe('the Publish and fork dialogs\' forge channels', () => {
  it('start the flow of the open dialog of the call\'s requestId only, answering whether it started', () => {
    const { call, actions } = setUp({ publish: 'p1', fork: 'f1' });
    expect(call(FORGE_CHANNELS.publishSubmit, { requestId: 'p1', owner: 'gitlab.com|alexios-s|personal', name: 'damocles fork', visibility: 'public' })).toBe('started');
    expect(actions.publishSubmit).toHaveBeenCalledWith('p1', 'gitlab.com|alexios-s|personal', 'damocles fork', 'public');
    expect(call(FORGE_CHANNELS.forkStart, { requestId: 'f1' })).toBe('ignored');
    expect(actions.forkStart).toHaveBeenCalledWith('f1');
    expect(() => call(FORGE_CHANNELS.publishSubmit, { requestId: 'p2', owner: 'o', name: 'n', visibility: 'private' })).toThrow(/not open/);
    expect(() => call(FORGE_CHANNELS.forkStart, { requestId: 'f2' })).toThrow(/not open/);
    expect(setUp({ settings: true }).call(FORGE_CHANNELS.forkStart, { requestId: 'f1' })).toBe('closed');
  });

  it('refuses a malformed call: an unknown visibility, a stray field such as a URL, an oversized owner', () => {
    const { call, actions } = setUp({ publish: 'p1', fork: 'f1' });
    expect(() => call(FORGE_CHANNELS.publishSubmit, { requestId: 'p1', owner: 'o', name: 'n', visibility: 'secret' })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.publishSubmit, { requestId: 'p1', owner: 'o', name: 'n', visibility: 'private', url: 'https://evil.test/x.git' })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.publishSubmit, { requestId: 'p1', owner: 'o'.repeat(1025), name: 'n', visibility: 'private' })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.forkStart, { requestId: 'f1', path: 'grp/other' })).toThrow(/Malformed/);
    expect(actions.publishSubmit).not.toHaveBeenCalled();
    expect(actions.forkStart).not.toHaveBeenCalled();
  });

  it('pass an owner listing of the open Publish dialog on, and refuse any other', async () => {
    const { call, actions } = setUp({ publish: 'p1' });
    await call(FORGE_CHANNELS.publishOwners, { requestId: 'p1', accountId: 'gitlab.com|2001' });
    expect(actions.publishOwners).toHaveBeenCalledWith('p1', 'gitlab.com|2001');
    expect(() => call(FORGE_CHANNELS.publishOwners, { requestId: 'p2', accountId: 'gitlab.com|2001' })).toThrow(/not open/);
    expect(() => call(FORGE_CHANNELS.publishOwners, { requestId: 'p1', accountId: '' })).toThrow(/Malformed/);
    expect(setUp({ settings: true }).call(FORGE_CHANNELS.publishOwners, { requestId: 'p1', accountId: 'a' })).toBe('closed');
  });
});

describe('the protected-branch dialog\'s forge channels', () => {
  it('pass a name check and Push to a New Branch of the open dialog on, and refuse a malformed call', async () => {
    const { call, actions } = setUp({ protectedBranch: 'b1' });
    expect(await call(FORGE_CHANNELS.protectedCheckName, { requestId: 'b1', name: 'alexios-s/main' })).toEqual({ name: 'alexios-s/main' });
    expect(call(FORGE_CHANNELS.protectedPush, { requestId: 'b1', name: 'alexios-s/main' })).toBe('started');
    expect(actions.protectedPush).toHaveBeenCalledWith('b1', 'alexios-s/main');
    expect(() => call(FORGE_CHANNELS.protectedPush, { requestId: 'b2', name: 'x' })).toThrow(/not open/);
    expect(() => call(FORGE_CHANNELS.protectedPush, { requestId: 'b1', name: 'x'.repeat(256) })).toThrow(/Malformed/);
    expect(() => call(FORGE_CHANNELS.protectedCheckName, { requestId: 'b1', name: 'x', remote: 'evil' })).toThrow(/Malformed/);
    expect(setUp({ settings: true }).call(FORGE_CHANNELS.protectedPush, { requestId: 'b1', name: 'x' })).toBe('closed');
  });
});
