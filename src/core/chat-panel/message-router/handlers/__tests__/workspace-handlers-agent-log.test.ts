import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWorkspaceHandlers } from '../workspace-handlers';
import { createFakePlatform, type FakePlatform } from '../../../../../__mocks__/fake-platform';
import { LocalizedError } from '../../../../../shared/localized-text';

const H = vi.hoisted(() => ({ agentFile: null as string | null }));

vi.mock('../../../../pi-session/agent-records', () => ({
  findAgentFile: vi.fn(async () => H.agentFile),
  subagentsDir: (sessionDir: string, sessionId: string) => `${sessionDir}/${sessionId}/subagents`,
}));

vi.mock('../../../../pi-session/session-store/reading', () => ({
  piSessionDirOf: (cwd: string) => `/sessions/${cwd}`,
}));

vi.mock('../../../../logger', () => ({ log: vi.fn() }));

vi.mock('../../../session-file-path', () => ({ resolveSessionFilePath: vi.fn(async () => '/sessions/ws/s1.jsonl') }));

let platform: FakePlatform;

const ctx = { folder: { key: '/ws', fsPath: '/ws', name: 'ws', label: 'ws', projectScope: true }, session: { persistenceSessionId: 's1' }, host: {}, panelId: 'host-1' } as never;
const handlers = (): ReturnType<typeof createWorkspaceHandlers> => createWorkspaceHandlers({ postMessage: () => undefined, platform } as unknown as Parameters<typeof createWorkspaceHandlers>[0]);

async function openAgentLog(): Promise<void> {
  await handlers().openAgentLog!({ type: 'openAgentLog', agentId: 'agent-1' } as never, ctx);
}

const REFUSAL = { message: 'Damocles does not open {0}: it is on a network share or a device outside your projects.', args: ['\\\\server\\share\\a.jsonl'] };

describe('openAgentLog', () => {
  beforeEach(() => {
    platform = createFakePlatform();
  });

  it('an agent with no file yet gets its own message, not a "not found" warning', async () => {
    H.agentFile = null;

    await openAgentLog();

    expect(platform.notifications.calls).toEqual([
      { level: 'info', message: "This agent has no log file. A log is written once the agent receives its task.", text: { message: "This agent has no log file. A log is written once the agent receives its task." }, actions: [] },
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

  it('says the agent log could not open, with the editor\'s own reason', async () => {
    H.agentFile = '/sessions/ws/s1/subagents/x_agent-1.jsonl';
    vi.spyOn(platform.editor, 'openFile').mockRejectedValueOnce(new LocalizedError(REFUSAL));
    await openAgentLog();
    expect(platform.notifications.calls.map((call) => [call.level, call.text])).toEqual([['warn', { message: 'Could not open the agent log: {0}', args: [REFUSAL] }]]);
  });

  it('says the agent log could not open when there is no session or its folder cannot be read', async () => {
    const { findAgentFile } = await import('../../../../pi-session/agent-records');
    await handlers().openAgentLog!({ type: 'openAgentLog', agentId: 'agent-1' } as never, { ...(ctx as object), session: {} } as never);
    vi.mocked(findAgentFile).mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await openAgentLog();
    expect(platform.notifications.calls.map((call) => [call.level, call.text])).toEqual([
      ['warn', { message: 'Could not open the agent log: {0}', args: [{ message: 'No active session' }] }],
      ['warn', { message: 'Could not open the agent log: {0}', args: [{ message: '{0}', args: ['EACCES: permission denied'] }] }],
    ]);
  });

  it('keeps its own checks out of the log text', async () => {
    await expect(handlers().openAgentLog!({ type: 'openAgentLog', agentId: '../x' } as never, ctx)).rejects.toThrow('Invalid agent id');
    expect(platform.notifications.calls).toEqual([]);
  });
});

describe('openSessionLog', () => {
  beforeEach(() => {
    platform = createFakePlatform();
  });

  it('opens the session file, and says the session log could not open, with the editor\'s own reason', async () => {
    await handlers().openSessionLog!({ type: 'openSessionLog' } as never, ctx);
    expect(platform.editor.openedFiles).toEqual([{ path: '/sessions/ws/s1.jsonl', options: { editor: 'text', preview: false, panelId: 'host-1' } }]);
    vi.spyOn(platform.editor, 'openFile').mockRejectedValueOnce(new Error('the disk is gone'));
    await handlers().openSessionLog!({ type: 'openSessionLog' } as never, ctx);
    expect(platform.notifications.calls.map((call) => [call.level, call.message])).toEqual([['warn', 'Could not open the session log: the disk is gone']]);
  });
});
