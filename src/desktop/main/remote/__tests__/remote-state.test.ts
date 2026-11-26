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

  // a write replaces only its own authority's records, so a host whose write is skipped keeps its own
  it('reads back no record of a terminal a write left out, another host\'s records untouched, and a restarted one\'s new nonce', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    const [running, exited, away] = [record('term-111111111111111'), record('term-222222222222222'), record('term-333333333333333')];
    await state.setTerminals('loopback', [running, exited]);
    await state.setTerminals('ssh+away', [away]);
    await state.setTerminals('loopback', [running]);
    const relaunched = await RemoteState.open(userData, () => undefined);
    expect(relaunched.terminals('loopback')).toEqual([running]);
    expect(relaunched.terminals('ssh+away')).toEqual([away]);
    await relaunched.setTerminals('loopback', []);
    expect(JSON.parse(fs.readFileSync(path.join(userData, REMOTE_STATE_FILE), 'utf8')).authorities).toEqual({ 'ssh+away': expect.anything() });
    await relaunched.setTerminals('loopback', [{ ...exited, nonce: 'fresh' }]);
    expect((await RemoteState.open(userData, () => undefined)).terminals('loopback')).toEqual([{ ...exited, nonce: 'fresh' }]);
  });

  it('drops a killed terminal\'s record and keeps its id for the next reattach in one write, across a relaunch, until the reattach is done with it', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    const [killed, kept] = [record('term-111111111111111'), record('term-222222222222222')];
    await state.setTerminals('loopback', [killed, kept]);
    await state.killOnReattach('loopback', killed.id);
    await state.killOnReattach('loopback', killed.id);
    const relaunched = await RemoteState.open(userData, () => undefined);
    expect(relaunched.terminals('loopback')).toEqual([kept]);
    expect(relaunched.pendingKills('loopback')).toEqual([killed.id]);
    expect(relaunched.pendingKills('ssh+abc')).toEqual([]);
    // the records a reattach writes leave the kill waiting
    await relaunched.setTerminals('loopback', []);
    expect((await RemoteState.open(userData, () => undefined)).pendingKills('loopback')).toEqual([killed.id]);
    await relaunched.killsDone('loopback', [killed.id]);
    expect(JSON.parse(fs.readFileSync(path.join(userData, REMOTE_STATE_FILE), 'utf8')).authorities).toEqual({});
  });

  it('reads only well-formed, distinct terminal ids as pending kills', async () => {
    fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), JSON.stringify({ version: 1, authorities: { loopback: { terminals: [], pendingKills: ['term-111111111111111', '../x', 7, 'term-111111111111111'] }, 'ssh+abc': { terminals: [], pendingKills: 'x' } } }));
    const state = await RemoteState.open(userData, () => undefined);
    expect(state.pendingKills('loopback')).toEqual(['term-111111111111111']);
    expect(state.pendingKills('ssh+abc')).toEqual([]);
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

  it('keeps the project a chat was open in, and drops a project key of another authority while keeping the chat', async () => {
    const token = '6f1c2a9e-0d4b-4c1e-9a1f-1b2c3d4e5f60';
    const other = '0b9e4c1a-7f2d-4e3b-8c5a-2d1e0f9a8b7c';
    const state = await RemoteState.open(userData, () => undefined);
    const chat = { authority: 'ssh+h1', sessionId: 's-1', panelToken: token, projectKey: 'ssh+h1|/home/dev/acme' };
    await state.setChats('ssh+h1', [chat, { authority: 'ssh+h1', sessionId: 's-2', panelToken: other, projectKey: 'ssh+h2|/home/dev/acme' }], null);
    expect((await RemoteState.open(userData, () => undefined)).chats('ssh+h1')).toEqual([chat, { authority: 'ssh+h1', sessionId: 's-2', panelToken: other }]);
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
    layout.setTerminals({ version: 2, listWidthRem: 12, groups: [{ panes: [{ kind: 'local', profileId: 'pwsh', projectKey: 'c:\\work\\local', name: null, customIcon: null, color: null }], activePane: 0, sizes: [1] }], active: 0, editor: [] });
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
    expect(JSON.parse(layoutBefore).terminals.groups[0].panes[0]).toEqual({ kind: 'local', profileId: 'pwsh', projectKey: 'c:\\work\\local', name: null, customIcon: null, color: null });
    expect(JSON.parse(fs.readFileSync(path.join(userData, REMOTE_STATE_FILE), 'utf8'))).toEqual({ version: 1, authorities: { loopback: { terminals: [record('term-123456789012345')], pendingKills: [], chats: [], away: [], awayEpoch: null, coreEpoch: null, lastChats: [] } } });
  });
});

describe('a required update\'s first detection', () => {
  const since = { serverVersion: '3.7.0+0123456789ab', detectedAt: 1_000, deadline: 90_000 };

  it('is kept per authority across a relaunch, replaced by a tightened one, cleared, and dropped by Forget host', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    expect(state.requiredSince('ssh+h1')).toBeUndefined();
    await state.setRequiredSince('ssh+h1', since);
    await state.setRequiredSince('ssh+h2', { ...since, deadline: 50_000 });
    expect((await RemoteState.open(userData, () => undefined)).requiredSince('ssh+h1')).toEqual(since);
    await state.setRequiredSince('ssh+h1', { ...since, deadline: 60_000 });
    expect((await RemoteState.open(userData, () => undefined)).requiredSince('ssh+h1')).toEqual({ ...since, deadline: 60_000 });

    await state.setRequiredSince('ssh+h1', undefined);
    const cleared = await RemoteState.open(userData, () => undefined);
    expect(cleared.requiredSince('ssh+h1')).toBeUndefined();
    expect(cleared.requiredSince('ssh+h2')).toEqual({ ...since, deadline: 50_000 });
    // an authority holding nothing else leaves no entry
    expect(JSON.parse(fs.readFileSync(path.join(userData, REMOTE_STATE_FILE), 'utf8')).authorities).not.toHaveProperty('ssh+h1');

    await state.forgetAuthority('ssh+h2');
    expect((await RemoteState.open(userData, () => undefined)).requiredSince('ssh+h2')).toBeUndefined();
  });

  it('is kept apart from when the switch started waiting, which is kept across a relaunch, cleared, and dropped by Forget host', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    expect(state.pendingSince('ssh+h1')).toBeUndefined();
    await state.setPendingSince('ssh+h1', { serverVersion: since.serverVersion, since: 2_000 });
    await state.setRequiredSince('ssh+h1', since);
    const reopened = await RemoteState.open(userData, () => undefined);
    expect(reopened.pendingSince('ssh+h1')).toEqual({ serverVersion: since.serverVersion, since: 2_000 });
    expect(reopened.requiredSince('ssh+h1')).toEqual(since);
    await state.setRequiredSince('ssh+h1', undefined);
    await state.setPendingSince('ssh+h1', undefined);
    expect(JSON.parse(fs.readFileSync(path.join(userData, REMOTE_STATE_FILE), 'utf8')).authorities).not.toHaveProperty('ssh+h1');
    await state.setPendingSince('ssh+h1', { serverVersion: since.serverVersion, since: 2_000 });
    await state.forgetAuthority('ssh+h1');
    expect((await RemoteState.open(userData, () => undefined)).pendingSince('ssh+h1')).toBeUndefined();
    for (const pendingSince of [null, { serverVersion: '', since: 1 }, { serverVersion: '3.7.0', since: 'then' }, { since: 1 }]) {
      fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), JSON.stringify({ version: 1, authorities: { 'ssh+h1': { terminals: [], pendingSince } } }));
      expect((await RemoteState.open(userData, () => undefined)).pendingSince('ssh+h1'), JSON.stringify(pendingSince)).toBeUndefined();
    }
  });

  it('drops a malformed record', async () => {
    for (const requiredSince of [null, 'soon', { ...since, serverVersion: '' }, { ...since, deadline: 'later' }, { ...since, detectedAt: null }, { serverVersion: since.serverVersion }]) {
      fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), JSON.stringify({ version: 1, authorities: { 'ssh+h1': { terminals: [], requiredSince } } }));
      expect((await RemoteState.open(userData, () => undefined)).requiredSince('ssh+h1'), JSON.stringify(requiredSince)).toBeUndefined();
    }
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

describe('the last chats', () => {
  it('keeps a remote project\'s last chat under its authority, and Forget host drops it', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    await state.setLastChats('ssh+h1', [{ projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' }, { projectKey: 'ssh+h1|/srv/api', sessionId: 's-2' }]);
    await state.setLastChats('loopback', [{ projectKey: 'loopback|c:\\work\\app', sessionId: 's-3' }]);
    const reread = await RemoteState.open(userData, () => undefined);
    expect(reread.lastChats('ssh+h1')).toEqual([{ projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' }, { projectKey: 'ssh+h1|/srv/api', sessionId: 's-2' }]);
    expect(reread.lastChats('loopback')).toEqual([{ projectKey: 'loopback|c:\\work\\app', sessionId: 's-3' }]);
    expect(reread.lastChats('ssh+h2')).toEqual([]);

    // a closing window keeps them as they were
    state.seal();
    await state.setLastChats('ssh+h1', []);
    expect((await RemoteState.open(userData, () => undefined)).lastChats('ssh+h1')).toHaveLength(2);
    state.unseal();

    await state.forgetAuthority('ssh+h1');
    const forgotten = await RemoteState.open(userData, () => undefined);
    expect(forgotten.lastChats('ssh+h1')).toEqual([]);
    expect(forgotten.lastChats('loopback')).toEqual([{ projectKey: 'loopback|c:\\work\\app', sessionId: 's-3' }]);
  });

  it('lands the writes a batch makes as one write of remote-state.json, each settling once it landed', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    const rename = fs.promises.rename.bind(fs.promises);
    let writes = 0;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(to)) === REMOTE_STATE_FILE) writes++;
      return rename(from, to);
    });
    try {
      let remembered: Promise<void> | undefined;
      let selected: Promise<void> | undefined;
      state.batch(() => {
        remembered = state.setLastChats('ssh+h1', [{ projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' }]);
        selected = state.select({ projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' });
      });
      await Promise.all([remembered, selected]);
      expect(writes).toBe(1);
      expect(state.lastChats('ssh+h1')).toEqual([{ projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' }]);
      expect(state.selected()).toEqual({ projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' });
      const reread = await RemoteState.open(userData, () => undefined);
      expect([reread.lastChats('ssh+h1'), reread.selected()]).toEqual([state.lastChats('ssh+h1'), state.selected()]);
    } finally {
      spy.mockRestore();
    }
  });

  it('fails each write of a batch whose one write is refused', async () => {
    fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), 'not json');
    const state = await RemoteState.open(userData, () => undefined);
    const writes: Array<Promise<void>> = [];
    state.batch(() => {
      writes.push(state.setLastChats('ssh+h1', [{ projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' }]));
      writes.push(state.select({ projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' }));
    });
    expect(writes).toHaveLength(2);
    await Promise.all(writes.map((write) => expect(write).rejects.toThrow('could not be read')));
    expect(fs.readFileSync(path.join(userData, REMOTE_STATE_FILE), 'utf8')).toBe('not json');
  });

  it('keeps no entry for an authority a write leaves holding nothing, as after a chat shown during Forget host', async () => {
    const state = await RemoteState.open(userData, () => undefined);
    await state.setTerminals('loopback', [record('term-123456789012345')]);
    await state.forgetAuthority('ssh+h1');
    // a remote chat shown before the host record went, then its project unlisted
    await state.setLastChats('ssh+h1', [{ projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' }]);
    await state.setLastChats('ssh+h1', []);
    await state.setChats('ssh+h2', [], null);
    const written = JSON.parse(fs.readFileSync(path.join(userData, REMOTE_STATE_FILE), 'utf8')) as { authorities: Record<string, unknown> };
    expect(Object.keys(written.authorities)).toEqual(['loopback']);
    await state.setTerminals('loopback', []);
    expect(JSON.parse(fs.readFileSync(path.join(userData, REMOTE_STATE_FILE), 'utf8'))).toEqual({ version: 1, authorities: {} });
  });

  // An entry without a session records that the project's last viewed chat is gone (LastChats).
  it('drops an entry of another authority or for a project already named, and keeps one without a session', async () => {
    const lastChats = [
      { projectKey: 'ssh+h1|/srv/app', sessionId: 's-1' },
      { projectKey: 'ssh+h2|/srv/app', sessionId: 's-2' },
      { projectKey: 'ssh+h1|/srv/api' },
      { projectKey: 'ssh+h1|/srv/app', sessionId: 's-3' },
      { projectKey: 7, sessionId: 's-4' },
    ];
    fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), JSON.stringify({ version: 1, authorities: { 'ssh+h1': { lastChats } } }));
    expect((await RemoteState.open(userData, () => undefined)).lastChats('ssh+h1')).toEqual([lastChats[0], lastChats[2]]);
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
