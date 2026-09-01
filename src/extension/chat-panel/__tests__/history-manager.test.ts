import { describe, it, expect, vi } from 'vitest';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ChatSession } from '../../chat-session';
import type { WebviewHost } from '../types';

vi.mock('../../logger', () => ({ log: vi.fn() }));

/** The replay contract as the pi loader posts it: transcript and usage, and no panel state. */
const H = vi.hoisted(() => ({
  replay: [
    { type: 'sessionCleared' },
    { type: 'userReplay', content: 'hi', isSynthetic: false, sdkMessageId: 'u1' },
    { type: 'assistantReplay', content: 'hello', contentBlocks: [] },
    { type: 'tokenUsageUpdate', inputTokens: 10, outputTokens: 5 },
    { type: 'done', data: { type: 'result', session_id: 's1', is_done: true, total_output_tokens: 5, num_turns: 1 } },
  ] as unknown as ExtensionToWebviewMessage[],
}));

vi.mock('../../pi-session/session-store', () => ({
  loadPiSessionHistory: vi.fn(async (_cwd: string, _sessionId: string, post: (m: ExtensionToWebviewMessage) => void) => {
    for (const m of H.replay) post(m);
  }),
  getPiRewindableUserIds: vi.fn(async () => []),
  getPiRewindHistory: vi.fn(async () => []),
  getPiFileCheckpointContent: vi.fn(async () => null),
}));

import { HistoryManager } from '../history-manager';

function harness(): {
  manager: HistoryManager;
  host: WebviewHost;
  session: ChatSession;
  posted: ExtensionToWebviewMessage[];
} {
  const posted: ExtensionToWebviewMessage[] = [];
  const host = { onDidDispose: () => ({ dispose: () => undefined }) } as unknown as WebviewHost;
  // Stands in for PiSession.publishAccountInfo, which emits this message through the panel's onMessage.
  const session = {
    publishAccountInfo: () => posted.push({
      type: 'accountInfo',
      data: { model: 'gpt-5.6-sol', tokenSource: 'openai-api-key', dollarBilled: true },
    }),
  } as unknown as ChatSession;
  const manager = new HistoryManager({
    workspacePath: '/ws',
    postMessage: (_h, m) => posted.push(m),
  });
  return { manager, host, session, posted };
}

/**
 * A session reopened from the picker may never run a turn, and the replay carries no panel state, so
 * the restore itself has to deliver the account chip.
 */
describe('HistoryManager.loadSessionHistory', () => {
  it('delivers account state to the restored panel with no turn', async () => {
    const { manager, host, session, posted } = harness();

    await manager.loadSessionHistory('s1', host, session);

    const account = posted.filter((m) => m.type === 'accountInfo');
    expect(account).toHaveLength(1);
    expect(account[0]).toEqual({
      type: 'accountInfo',
      data: { model: 'gpt-5.6-sol', tokenSource: 'openai-api-key', dollarBilled: true },
    });
  });

  it('delivers it after the replay, so the transcript never lands on top of it', async () => {
    const { manager, host, session, posted } = harness();

    await manager.loadSessionHistory('s1', host, session);

    const types = posted.map((m) => m.type);
    expect(types.indexOf('accountInfo')).toBeGreaterThan(types.indexOf('sessionCleared'));
    expect(types.indexOf('accountInfo')).toBeGreaterThan(types.indexOf('done'));
  });
});
