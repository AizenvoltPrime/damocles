import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { Usage } from '@earendil-works/pi-ai';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { sumUsage } from '../../../shared/usage-accounting';
import { PiStreamAdapter } from '../pi-stream-adapter';
import { loadPiSessionHistory } from '../session-store/history-loader';
import { ensurePiSessionDir } from '../session-store/session-dir';

vi.mock('../../logger', () => ({ log: vi.fn() }));

/**
 * A fork's status bar totals must match live and on reload, over a real pi fork: the live adapter over a
 * real `SessionManager.open`, the reload through `loadPiSessionHistory`, both on the same file.
 */

function usage(input: number, output: number, cacheRead: number, cacheWrite: number, total: number): Usage {
  return {
    input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: total * 0.2, output: total * 0.5, cacheRead: total * 0.1, cacheWrite: total * 0.2, total },
  };
}

function assistant(stopReason: 'stop' | 'aborted' | 'toolUse', u: Usage) {
  return {
    role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: 'anthropic-messages', provider: 'anthropic',
    model: 'claude-sonnet-4-5', usage: u, stopReason, timestamp: Date.now(),
  } as never;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function liveSessionUsage(file: string, sessionDir: string): ExtensionToWebviewMessage | undefined {
  const out: ExtensionToWebviewMessage[] = [];
  const adapter = new PiStreamAdapter({
    onMessage: (m) => out.push(m),
    cwd: '/cwd',
    sessionId: () => 'SID',
    modelValue: () => 'claude-sonnet-4-5',
    defaultModelValue: () => 'claude-sonnet-4-5',
    contextWindow: () => 200_000,
    supportedModels: () => [],
    permissionMode: () => 'default',
    budgetLimit: () => null,
    sessionCost: () => 0,
    showCacheMissNotices: () => false,
    showThinkingDroppedNotices: () => false,
    onBudgetStop: () => undefined,
    onUserMessageDelivered: () => false,
    onMidStreamBatchCommitted: () => undefined,
    onTurnStateChanged: () => undefined,
  });
  let listener: ((event: unknown) => void) | undefined;
  const session = {
    sessionManager: SessionManager.open(file, sessionDir),
    subscribe: (l: (event: unknown) => void) => { listener = l; return () => undefined; },
    getLastAssistantText: () => '',
  };
  adapter.subscribe(session as never);
  adapter.beginTurn('c1');
  listener!({ type: 'agent_settled' });
  return out.find((m) => m.type === 'sessionUsage');
}

describe('fork usage parity', () => {
  it('shows a fork the same own totals live and on reload, without the entries it copied', async () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-fork-parity-')));
    made.push(cwd);
    const sessionDir = ensurePiSessionDir(cwd);

    const parent = SessionManager.create(cwd, sessionDir);
    parent.appendMessage({ role: 'user', content: 'start', timestamp: Date.now() });
    const first = parent.appendMessage(assistant('toolUse', usage(1200, 300, 8000, 2000, 0.0421)));
    parent.appendUsage('cache_warm', 'anthropic', 'claude-haiku-4-5', usage(0, 1, 30_000, 0, 0.003));
    parent.appendCompaction('summary of the start', first, 20_000, undefined, false, usage(20_000, 800, 0, 0, 0.072));
    const leaf = parent.appendMessage(assistant('stop', usage(100, 40, 12_000, 0, 0.0052)));

    await tick();
    const forkFile = SessionManager.open(parent.getSessionFile()!, sessionDir).createBranchedSession(leaf)!;
    await tick();
    const fork = SessionManager.open(forkFile, sessionDir);
    fork.appendMessage({ role: 'user', content: 'in the fork', timestamp: Date.now() });
    fork.appendMessage(assistant('aborted', usage(400, 10, 9000, 0, 0.0043)));
    fork.appendUsage('cache_warm', 'anthropic', 'claude-haiku-4-5', usage(0, 1, 12_000, 0, 0.0012));
    fork.appendMessage(assistant('stop', usage(300, 120, 15_000, 500, 0.0077)));

    const posts: ExtensionToWebviewMessage[] = [];
    await loadPiSessionHistory(cwd, fork.getSessionId(), (m) => posts.push(m));
    const reload = posts.find((m) => m.type === 'sessionUsage');
    const live = liveSessionUsage(forkFile, sessionDir);

    expect(live).toEqual(reload);
    expect(reload).toEqual({
      type: 'sessionUsage',
      usage: { totalInputTokens: 700, totalOutputTokens: 131, cacheReadTokens: 36_000, cacheCreationTokens: 500, costUsd: expect.closeTo(0.0043 + 0.0012 + 0.0077, 12) },
      numTurns: 1,
    });
    // The fork file holds the copied parent spend too, so counting it would show.
    expect(sumUsage(SessionManager.open(forkFile, sessionDir).getEntries()).cost).toBeGreaterThan(0.1);
  });
});
