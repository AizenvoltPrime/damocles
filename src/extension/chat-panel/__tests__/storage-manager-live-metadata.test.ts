import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { __watchers } from 'vscode';
import type { StoredSession } from '../../../shared/types/session';
import type { FolderTarget } from '../../workspace-folders/folder-registry';
import type { HostInstance } from '../types';

vi.mock('../../logger', () => ({ log: vi.fn() }));

vi.mock('../../pi-session/session-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pi-session/session-store')>();
  return {
    ...actual,
    getPiSessionMetadata: vi.fn(actual.getPiSessionMetadata),
    getPiSessionMetadataByFile: vi.fn(actual.getPiSessionMetadataByFile),
  };
});

vi.mock('../../pi-session/checkpoints', () => ({
  pruneOrphanCheckpointRepos: vi.fn(async () => undefined),
  getCheckpointsBaseDir: () => path.join(os.homedir(), 'flat-checkpoints'),
  getWorkspaceCheckpointDir: (dir: string) => path.join(os.homedir(), 'checkpoints', path.basename(dir)),
}));

import { StorageManager } from '../storage-manager';
import * as store from '../../pi-session/session-store';
import { initPiLoader } from '../../pi-session/pi-loader';

const pi = (await initPiLoader())!;
const folderPath = path.join(os.homedir(), 'live-metadata-workspace');
const A: FolderTarget = { key: folderPath.toLowerCase(), fsPath: folderPath, name: 'live', label: 'live', projectScope: true };

let clock = 1_700_000_000_000;
const user = (text: string): never => ({ role: 'user', content: [{ type: 'text', text }], timestamp: clock++ }) as never;
const reply = (text: string): never => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp: clock++,
}) as never;

/** A session file on disk, and a manager holding it open as a live `PiSession` would. */
function liveSessionOnDisk() {
  const sm = pi.SessionManager.inMemory(folderPath);
  sm.appendMessage(user('hello'));
  sm.appendMessage(reply('hi'));
  const dir = store.ensurePiSessionDir(folderPath);
  const file = path.join(dir, `${sm.getHeader()!.timestamp.replace(/[:.]/g, '-')}_${sm.getSessionId()}.jsonl`);
  fs.writeFileSync(file, [sm.getHeader(), ...sm.getEntries()].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const live = pi.SessionManager.open(file, dir);
  const source = { liveSessionFile: () => live.getSessionFile(), storedMetadata: (mtimeMs: number) => store.sessionFileMeta(live, mtimeMs) };
  return { live, file, source };
}

function harness(liveSession: (id: string) => ReturnType<typeof liveSessionOnDisk>['source'] | undefined) {
  const posted: StoredSession[][] = [];
  const panels = new Map<string, HostInstance>([['p1', { host: { id: 'h1' } } as unknown as HostInstance]]);
  const manager = new StorageManager({
    folders: () => [A],
    isMultiRoot: () => false,
    postMessage: (_host, message) => {
      if (message.type === 'storedSessions') posted.push(message.sessions);
    },
    getPanels: () => panels,
    liveSession,
  });
  return { manager, lastList: () => posted.at(-1) };
}

describe('StorageManager: a live session\'s own file', () => {
  it('is read from the live session on a watcher change and on a live upsert, never re-parsed', async () => {
    const { live, file, source } = liveSessionOnDisk();
    const id = live.getSessionId();
    const { manager, lastList } = harness((sessionId) => (sessionId === id ? source : undefined));
    await manager.getStoredSessions();
    await manager.setupSessionWatcher();
    const watcher = __watchers.at(-1)!;
    const open = vi.spyOn(pi.SessionManager, 'open');
    try {
      live.appendMessage(user('next question'));
      watcher.emitChange(file);
      await vi.waitFor(() => expect(lastList()?.find((s) => s.id === id)?.messageCount).toBe(3), { timeout: 3000 });

      live.appendSessionInfo('Renamed live');
      await manager.addOrUpdateSession(id, A.key);
      expect(lastList()?.find((s) => s.id === id)?.aiTitle).toBe('Renamed live');

      manager.invalidateSessionsCache();
      expect((await manager.getStoredSessions()).sessions.find((s) => s.id === id)?.aiTitle).toBe('Renamed live');

      expect(open).not.toHaveBeenCalled();
      expect(store.getPiSessionMetadataByFile).not.toHaveBeenCalled();
      expect(store.getPiSessionMetadata).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
      manager.dispose();
    }
  });

  it('a file no live session holds is read from disk', async () => {
    const { live, file } = liveSessionOnDisk();
    const { manager, lastList } = harness(() => undefined);
    await manager.getStoredSessions();
    await manager.setupSessionWatcher();
    try {
      live.appendMessage(user('written elsewhere'));
      __watchers.at(-1)!.emitChange(file);
      await vi.waitFor(() => expect(lastList()?.find((s) => s.id === live.getSessionId())?.messageCount).toBe(3), { timeout: 3000 });
      expect(store.getPiSessionMetadataByFile).toHaveBeenCalledWith(file);
    } finally {
      manager.dispose();
    }
  });

  it('a live session whose snapshot throws is read from its file instead', async () => {
    const { live } = liveSessionOnDisk();
    const id = live.getSessionId();
    const source = { liveSessionFile: () => live.getSessionFile(), storedMetadata: (): never => { throw new Error('disposed'); } };
    const { manager, lastList } = harness((sessionId) => (sessionId === id ? source : undefined));
    await manager.getStoredSessions();
    try {
      live.appendSessionInfo('Renamed on disk');
      await manager.addOrUpdateSession(id, A.key);

      expect(lastList()?.find((s) => s.id === id)?.aiTitle).toBe('Renamed on disk');
      expect(store.getPiSessionMetadata).toHaveBeenCalledWith(folderPath, id);
    } finally {
      manager.dispose();
    }
  });
});
