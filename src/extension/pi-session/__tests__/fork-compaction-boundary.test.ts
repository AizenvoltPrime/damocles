import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';
import { initPiLoader, getPiCodingAgent } from '../pi-loader';
import { latestCompactionEntryId } from '../pi-stream-adapter';

/**
 * pi 0.85.0 fixed session forks losing their compaction boundary. Damocles depends on that directly:
 * `latestCompactionEntryId` scans the forked branch for the compaction entry, and the boundary card
 * offers rewind-to-before-compaction by branching the tree at that entry's PARENT. A fork that dropped
 * the entry would render a boundary card with no `entryId`, silently removing the rewind.
 *
 * Driven against the real installed `SessionManager` and the real scan, not a fake of either.
 */
describe('a forked session keeps its compaction boundary', () => {
  const made: string[] = [];

  afterEach(() => {
    for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const user = (content: string): Parameters<SessionManager['appendMessage']>[0] =>
    ({ role: 'user', content, timestamp: Date.now() } as Parameters<SessionManager['appendMessage']>[0]);

  const assistant = (text: string): Parameters<SessionManager['appendMessage']>[0] => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'test-model',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  } as Parameters<SessionManager['appendMessage']>[0]);

  /** `latestCompactionEntryId` reads only `session.sessionManager`, so a manager is the whole input. */
  const scan = (sessionManager: SessionManager): string | null =>
    latestCompactionEntryId({ sessionManager } as unknown as AgentSession);

  it('the fork resolves the same compaction entry, and its parent is the pre-compaction message', async () => {
    await initPiLoader();
    const pi = getPiCodingAgent();
    if (!pi) throw new Error('pi coding-agent failed to load');

    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-fork-')));
    made.push(workspace);
    const sessionDir = path.join(workspace, 'sessions');
    fs.mkdirSync(sessionDir);

    // A branch that straddles a compaction: two messages, the boundary, then two more.
    const source = pi.SessionManager.create(workspace, sessionDir);
    source.appendMessage(user('before compaction'));
    const lastBeforeCompaction = source.appendMessage(assistant('reply before compaction'));
    const compactionId = source.appendCompaction('summary text', lastBeforeCompaction, 1234);
    source.appendMessage(user('after compaction'));
    const leaf = source.appendMessage(assistant('reply after compaction'));

    expect(scan(source)).toBe(compactionId);

    const sourceFile = source.getSessionFile();
    if (!sourceFile) throw new Error('source session was never written to disk');

    // Mirrors `PiSession`'s fork: branch on a fresh manager reading the source file.
    const branchSm = pi.SessionManager.open(sourceFile, sessionDir);
    const forkedPath = branchSm.createBranchedSession(leaf);
    expect(forkedPath).toBeTruthy();

    const fork = pi.SessionManager.open(forkedPath as string, sessionDir);

    // The boundary card gets an `entryId` in the fork, so it renders as a rewind control at all.
    const forkCompactionId = scan(fork);
    expect(forkCompactionId).toBe(compactionId);

    // Rewind-to-before-compaction branches at the entry's parent, so that parent has to be the last
    // message from before the boundary. A fork that reparented the entry would break the rewind while
    // still resolving an id, so the id alone is not enough to assert.
    const rewindTarget = fork.getEntry(forkCompactionId as string)?.parentId;
    expect(rewindTarget).toBe(lastBeforeCompaction);
    expect(fork.getBranch(rewindTarget as string).at(-1)?.id).toBe(lastBeforeCompaction);
  }, 30_000);
});
