import { describe, expect, it, vi } from 'vitest';
import { MAX_OVERLAY_ITEMS, OVERLAY_CHANNELS } from '../../../preload/overlay-channels';
import { parseConnectTarget, registerConnectChannels, type ConnectActions } from '../connect-channels';

vi.mock('electron', () => ({}));

function setup(open = true) {
  const handlers = new Map<string, (raw: unknown) => unknown>();
  const actions: { [K in keyof ConnectActions]: ReturnType<typeof vi.fn> } = {
    checkName: vi.fn(() => ({ ok: true, name: 'n' })),
    rename: vi.fn(async () => ({ ok: true, name: 'n' })),
    parse: vi.fn(() => ({ ok: false, refused: '-F', reason: 'option' })),
    start: vi.fn(async () => ({ ok: true, attemptId: 'a', hostId: 'h' })),
    answer: vi.fn(),
    cancel: vi.fn(),
    browse: vi.fn(async () => ({ ok: false, error: 'notConnected' })),
    pickFolder: vi.fn(async () => ({ projectKey: 'k' })),
    runs: vi.fn(async () => []),
    killRun: vi.fn(async () => undefined),
    openRun: vi.fn(async () => undefined),
    showLog: vi.fn(async () => undefined),
    setInstallFolder: vi.fn(async () => ({ ok: true })),
    copyHostKeyCommand: vi.fn(async () => undefined),
    allowBackground: vi.fn(async () => ({ result: 'enabled' as const })),
    entries: vi.fn(() => []),
    setSetting: vi.fn(async () => undefined),
    revokeCredentialHost: vi.fn(async () => undefined),
    setUpPasswordless: vi.fn(async () => ({ ok: true })),
    removalInfo: vi.fn(async () => ({ runs: [], offerRemoveKey: false, offerDisableLinger: false })),
    removeServer: vi.fn(async () => ({ ok: true, notices: [] })),
    retryRemoval: vi.fn(async () => ({ ok: true, notices: [] })),
    operations: vi.fn(() => ({ hostId: 'h', revision: 1 })),
    forget: vi.fn(async () => undefined),
    openSettings: vi.fn(),
  };
  // handleWhileOpen as OverlayHost has it: closed answers a value, an open popup runs the handler
  registerConnectChannels({
    isOpen: () => open,
    handleWhileOpen: (channel, isOpen, handler) => {
      handlers.set(channel, async (raw) => (isOpen() ? { ok: true, value: await handler(raw) } : { ok: false, reason: 'closed' }));
    },
  }, actions as unknown as ConnectActions);
  const call = (channel: string, raw: unknown): Promise<unknown> => Promise.resolve().then(() => handlers.get(channel)!(raw));
  return { actions, call, handlers };
}

describe('the Connect dialog channels', () => {
  it('registers every channel and answers closed while no connect request is open', async () => {
    const { handlers, call, actions } = setup(false);
    for (const channel of ['hostsCheckName', 'hostsRename', 'hostsParse', 'connectStart', 'connectAnswer', 'connectCancel', 'connectBrowse', 'connectPickFolder', 'hostsRuns', 'hostsKillRun', 'hostsOpenRun', 'hostsShowLog', 'hostsSetInstallFolder', 'hostsCopyHostKeyCommand'] as const) {
      expect(handlers.has(OVERLAY_CHANNELS[channel])).toBe(true);
    }
    expect(await call(OVERLAY_CHANNELS.connectCancel, { attemptId: 'a' })).toEqual({ ok: false, reason: 'closed' });
    expect(actions.cancel).not.toHaveBeenCalled();
  });

  it('passes exact, bounded payloads through and refuses anything else', async () => {
    const { call, actions } = setup();
    expect(await call(OVERLAY_CHANNELS.hostsCheckName, { name: 'prod', hostId: 'h1' })).toEqual({ ok: true, value: { ok: true, name: 'n' } });
    expect(actions.checkName).toHaveBeenCalledWith('prod', 'h1');
    await expect(call(OVERLAY_CHANNELS.hostsCheckName, { name: 'prod', extra: 1 })).rejects.toThrow('Malformed');
    await expect(call(OVERLAY_CHANNELS.hostsCheckName, { name: 'x'.repeat(10_000) })).rejects.toThrow('Malformed');
    await expect(call(OVERLAY_CHANNELS.hostsRename, { hostId: '', name: 'a' })).rejects.toThrow('Malformed');
    await expect(call(OVERLAY_CHANNELS.connectAnswer, { attemptId: 'a', promptId: 'p' })).rejects.toThrow('Malformed');
    await call(OVERLAY_CHANNELS.connectAnswer, { attemptId: 'a', promptId: 'p', answer: null });
    expect(actions.answer).toHaveBeenCalledWith('a', 'p', null, false);
    await call(OVERLAY_CHANNELS.connectAnswer, { attemptId: 'a', promptId: 'p', answer: 'pw', remember: true });
    expect(actions.answer).toHaveBeenCalledWith('a', 'p', 'pw', true);
    await expect(call(OVERLAY_CHANNELS.connectAnswer, { attemptId: 'a', promptId: 'p', answer: 'pw', remember: 'yes' })).rejects.toThrow('Malformed');
    await expect(call(OVERLAY_CHANNELS.connectBrowse, { hostId: 'h', path: 'a\0b' })).rejects.toThrow('Malformed');
    await call(OVERLAY_CHANNELS.connectBrowse, { hostId: 'h' });
    expect(actions.browse).toHaveBeenCalledWith('h', undefined);
    await expect(call(OVERLAY_CHANNELS.connectPickFolder, { hostId: 'h', path: '' })).rejects.toThrow('Malformed');
    await expect(call(OVERLAY_CHANNELS.hostsSetInstallFolder, { hostId: 'h' })).rejects.toThrow('Malformed');
    await call(OVERLAY_CHANNELS.hostsSetInstallFolder, { hostId: 'h', folder: null });
    expect(actions.setInstallFolder).toHaveBeenCalledWith('h', null);
    await expect(call(OVERLAY_CHANNELS.hostsKillRun, { hostId: 'h', runId: 7 })).rejects.toThrow('Malformed');
    await call(OVERLAY_CHANNELS.hostsOpenRun, { hostId: 'h', runId: 'term-1' });
    expect(actions.openRun).toHaveBeenCalledWith('h', 'term-1');
    await expect(call(OVERLAY_CHANNELS.hostsOpenRun, { hostId: 'h', runId: 'term-1', projectKey: 'x' })).rejects.toThrow('Malformed');
    await expect(call(OVERLAY_CHANNELS.connectStart, { target: { hostId: 'h', input: 'x' } })).rejects.toThrow('Malformed');
  });
});

describe('the Remote hosts channels', () => {
  it('rebuilds each setting change and refuses a key or value outside the contract', async () => {
    const { call, actions } = setup();
    await call(OVERLAY_CHANNELS.hostsSetSetting, { hostId: 'h', change: { key: 'color', value: 'danger' } });
    await call(OVERLAY_CHANNELS.hostsSetSetting, { hostId: 'h', change: { key: 'defaultPermissionMode', value: null } });
    await call(OVERLAY_CHANNELS.hostsSetSetting, { hostId: 'h', change: { key: 'allowBypass', value: true } });
    expect(actions.setSetting.mock.calls).toEqual([['h', { key: 'color', value: 'danger' }], ['h', { key: 'defaultPermissionMode', value: null }], ['h', { key: 'allowBypass', value: true }]]);
    for (const change of [{ key: 'color', value: '#ff0000' }, { key: 'defaultPermissionMode', value: 'bypassPermissions' }, { key: 'allowBypass', value: 'yes' }, { key: 'installFolder', value: '/x' }, { key: 'color', value: 'danger', extra: 1 }]) {
      await expect(call(OVERLAY_CHANNELS.hostsSetSetting, { hostId: 'h', change })).rejects.toThrow('Malformed');
    }
    await expect(call(OVERLAY_CHANNELS.hostsRevokeCredential, { hostId: 'h', credentialHost: 'github.com/evil' })).rejects.toThrow('Malformed');
    await call(OVERLAY_CHANNELS.hostsRevokeCredential, { hostId: 'h', credentialHost: 'github.com' });
    expect(actions.revokeCredentialHost).toHaveBeenCalledWith('h', 'github.com');
    await expect(call(OVERLAY_CHANNELS.hostsRemoveServer, { hostId: 'h', options: { removeKey: true } })).rejects.toThrow('Malformed');
    await call(OVERLAY_CHANNELS.hostsRemoveServer, { hostId: 'h', options: { removeKey: true, disableLinger: false } });
    expect(actions.removeServer).toHaveBeenCalledWith('h', { removeKey: true, disableLinger: false });
    await expect(call(OVERLAY_CHANNELS.hostsRetryRemoval, { hostId: 'h', options: {} })).rejects.toThrow('Malformed');
    await call(OVERLAY_CHANNELS.hostsRetryRemoval, { hostId: 'h' });
    expect(actions.retryRemoval).toHaveBeenCalledWith('h');
    await expect(call(OVERLAY_CHANNELS.hostsOperations, { hostId: 'h', revision: 1 })).rejects.toThrow('Malformed');
    await expect(call(OVERLAY_CHANNELS.hostsOperations, { hostId: '' })).rejects.toThrow('Malformed');
    expect(await call(OVERLAY_CHANNELS.hostsOperations, { hostId: 'h' })).toEqual({ ok: true, value: { hostId: 'h', revision: 1 } });
    expect(actions.operations).toHaveBeenCalledWith('h');
  });

  it('answers the saved hosts rebuilt field by field, as their pushes are, and rejects a list past the overlay bounds', async () => {
    const { call, actions } = setup();
    const entry = {
      hostId: 'h1',
      authorityKey: 'ssh+h1',
      name: 'prod-1',
      destinationLabel: 'deploy@10.0.0.9',
      connection: 'connected',
      settings: { allowBypass: false, forwardAgent: true, rememberPassword: false, browserLocalNetwork: false, openLinksWithoutAsking: false },
      facts: { passwordless: true, keyInstalledByDamocles: false, lingerEnabledByDamocles: false, alwaysCredentialHosts: ['github.com'] },
    };
    actions.entries.mockReturnValue([{ ...entry, password: 'not for the page', settings: { ...entry.settings, token: 'x' } }]);
    expect(await call(OVERLAY_CHANNELS.hostsList, {})).toEqual({ ok: true, value: [entry] });
    actions.entries.mockReturnValue(Array.from({ length: MAX_OVERLAY_ITEMS + 1 }, (_, index) => ({ ...entry, hostId: `h${index}`, authorityKey: `ssh+h${index}` })));
    await expect(call(OVERLAY_CHANNELS.hostsList, {})).rejects.toThrow('The saved hosts exceed the overlay bounds');
    await expect(call(OVERLAY_CHANNELS.hostsList, { all: true })).rejects.toThrow('Malformed');
  });
});

describe('parseConnectTarget', () => {
  it('rebuilds each target form and nothing else', () => {
    expect(parseConnectTarget({ target: { hostId: 'h1' } })).toEqual({ hostId: 'h1' });
    expect(parseConnectTarget({ target: { alias: 'prod-1', name: 'Prod' } })).toEqual({ alias: 'prod-1', name: 'Prod' });
    expect(parseConnectTarget({ target: { input: 'ssh deploy@10.0.0.9', name: '' } })).toEqual({ input: 'ssh deploy@10.0.0.9', name: '' });
    expect(parseConnectTarget({ target: { alias: '', name: 'x' } })).toBeUndefined();
    expect(parseConnectTarget({ target: { alias: 'a', name: 'x', options: [] } })).toBeUndefined();
    expect(parseConnectTarget({ target: 'h1' })).toBeUndefined();
    expect(parseConnectTarget({ target: { hostId: 'h1' }, more: true })).toBeUndefined();
  });
});
