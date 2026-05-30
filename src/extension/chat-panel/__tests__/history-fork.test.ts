import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClaudeSessionEntry } from '../../session/types';

vi.mock('../../logger', () => ({ log: vi.fn() }));

const mockReadSessionForDisplay = vi.fn();

vi.mock('../../session', () => ({
  readSessionForDisplay: (...args: unknown[]) => mockReadSessionForDisplay(...args),
  compactCancelledTurns: vi.fn().mockResolvedValue(undefined),
  readActiveBranchEntries: vi.fn(),
  readAgentData: vi.fn().mockResolvedValue({ messages: [], toolCalls: [], totalToolUseCount: 0 }),
  findUserTextBlock: (blocks: Array<{ type: string; text?: string }>) =>
    blocks.find(b => b.type === 'text') as { type: 'text'; text: string } | undefined,
  findUserImageBlocks: () => [],
}));

vi.mock('../../skills/utils', () => ({ loadSkillDescription: vi.fn().mockResolvedValue(null) }));

vi.mock('../../claude-session/utils', () => ({
  normalizeToolResult: (_n: string, r: string) => r,
  TOOL_METADATA_REGISTRY: new Map(),
  enrichResultWithDownloadedFiles: async (r: string) => r,
}));

import { HistoryManager } from '../history-manager';
import type { WebviewHost } from '../types';

function makeUserEntry(uuid: string, text: string, ts: string): ClaudeSessionEntry {
  return {
    type: 'user',
    uuid,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as ClaudeSessionEntry;
}

function makeHostStub(): { host: WebviewHost; messages: Array<{ type: string }> } {
  const messages: Array<{ type: string }> = [];
  const host = {
    webview: { postMessage: () => true },
    visible: true,
    active: true,
    onDidDispose: () => ({ dispose: () => {} }),
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidChangeActive: () => ({ dispose: () => {} }),
    close: () => {},
  } as unknown as WebviewHost;
  return { host, messages };
}

describe('HistoryManager.loadSessionHistoryUntil boundary cases', () => {
  let hm: HistoryManager;
  let host: WebviewHost;
  let messages: Array<{ type: string }>;

  beforeEach(() => {
    const stub = makeHostStub();
    host = stub.host;
    messages = stub.messages;
    hm = new HistoryManager({
      workspacePath: '/cwd',
      postMessage: (_h, msg) => { messages.push(msg); },
    });
    mockReadSessionForDisplay.mockReset();
  });

  it('untilUuid=null: replays nothing, only sessionCleared posted', async () => {
    await hm.loadSessionHistoryUntil('session-1', host, null);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe('sessionCleared');
    expect(mockReadSessionForDisplay).not.toHaveBeenCalled();
  });

  it('untilUuid points at first entry: zero replay messages', async () => {
    const entries: ClaudeSessionEntry[] = [
      makeUserEntry('u-1', 'msg1', '2024-01-01T00:00:00Z'),
      makeUserEntry('u-2', 'msg2', '2024-01-01T00:01:00Z'),
      makeUserEntry('u-3', 'msg3', '2024-01-01T00:02:00Z'),
    ];
    mockReadSessionForDisplay.mockResolvedValueOnce({ entries });

    await hm.loadSessionHistoryUntil('session-1', host, 'u-1');

    const replays = messages.filter(m => m.type === 'userReplay');
    expect(replays).toHaveLength(0);
  });

  it('untilUuid points at middle entry: replays only entries before it', async () => {
    const entries: ClaudeSessionEntry[] = [
      makeUserEntry('u-1', 'msg1', '2024-01-01T00:00:00Z'),
      makeUserEntry('u-2', 'msg2', '2024-01-01T00:01:00Z'),
      makeUserEntry('u-3', 'msg3', '2024-01-01T00:02:00Z'),
      makeUserEntry('u-4', 'msg4', '2024-01-01T00:03:00Z'),
      makeUserEntry('u-5', 'msg5', '2024-01-01T00:04:00Z'),
    ];
    mockReadSessionForDisplay.mockResolvedValueOnce({ entries });

    await hm.loadSessionHistoryUntil('session-1', host, 'u-3');

    const replays = messages.filter(m => m.type === 'userReplay');
    expect(replays).toHaveLength(2);
  });

  it('untilUuid points at last entry: replays all but last', async () => {
    const entries: ClaudeSessionEntry[] = [
      makeUserEntry('u-1', 'msg1', '2024-01-01T00:00:00Z'),
      makeUserEntry('u-2', 'msg2', '2024-01-01T00:01:00Z'),
      makeUserEntry('u-3', 'msg3', '2024-01-01T00:02:00Z'),
      makeUserEntry('u-4', 'msg4', '2024-01-01T00:03:00Z'),
      makeUserEntry('u-5', 'msg5', '2024-01-01T00:04:00Z'),
    ];
    mockReadSessionForDisplay.mockResolvedValueOnce({ entries });

    await hm.loadSessionHistoryUntil('session-1', host, 'u-5');

    const replays = messages.filter(m => m.type === 'userReplay');
    expect(replays).toHaveLength(4);
  });

  it('untilUuid not found: replays full session as defensive fallback', async () => {
    const entries: ClaudeSessionEntry[] = [
      makeUserEntry('u-1', 'msg1', '2024-01-01T00:00:00Z'),
      makeUserEntry('u-2', 'msg2', '2024-01-01T00:01:00Z'),
      makeUserEntry('u-3', 'msg3', '2024-01-01T00:02:00Z'),
    ];
    mockReadSessionForDisplay.mockResolvedValueOnce({ entries });

    await hm.loadSessionHistoryUntil('session-1', host, 'nonexistent');

    const replays = messages.filter(m => m.type === 'userReplay');
    expect(replays).toHaveLength(3);
  });
});
