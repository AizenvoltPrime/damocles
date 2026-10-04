import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger', () => ({ log: vi.fn() }));
vi.mock('../ide-context-manager', () => ({
  IdeContextManager: class {
    dispose(): void {}
  },
}));

import { createHarness, folderEntry, makeFakeHost, type FakeSession, type Harness } from './panel-manager-harness';
import { folderKey } from '../../workspace-folders/folder-key';
import type { ChatActivity } from '../../pi-session/session-state';

const ROOT = path.resolve(os.tmpdir(), 'panel-activity-root');
const A = path.join(ROOT, 'alpha');
const B = path.join(ROOT, 'beta');

let h: Harness;

afterEach(() => {
  h.dispose();
});

describe('PanelManager activity', () => {
  // Main re-reads `sessionIdOf` on each report, so every bind must report, a replaced session's included.
  it('reports each session bind under the panel id, and a replaced session never reports again', async () => {
    h = createHarness([folderEntry(A), folderEntry(B)]);
    const seen: Array<[string, ChatActivity]> = [];
    h.manager.onActivity((panelId, activity) => seen.push([panelId, activity]));

    const panelId = await h.manager.initializeHost(makeFakeHost(), { initialFolderKey: folderKey(A) });
    const first = h.instance(panelId).session as unknown as FakeSession;
    expect(seen).toEqual([[panelId, { state: 'idle', pendingKinds: [], background: false }]]);

    await h.manager.switchPanelFolder(panelId, folderKey(B), 'resume');

    expect(seen.map(([id]) => id)).toEqual([panelId, panelId]);
    expect(first.activityListener).toBeNull();
    expect((h.instance(panelId).session as unknown as FakeSession).activityListener).toBeTypeOf('function');
  });

  it('sessionIdOf and hasConversation read the panel current session, and know no other panel', async () => {
    h = createHarness([folderEntry(A)]);
    const panelId = await h.manager.initializeHost(makeFakeHost());
    const session = h.instance(panelId).session as unknown as FakeSession;

    expect(h.manager.sessionIdOf(panelId)).toBeUndefined();
    expect(h.manager.hasConversation(panelId)).toBe(false);

    session.storedId = 'sess-1';
    session.conversation = true;

    expect(h.manager.sessionIdOf(panelId)).toBe('sess-1');
    expect(h.manager.hasConversation(panelId)).toBe(true);
    expect(h.manager.sessionIdOf('host-unknown')).toBeUndefined();
    expect(h.manager.hasConversation('host-unknown')).toBe(false);
  });
});
