import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import * as pi from '@earendil-works/pi-coding-agent';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import { panelSession } from './real-pi-fixtures';
import { withRepoLock } from '../checkpoints/lock';
import { folderIdFor, getFolderRepoDir, getGitDir, type CheckpointEntryV3 } from '../checkpoints';

vi.mock('../../logger', () => ({ log: vi.fn() }));

type Message = Parameters<SessionManager['appendMessage']>[0];
const user = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }) as Message;

function checkpoint(userEntryId: string, folderId: string): CheckpointEntryV3 {
  return {
    v: 3,
    kind: 'checkpoint',
    turnId: 'turn-1',
    userEntryId,
    beforeCommit: 'a'.repeat(40),
    afterCommit: 'b'.repeat(40),
    prompt: 'first',
    fileCount: 0,
    fileChanges: [],
    createdAt: new Date().toISOString(),
    repo: 'folder',
    folderId,
    skipped: { totalCount: 0, totalBytes: 0, byReason: {}, patterns: [], manifest: null },
  };
}

describe('forking a conversation whose checkpoints live in a busy folder repo', () => {
  // Another conversation's first baseline of a large folder holds the folder lock for minutes; the user is waiting on the fork.
  it('records the pending copy and does not wait for the folder lock before the fork opens', async () => {
    const folderId = folderIdFor(path.join(os.tmpdir(), 'dam-fork-refs-folder'));
    const repoDir = getFolderRepoDir(folderId);
    fs.mkdirSync(getGitDir(repoDir), { recursive: true });
    fs.writeFileSync(path.join(getGitDir(repoDir), 'HEAD'), 'ref: refs/heads/main\n');
    const source = pi.SessionManager.inMemory('/cwd');
    const u1 = source.appendMessage(user('first'));
    source.appendCustomEntry('damocles-checkpoint', checkpoint(u1, folderId));
    const panel = panelSession([]) as unknown as {
      carryCheckpointsToFork(p: typeof pi, sm: SessionManager, leaf: string, branchedPath: string, childId: string): Promise<void>;
    };

    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => { lockHeld = resolve; });
    let release!: () => void;
    const holding = withRepoLock(repoDir, () => {
      lockHeld();
      return new Promise<void>((resolve) => { release = resolve; });
    });
    await held;
    try {
      const branchedPath = path.join(os.tmpdir(), 'dam-fork-branched.jsonl');
      await panel.carryCheckpointsToFork(pi, source, source.getLeafId()!, branchedPath, 'fork-child');
      expect(JSON.parse(fs.readFileSync(path.join(repoDir, 'sessions', 'fork-child.json'), 'utf8'))).toEqual({ sessionFile: branchedPath, pendingCopy: true });
    } finally {
      release();
      await holding;
      // Queued behind the copy, so the copy has finished once this holds the lock.
      await withRepoLock(repoDir, async () => undefined);
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
