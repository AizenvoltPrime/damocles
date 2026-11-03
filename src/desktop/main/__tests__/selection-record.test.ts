import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const written = vi.hoisted(() => ({ files: [] as string[] }));

vi.mock('../../../core/config/json-config-write', async (importActual) => {
  const actual = await importActual<typeof import('../../../core/config/json-config-write')>();
  return {
    ...actual,
    writeJsonConfig: (...args: Parameters<typeof actual.writeJsonConfig>) => {
      written.files.push(path.basename(args[0]));
      return actual.writeJsonConfig(...args);
    },
  };
});

import { LastChats } from '../last-chats';
import { PANEL_STATE_FILE, PanelStateStore } from '../panel-state-store';
import { REMOTE_STATE_FILE, RemoteState } from '../remote/remote-state';
import { recordSelection } from '../selection-record';

const LOCAL = 'c:\\work\\p';
const REMOTE = 'ssh+h1|/srv/app';

let userData: string;

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-selection-'));
  written.files = [];
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

// the stores as main wires them: LastChats writes through to the same two files the selection goes to
async function stores() {
  const reported: unknown[] = [];
  const report = (err: unknown): void => {
    reported.push(err);
  };
  const lastChatFailures: unknown[] = [];
  const states = new PanelStateStore(userData, () => undefined);
  const remoteState = await RemoteState.open(userData, () => undefined);
  const lastChats = new LastChats({
    writeLocal: (entries) => states.setLastChats(entries),
    writeRemote: (authority, entries) => void remoteState.setLastChats(authority, entries).catch((err: unknown) => lastChatFailures.push(err)),
  });
  const settled = async (): Promise<void> => {
    await states.flush();
    await remoteState.flush();
  };
  return { deps: { states, remoteState, lastChats, report }, reported, lastChatFailures, settled };
}

const onDisk = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(userData, file), 'utf8'));

describe('recordSelection', () => {
  it('writes a local selection and its project\'s last chat to panels.json in one write, and leaves remote-state.json alone', async () => {
    const { deps, settled } = await stores();
    recordSelection(deps, { projectKey: LOCAL, chatId: 's-1', panelId: 'panel-1', authority: 'local', sessionId: 's-1' });
    await settled();
    expect(written.files).toEqual([PANEL_STATE_FILE]);
    expect(onDisk(PANEL_STATE_FILE)).toMatchObject({
      selected: { projectKey: LOCAL, panelId: 'panel-1', sessionId: 's-1' },
      lastChats: [{ projectKey: LOCAL, sessionId: 's-1' }],
    });
  });

  it('writes a remote selection and its project\'s last chat to remote-state.json in one write, and never to panels.json', async () => {
    const { deps, settled } = await stores();
    recordSelection(deps, { projectKey: REMOTE, chatId: 's-r', panelId: 'panel-r', authority: 'ssh+h1', sessionId: 's-r' });
    await settled();
    expect(written.files).toEqual([REMOTE_STATE_FILE]);
    expect(onDisk(REMOTE_STATE_FILE)).toMatchObject({
      selected: { projectKey: REMOTE, sessionId: 's-r' },
      authorities: { 'ssh+h1': { lastChats: [{ projectKey: REMOTE, sessionId: 's-r' }] } },
    });
    expect(fs.existsSync(path.join(userData, PANEL_STATE_FILE))).toBe(false);
  });

  it('a local selection after a remote one clears remote-state.json\'s selection in one write of each file', async () => {
    const { deps, settled } = await stores();
    recordSelection(deps, { projectKey: REMOTE, chatId: 's-r', panelId: 'panel-r', authority: 'ssh+h1', sessionId: 's-r' });
    await settled();
    written.files = [];
    recordSelection(deps, { projectKey: LOCAL, chatId: 'new:panel-1', panelId: 'panel-1', authority: 'local' });
    await settled();
    expect(written.files.sort()).toEqual([PANEL_STATE_FILE, REMOTE_STATE_FILE]);
    expect(onDisk(REMOTE_STATE_FILE)).not.toHaveProperty('selected');
    expect(onDisk(PANEL_STATE_FILE)).toMatchObject({ selected: { projectKey: LOCAL, panelId: 'panel-1' } });
  });

  it('reports a remote selection remote-state.json refused', async () => {
    fs.writeFileSync(path.join(userData, REMOTE_STATE_FILE), 'not json');
    const { deps, reported, lastChatFailures } = await stores();
    recordSelection(deps, { projectKey: REMOTE, chatId: 's-r', panelId: 'panel-r', authority: 'ssh+h1', sessionId: 's-r' });
    await vi.waitFor(() => expect(reported).toHaveLength(1));
    expect(String(reported[0])).toContain('could not be read, so it is not changed');
    expect(lastChatFailures).toHaveLength(1);
    expect(written.files).toEqual([]);
  });
});
