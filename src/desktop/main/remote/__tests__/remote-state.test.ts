import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_STATE_FILE, RemoteState, type RemoteTerminalRecord } from '../remote-state';
import { WINDOW_LAYOUT_FILE, WindowLayoutStore } from '../../window-layout-store';
import { PANEL_STATE_FILE, PanelStateStore } from '../../panel-state-store';

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-remote-state-'));
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

const record = (id: string): RemoteTerminalRecord => ({
  id,
  projectKey: 'loopback|c:\\work\\app',
  profile: { id: 'pwsh', name: 'PowerShell', file: 'C:\\pwsh\\pwsh.exe', args: ['-NoLogo'], icon: 'powershell' },
  startCwd: 'C:\\work\\app',
  nonce: 'abc123',
  name: null,
  customIcon: null,
  color: 'cyan',
});

describe('RemoteState', () => {
  it('keeps each authority\'s remote terminals in remote-state.json and reads them back', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    await state.setTerminals('loopback', [record('term-123456789012345')]);
    await state.setTerminals('ssh+abc', []);
    const reread = await RemoteState.open(userData, () => undefined);
    expect(reread.terminals('loopback')).toEqual([record('term-123456789012345')]);
    expect(reread.terminals('ssh+abc')).toEqual([]);
    expect(reread.terminals('wsl+Ubuntu')).toEqual([]);
  });

  it('keeps each authority\'s open chats with the core epoch they are open under, beside its terminals', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    const chat = { authority: 'loopback', sessionId: 's-1', panelToken: '6f1c2a9e-0d4b-4c1e-9a1f-1b2c3d4e5f60' };
    await state.setTerminals('loopback', [record('term-123456789012345')]);
    await state.setChats('loopback', [chat], '0123456789abcdef0123456789abcdef');
    const reread = await RemoteState.open(userData, () => undefined);
    expect(reread.chats('loopback')).toEqual([chat]);
    expect(reread.coreEpoch('loopback')).toBe('0123456789abcdef0123456789abcdef');
    expect(reread.terminals('loopback')).toEqual([record('term-123456789012345')]);
    expect(reread.chats('ssh+abc')).toEqual([]);
    expect(reread.coreEpoch('ssh+abc')).toBeNull();
  });

  // a new chat whose host dropped before its first send holds its messages under its token alone
  it('keeps a chat record with no conversation across a relaunch, so the new chat and its held messages reopen', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    const fresh = { authority: 'ssh+h1', panelToken: '0b9e4c1a-7f2d-4e3b-8c5a-2d1e0f9a8b7c' };
    await state.setChats('ssh+h1', [fresh], null);
    expect((await RemoteState.open(userData, () => undefined)).chats('ssh+h1')).toEqual([fresh]);
  });

  it('keeps the epoch the away chats ran under with them, and none once none are away', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    await state.setAway('ssh+h1', [{ panelId: 'host-1', sessionId: 'S1', title: 'Fix it' }], '0123456789abcdef0123456789abcdef');
    expect((await RemoteState.open(userData, () => undefined)).awayEpoch('ssh+h1')).toBe('0123456789abcdef0123456789abcdef');
    await state.setAway('ssh+h1', [], '0123456789abcdef0123456789abcdef');
    expect((await RemoteState.open(userData, () => undefined)).awayEpoch('ssh+h1')).toBeNull();
  });

  it('drops a chat record of another authority, without a token, or with a malformed epoch', async () => {
    const token = '6f1c2a9e-0d4b-4c1e-9a1f-1b2c3d4e5f60';
    const chats = [{ authority: 'loopback', sessionId: 's-1', panelToken: token }, { authority: 'ssh+x', sessionId: 's-2', panelToken: token }, { authority: 'loopback', sessionId: 's-3' }];
    fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), JSON.stringify({ version: 1, authorities: { loopback: { terminals: [], chats, coreEpoch: 'not-an-epoch' } } }));
    const state = await RemoteState.open(userData, () => undefined);
    expect(state.chats('loopback')).toEqual([chats[0]]);
    expect(state.coreEpoch('loopback')).toBeNull();
  });

  it('drops a malformed record, and keeps memory unchanged when the write fails', async () => {
    const log = vi.fn();
    fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), JSON.stringify({ version: 1, authorities: { loopback: { terminals: [record('term-1'), { ...record('nope'), id: 'x' }, { ...record('term-2'), color: 'plaid' }] } } }));
    expect((await RemoteState.open(userData, log)).terminals('loopback')).toEqual([record('term-1')]);
    fs.rmSync(path.join(userData, REMOTE_STATE_FILE));
    const state = await RemoteState.open(userData, log);
    fs.mkdirSync(path.join(userData, REMOTE_STATE_FILE));
    await expect(state.setTerminals('loopback', [record('term-3')])).rejects.toThrow();
    expect(state.terminals('loopback')).toEqual([]);
  });

  it('refuses every write for the run while the file does not parse or names another schema, leaving it as it was', async () => {
    const token = '6f1c2a9e-0d4b-4c1e-9a1f-1b2c3d4e5f60';
    const held = JSON.stringify({ version: 1, authorities: {}, offlineQueue: { [token]: { authority: 'ssh+h1', entries: [{ id: 'm1', content: 'keep me', conversationId: null, status: 'queued' }] } } });
    for (const text of [`${held.slice(0, -1)},`, JSON.stringify({ version: 99, authorities: {} })]) {
      fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), text);
      const log = vi.fn();
      const state = await RemoteState.open(userData, log);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('refusing every write'));
      expect(state.unreadable()).toBeDefined();
      expect(state.offlineQueue().size).toBe(0);
      await expect(state.setOfflineQueue(token, undefined)).rejects.toThrow('could not be read');
      await expect(state.setChats('ssh+h1', [], null)).rejects.toThrow('could not be read');
      await expect(state.select({ projectKey: 'ssh+h1|/srv/app' })).rejects.toThrow('could not be read');
      expect(fs.readFileSync(path.join(userData, REMOTE_STATE_FILE), 'utf8')).toBe(text);
    }
    fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), held);
    expect((await RemoteState.open(userData, () => undefined)).unreadable()).toBeUndefined();
  });

  it('keeps an authority whose terminals list is missing, with its chats and epoch', async () => {
    const chat = { authority: 'loopback', sessionId: 's-1', panelToken: '6f1c2a9e-0d4b-4c1e-9a1f-1b2c3d4e5f60' };
    fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), JSON.stringify({ version: 1, authorities: { loopback: { chats: [chat], coreEpoch: '0123456789abcdef0123456789abcdef' } } }));
    const state = await RemoteState.open(userData, () => undefined);
    expect(state.chats('loopback')).toEqual([chat]);
    expect(state.coreEpoch('loopback')).toBe('0123456789abcdef0123456789abcdef');
    expect(state.terminals('loopback')).toEqual([]);
  });

  it('writes its records to remote-state.json alone, leaving panels.json and window-layout.json as they were', async () => {
    const layout = new WindowLayoutStore(userData, () => undefined);
    const panels = new PanelStateStore(userData, () => undefined);
    layout.setTerminals({ terminals: [{ profileId: 'pwsh', projectKey: 'c:\\work\\local', name: null, customIcon: null, color: null }], active: 0, listWidthRem: 12, groups: [{ panes: 1, activePane: 0, sizes: [1] }] });
    panels.select({ projectKey: 'c:\\work\\local' });
    await Promise.all([layout.flush(), panels.flush()]);
    const layoutBefore = fs.readFileSync(path.join(userData, WINDOW_LAYOUT_FILE), 'utf8');
    const panelsBefore = fs.readFileSync(path.join(userData, PANEL_STATE_FILE), 'utf8');
    const state = await RemoteState.open(userData, () => undefined);
    void state.setTerminals('loopback', [record('term-123456789012345')]);
    await state.flush();
    expect(fs.readFileSync(path.join(userData, WINDOW_LAYOUT_FILE), 'utf8')).toBe(layoutBefore);
    expect(fs.readFileSync(path.join(userData, PANEL_STATE_FILE), 'utf8')).toBe(panelsBefore);
    expect(layoutBefore).not.toContain('loopback|');
    expect(JSON.parse(layoutBefore).terminals.terminals[0]).toEqual({ profileId: 'pwsh', projectKey: 'c:\\work\\local', name: null, customIcon: null, color: null });
    expect(JSON.parse(fs.readFileSync(path.join(userData, REMOTE_STATE_FILE), 'utf8'))).toEqual({ version: 1, authorities: { loopback: { terminals: [record('term-123456789012345')], chats: [], away: [], awayEpoch: null, coreEpoch: null } } });
  });
});

describe('the remote selection', () => {
  it('keeps the last remote project and chat, clears for a local one, and changes nothing while sealed', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    await state.select({ projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' });
    expect((await RemoteState.open(userData, () => undefined)).selected()).toEqual({ projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' });
    state.seal();
    await state.select(undefined);
    expect((await RemoteState.open(userData, () => undefined)).selected()).toEqual({ projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' });
    state.unseal();
    await state.select(undefined);
    expect((await RemoteState.open(userData, () => undefined)).selected()).toBeUndefined();
    fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), JSON.stringify({ version: 1, authorities: {}, selected: { projectKey: 5 } }));
    expect((await RemoteState.open(userData, () => undefined)).selected()).toBeUndefined();
  });
});

describe('the chats left running', () => {
  it('keeps them across a relaunch, dropping a malformed record', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    await state.setAway('ssh+h1', [{ panelId: 'host-1', sessionId: 'S1', title: 'Fix the parser' }], null);
    const file = JSON.parse(fs.readFileSync(path.join(userData, REMOTE_STATE_FILE), 'utf8')) as { authorities: Record<string, { away: unknown[] }> };
    file.authorities['ssh+h1']!.away.push({ panelId: '', sessionId: 'S2', title: 'x' });
    fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), JSON.stringify(file));
    expect((await RemoteState.open(userData, () => undefined)).away('ssh+h1')).toEqual([{ panelId: 'host-1', sessionId: 'S1', title: 'Fix the parser' }]);
  });
});
