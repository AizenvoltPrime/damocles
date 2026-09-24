import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { createWorkspaceHandlers } from '../workspace-handlers';

const H = vi.hoisted(() => ({ agentFile: null as string | null }));

vi.mock('vscode', () => ({
  window: { showInformationMessage: vi.fn(), showWarningMessage: vi.fn(), showTextDocument: vi.fn() },
  workspace: { openTextDocument: vi.fn(async () => ({})) },
  Uri: { file: (p: string) => ({ fsPath: p }) },
  l10n: { t: (s: string, ...args: unknown[]) => args.reduce<string>((out, a, i) => out.replace(`{${i}}`, String(a)), s) },
}));

vi.mock('../../../../pi-session/agent-records', () => ({
  findAgentFile: vi.fn(async () => H.agentFile),
  subagentsDir: (sessionDir: string, sessionId: string) => `${sessionDir}/${sessionId}/subagents`,
}));

vi.mock('../../../../pi-session/session-store/session-dir', () => ({
  ensurePiSessionDir: (cwd: string) => `/sessions/${cwd}`,
}));

vi.mock('../../../../logger', () => ({ log: vi.fn() }));

async function openAgentLog(): Promise<void> {
  const deps = { postMessage: () => undefined } as unknown as Parameters<typeof createWorkspaceHandlers>[0];
  const ctx = { folder: { key: '/ws', fsPath: '/ws', name: 'ws', label: 'ws', projectScope: true }, session: { persistenceSessionId: 's1' }, host: {} } as never;
  await createWorkspaceHandlers(deps).openAgentLog!({ type: 'openAgentLog', agentId: 'agent-1' } as never, ctx);
}

describe('openAgentLog', () => {
  beforeEach(() => {
    vi.mocked(vscode.window.showInformationMessage).mockClear();
    vi.mocked(vscode.window.showWarningMessage).mockClear();
    vi.mocked(vscode.window.showTextDocument).mockClear();
  });

  it('an agent with no file yet gets its own message, not a "not found" warning', async () => {
    H.agentFile = null;

    await openAgentLog();

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      "This agent has no log file. A log is written only after the agent's first reply.",
    );
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it('opens the agent file when there is one', async () => {
    H.agentFile = '/sessions/ws/s1/subagents/x_agent-1.jsonl';

    await openAgentLog();

    expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1);
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });
});
