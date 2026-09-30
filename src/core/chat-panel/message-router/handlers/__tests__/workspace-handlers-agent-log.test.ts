import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorkspaceHandlers } from '../workspace-handlers';
import { createFakePlatform, type FakePlatform } from '../../../../../__mocks__/fake-platform';

const H = vi.hoisted(() => ({ agentFile: null as string | null }));

vi.mock('../../../../pi-session/agent-records', () => ({
  findAgentFile: vi.fn(async () => H.agentFile),
  subagentsDir: (sessionDir: string, sessionId: string) => `${sessionDir}/${sessionId}/subagents`,
}));

vi.mock('../../../../pi-session/session-store/session-dir', () => ({
  ensurePiSessionDir: (cwd: string) => `/sessions/${cwd}`,
}));

vi.mock('../../../../logger', () => ({ log: vi.fn() }));

let platform: FakePlatform;

async function openAgentLog(): Promise<void> {
  const deps = { postMessage: () => undefined, platform } as unknown as Parameters<typeof createWorkspaceHandlers>[0];
  const ctx = { folder: { key: '/ws', fsPath: '/ws', name: 'ws', label: 'ws', projectScope: true }, session: { persistenceSessionId: 's1' }, host: {}, panelId: 'host-1' } as never;
  await createWorkspaceHandlers(deps).openAgentLog!({ type: 'openAgentLog', agentId: 'agent-1' } as never, ctx);
}

describe('openAgentLog', () => {
  beforeEach(() => {
    platform = createFakePlatform();
  });

  it('an agent with no file yet gets its own message, not a "not found" warning', async () => {
    H.agentFile = null;

    await openAgentLog();

    expect(platform.notifications.calls).toEqual([
      { level: 'info', message: "This agent has no log file. A log is written only after the agent's first reply.", actions: [] },
    ]);
    expect(platform.editor.openedFiles).toEqual([]);
  });

  it('opens the agent file when there is one', async () => {
    H.agentFile = '/sessions/ws/s1/subagents/x_agent-1.jsonl';

    await openAgentLog();

    expect(platform.editor.openedFiles).toEqual([
      { path: '/sessions/ws/s1/subagents/x_agent-1.jsonl', options: { editor: 'text', preview: false, panelId: 'host-1' } },
    ]);
    expect(platform.notifications.calls).toEqual([]);
  });
});
