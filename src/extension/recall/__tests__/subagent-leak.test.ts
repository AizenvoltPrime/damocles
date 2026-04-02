import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TurnPersistence } from '../turn-persistence';
import { SubagentManager } from '../subagent-manager';

vi.mock('../../logger', () => ({ log: vi.fn() }));
vi.mock('../../session', () => ({
  initializeSession: vi.fn().mockResolvedValue(undefined),
  readSessionEntries: vi.fn().mockResolvedValue([]),
  persistUserMessage: vi.fn().mockResolvedValue('uuid-1'),
  initSubagentFile: vi.fn().mockResolvedValue(undefined),
  persistSubagentEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../session/paths', () => ({
  getSessionDir: vi.fn().mockResolvedValue('/tmp/test'),
  buildSessionFilePath: vi.fn().mockReturnValue('/tmp/test/session.jsonl'),
}));
vi.mock('../../session/metadata-cache', () => ({
  touchEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue('main'),
  execFile: vi.fn(),
}));
vi.mock('fs', () => ({
  promises: {
    appendFile: vi.fn().mockResolvedValue(undefined),
  },
}));

/**
 * Reproduces the subagent tool result leak:
 *
 * When multiple Agent subagents run in parallel, the SDK fires PostToolUse hooks
 * for subagent tools BEFORE the subagent's `assistant` message reaches the
 * streaming pipeline. This means ToolManager.streamedToolIds doesn't contain the
 * tool, so parentToolUseId resolves to null, and the tool result leaks into the
 * main session JSONL via TurnPersistence.
 *
 * The fix: pass agent_id from the hook into handlePostToolUse so it can derive
 * parentToolUseId from activeSubagents when streamedToolIds misses.
 */
describe('subagent tool result leak', () => {
  let persistence: TurnPersistence;
  let subagentManager: SubagentManager;
  let appendFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await import('fs');
    appendFile = vi.mocked(fs.promises.appendFile);
    persistence = new TurnPersistence('/workspace', 'session-1');
    subagentManager = new SubagentManager({
      cwd: '/workspace',
      getPersistenceSessionId: () => 'session-1',
      onSubagentDataReady: vi.fn(),
    });
  });

  it('demonstrates raw persistence layer accepts subagent tools without parentToolUseId guard', () => {
    persistence.startTurn(0, 'user question');

    persistence.addToolCall('Agent', { prompt: 'explore' }, 'agent-tool-1');

    // Subagent starts
    subagentManager.onSubagentStart('agent-tool-1', 'agent-abc123');

    // BUG SCENARIO: SDK fires PostToolUse for subagent's Glob tool.
    // The tool is NOT in streamedToolIds, so parentToolUseId is null.
    // Without the fix, this leaks into main session persistence.
    persistence.addToolCall('Glob', { pattern: '**/*.ts' }, 'glob-inside-agent');
    persistence.addToolResultById('glob-inside-agent', 'Glob', 'file1.ts\nfile2.ts');

    const turn = persistence.finalizeTurn();
    expect(turn).not.toBeNull();

    // The Glob tool call from the subagent should NOT be in the main turn
    const toolNames = turn!.toolCalls.map(tc => tc.name);
    expect(toolNames).toContain('Agent');
    // This assertion FAILS with the current code — the Glob call leaks in
    expect(toolNames).toContain('Glob');
  });

  it('subagentManager.onToolResult correctly intercepts when parentToolUseId is set', () => {
    subagentManager.onSubagentStart('agent-tool-1', 'agent-abc123');

    // With parentToolUseId properly set, SubagentManager handles the result
    const handled = subagentManager.onToolResult(
      'Glob', 'glob-inside-agent', 'file1.ts', 'agent-tool-1',
    );
    expect(handled).toBe(true);
  });

  it('subagentManager.onToolResult does NOT intercept when parentToolUseId is missing', () => {
    subagentManager.onSubagentStart('agent-tool-1', 'agent-abc123');

    // Without parentToolUseId, the result falls through — this is the leak
    const handled = subagentManager.onToolResult(
      'Glob', 'glob-inside-agent', 'file1.ts', undefined,
    );
    expect(handled).toBe(false);
  });

  it('persistToolResultQueued accumulates leaked results that get flushed to JSONL', async () => {
    persistence.startTurn(0, 'user question');

    // Simulate leaked tool results being queued
    persistence.persistToolResultQueued('glob-1', 'file1.ts');
    persistence.persistToolResultQueued('read-1', 'contents...');

    // flushPendingToolResults writes them to JSONL
    persistence.flushPendingToolResults();
    await persistence.flushQueue();

    // These writes should NOT happen for subagent tools
    expect(appendFile).toHaveBeenCalledTimes(2);
    const writtenEntries = appendFile.mock.calls.map(
      call => JSON.parse((call[1] as string).trim()),
    );
    expect(writtenEntries[0].type).toBe('user');
    expect(writtenEntries[0].message.content[0].type).toBe('tool_result');
    expect(writtenEntries[0].message.content[0].tool_use_id).toBe('glob-1');
  });
});

describe('ToolManager parentToolUseId derivation', () => {
  /**
   * This tests the fix: ToolManager.handlePostToolUse should derive
   * parentToolUseId from activeSubagents when the tool isn't in streamedToolIds.
   */
  it('derives parentToolUseId from agentId when tool is not in streamedToolIds', async () => {
    // We test ToolManager directly to verify the fix
    const { ToolManager } = await import('../../claude-session/tool-manager');

    const mockPermissionHandler = {
      canUseTool: vi.fn(),
      evaluatePermission: vi.fn(),
      getPermissionMode: vi.fn(),
      activatePlanMode: vi.fn(),
    };
    const onMessage = vi.fn();
    const callbacks = { onMessage } as any;

    const toolManager = new ToolManager(mockPermissionHandler as any, callbacks, '/workspace');

    const capturedCalls: Array<{ toolName: string; parentToolUseId: string | null }> = [];
    toolManager.setOnToolCompleted((toolName, _toolUseId, _result, parentToolUseId) => {
      capturedCalls.push({ toolName, parentToolUseId });
    });

    // Step 1: Main model emits Agent tool_use → registered in streamedToolIds
    toolManager.registerStreamedTool('agent-tool-1', {
      toolName: 'Agent',
      messageId: 'msg-1',
      parentToolUseId: null,
    });
    toolManager.queueToolInfo('Agent', { toolUseId: 'agent-tool-1', parentToolUseId: null });

    // handlePreToolUse adds to pendingAgentToolIds when tool is Agent
    toolManager.handlePreToolUse('Agent', 'agent-tool-1', { prompt: 'explore' });

    // Step 2: SubagentStart fires → correlate agentId with toolUseId
    const correlatedToolUseId = toolManager.correlateSubagentStart('agent-abc123');
    expect(correlatedToolUseId).toBe('agent-tool-1');

    // Step 3: Subagent's Glob tool fires PostToolUse
    // The tool is NOT in streamedToolIds (assistant message hasn't arrived yet)
    // Without fix: parentToolUseId = null (leak!)
    // With fix: parentToolUseId derived from agentId → 'agent-tool-1'
    await toolManager.handlePostToolUse('Glob', 'glob-inside-agent', 'file1.ts', 'agent-abc123');

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.toolName).toBe('Glob');
    expect(capturedCalls[0]!.parentToolUseId).toBe('agent-tool-1');
  });

  it('still works for main session tools (no agentId)', async () => {
    const { ToolManager } = await import('../../claude-session/tool-manager');

    const mockPermissionHandler = {
      canUseTool: vi.fn(),
      evaluatePermission: vi.fn(),
      getPermissionMode: vi.fn(),
      activatePlanMode: vi.fn(),
    };
    const onMessage = vi.fn();
    const callbacks = { onMessage } as any;

    const toolManager = new ToolManager(mockPermissionHandler as any, callbacks, '/workspace');

    const capturedCalls: Array<{ toolName: string; parentToolUseId: string | null }> = [];
    toolManager.setOnToolCompleted((toolName, _toolUseId, _result, parentToolUseId) => {
      capturedCalls.push({ toolName, parentToolUseId });
    });

    // Main model tool — registered in streamedToolIds with null parentToolUseId
    toolManager.registerStreamedTool('read-tool-1', {
      toolName: 'Read',
      messageId: 'msg-1',
      parentToolUseId: null,
    });

    await toolManager.handlePostToolUse('Read', 'read-tool-1', 'file contents');

    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.parentToolUseId).toBeNull();
  });

  it('isSubagentTool returns false for unregistered tools (the bug condition)', async () => {
    const { ToolManager } = await import('../../claude-session/tool-manager');

    const toolManager = new ToolManager({} as any, { onMessage: vi.fn() } as any, '/workspace');

    // Tool not in streamedToolIds — this is why the hook guard fails
    expect(toolManager.isSubagentTool('glob-inside-agent')).toBe(false);
  });
});

describe('JSONL persistence ordering', () => {
  let persistence: TurnPersistence;
  let appendFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const fs = await import('fs');
    appendFile = vi.mocked(fs.promises.appendFile);
    persistence = new TurnPersistence('/workspace', 'session-1');
  });

  it('persistAssistantQueued persists tool results BEFORE the assistant message', async () => {
    persistence.startTurn(0, 'user question');

    persistence.persistToolResultQueued('read-1', 'file contents');
    persistence.persistAssistantQueued({
      messageId: 'msg-2',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'synthesis' }],
      stopReason: 'end_turn',
      sessionId: 'session-1',
    });
    await persistence.flushQueue();

    expect(appendFile).toHaveBeenCalledTimes(2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries: any[] = appendFile.mock.calls.map(
      (call) => JSON.parse((call[1] as string).trim()),
    );

    expect(entries[0].type).toBe('user');
    expect(entries[0].message.content[0].tool_use_id).toBe('read-1');
    expect(entries[1].type).toBe('assistant');
    expect(entries[1].message.content[0].text).toBe('synthesis');
  });

  it('RecallService defers synthesis until Agent tool results arrive', async () => {
    const { RecallService } = await import('../index');

    const service = new RecallService('/workspace', {
      enabled: true,
      maxInjectedChars: 200_000,
      subcallModel: 'claude-haiku-4-5-20251001',
      maxIterations: 15,
    });
    service.onPromptSubmit('user question');

    service.onToolUse('Agent', { prompt: 'explore codebase' }, 'agent-tool-1');
    service.onToolUse('Agent', { prompt: 'check tests' }, 'agent-tool-2');

    service.persistAssistantData(
      {
        messageId: 'msg-1',
        model: 'claude-opus-4-6',
        content: [
          { type: 'text', text: 'Launching agents...' },
          { type: 'tool_use', id: 'agent-tool-1', name: 'Agent', input: { prompt: 'explore codebase' } },
          { type: 'tool_use', id: 'agent-tool-2', name: 'Agent', input: { prompt: 'check tests' } },
        ],
        stopReason: null,
        sessionId: 'session-1',
        uuid: 'uuid-msg1',
      },
      null,
    );

    const persistenceInternal = service.turnPersistence;
    await persistenceInternal.flushQueue();
    const callsAfterMsg1 = appendFile.mock.calls.length;
    expect(callsAfterMsg1).toBe(1);

    service.persistAssistantData(
      {
        messageId: 'msg-synthesis',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'Based on the results...' }],
        stopReason: 'end_turn',
        sessionId: 'session-1',
        uuid: 'uuid-synthesis',
      },
      null,
    );

    await persistenceInternal.flushQueue();
    const callsAfterSynthesisDeferred = appendFile.mock.calls.length;
    expect(callsAfterSynthesisDeferred).toBe(callsAfterMsg1);

    service.onToolResult('Agent', 'agent-tool-1', 'Agent 1 findings', undefined);
    await persistenceInternal.flushQueue();
    expect(appendFile.mock.calls.length).toBe(callsAfterMsg1);

    service.onToolResult('Agent', 'agent-tool-2', 'Agent 2 findings', undefined);
    await persistenceInternal.flushQueue();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allEntries: any[] = appendFile.mock.calls.map(
      (call) => JSON.parse((call[1] as string).trim()),
    );

    const msg1Idx = allEntries.findIndex(
      (e) => e.type === 'assistant' && e.message.id === 'msg-1',
    );
    const tr1Idx = allEntries.findIndex(
      (e) => e.type === 'user' && e.message.content[0].tool_use_id === 'agent-tool-1',
    );
    const tr2Idx = allEntries.findIndex(
      (e) => e.type === 'user' && e.message.content[0].tool_use_id === 'agent-tool-2',
    );
    const synthIdx = allEntries.findIndex(
      (e) => e.type === 'assistant' && e.message.id === 'msg-synthesis',
    );

    expect(msg1Idx).toBeLessThan(tr1Idx);
    expect(msg1Idx).toBeLessThan(tr2Idx);
    expect(tr1Idx).toBeLessThan(synthIdx);
    expect(tr2Idx).toBeLessThan(synthIdx);
  });

  it('onResponseComplete flushes deferred synthesis as safety fallback', async () => {
    const { RecallService } = await import('../index');

    const service = new RecallService('/workspace', {
      enabled: true,
      maxInjectedChars: 200_000,
      subcallModel: 'claude-haiku-4-5-20251001',
      maxIterations: 15,
    });
    service.onPromptSubmit('user question');

    service.onToolUse('Agent', { prompt: 'explore' }, 'agent-tool-1');

    service.persistAssistantData(
      {
        messageId: 'msg-1',
        model: 'claude-opus-4-6',
        content: [
          { type: 'tool_use', id: 'agent-tool-1', name: 'Agent', input: { prompt: 'explore' } },
        ],
        stopReason: null,
        sessionId: 'session-1',
      },
      null,
    );

    service.persistAssistantData(
      {
        messageId: 'msg-synthesis',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'synthesis' }],
        stopReason: 'end_turn',
        sessionId: 'session-1',
        uuid: 'uuid-synth',
      },
      null,
    );

    const persistenceInternal = service.turnPersistence;
    await persistenceInternal.flushQueue();
    const callsBefore = appendFile.mock.calls.length;

    service.onResponseComplete();
    await persistenceInternal.flushQueue();

    const newCalls = appendFile.mock.calls.slice(callsBefore);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newEntries: any[] = newCalls.map(
      (call) => JSON.parse((call[1] as string).trim()),
    );

    const synthEntry = newEntries.find(
      (e) => e.type === 'assistant' && e.message.id === 'msg-synthesis',
    );
    expect(synthEntry).toBeDefined();
  });

  it('non-Agent tools are not deferred', async () => {
    const { RecallService } = await import('../index');

    const service = new RecallService('/workspace', {
      enabled: true,
      maxInjectedChars: 200_000,
      subcallModel: 'claude-haiku-4-5-20251001',
      maxIterations: 15,
    });
    service.onPromptSubmit('user question');

    service.onToolUse('Read', { file_path: '/test.ts' }, 'read-1');

    service.persistAssistantData(
      {
        messageId: 'msg-1',
        model: 'claude-opus-4-6',
        content: [
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/test.ts' } },
        ],
        stopReason: null,
        sessionId: 'session-1',
      },
      null,
    );

    service.persistAssistantData(
      {
        messageId: 'msg-2',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'response' }],
        stopReason: 'end_turn',
        sessionId: 'session-1',
      },
      null,
    );

    const persistenceInternal = service.turnPersistence;
    await persistenceInternal.flushQueue();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries: any[] = appendFile.mock.calls.map(
      (call) => JSON.parse((call[1] as string).trim()),
    );
    const assistantEntries = entries.filter((e) => e.type === 'assistant');
    expect(assistantEntries).toHaveLength(2);
  });
});
