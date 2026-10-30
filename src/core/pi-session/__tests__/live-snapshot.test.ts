// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { TOOL_OUTPUT_COALESCE_MS } from '../tool-output-coalescer';
import { AgentManager, type SubagentEngine } from '../subagents/agent-manager';
import { AgentRegistry } from '../subagents/agent-types';
import { buildNestedMcpToolset } from '../tools/mcp-tools';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import type { PiCodingAgentModule } from '../pi-loader';
import type { McpResourceRuleFilter } from '../../permission-handler/mcp-resource-rule';
import { HistoryManager } from '../../chat-panel/history-manager';
import { FakeSession } from '../../team/__tests__/fake-session';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { AT_GATE, BASH, cardsOf, chatPage, fakeSession, joinMessages, liveChatSession, makeAdapter, promptEntryIds, PROMPT, TURN, watching, type FakeSession as ChatFakeSession, type Shown, type Turn } from './live-chat-page';

vi.mock('../../logger', () => ({ log: vi.fn() }));

describe('PiStreamAdapter.liveSnapshot', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const play = (session: ChatFakeSession, events: readonly unknown[]): void => {
    for (const event of events) {
      session.emit(event);
      vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS);
    }
  };

  /** A view that watched the turn from its start, and its stores after each event. */
  function watchedTurn(events: readonly unknown[]): Shown[] {
    const out: ExtensionToWebviewMessage[] = [];
    const watcher = makeAdapter(out);
    const session = fakeSession();
    watcher.subscribe(session as never);
    watcher.beginTurn('c', { message: PROMPT, text: null });
    const page = watching(out);
    let delivered = out.length;
    const steps = [page.shown()];
    for (const event of events) {
      play(session, [event]);
      page.deliver(out.slice(delivered));
      delivered = out.length;
      steps.push(page.shown());
    }
    return steps;
  }

  it('a view that joins at any point of a turn ends with the stores of one that watched it all, step by step', async () => {
    const watched = watchedTurn(TURN);
    for (let joinAt = 0; joinAt <= TURN.length; joinAt++) {
      const out: ExtensionToWebviewMessage[] = [];
      const adapter = makeAdapter(out);
      const session = fakeSession();
      adapter.subscribe(session as never);
      adapter.beginTurn('c', { message: PROMPT, text: null });
      play(session, TURN.slice(0, joinAt));
      const { seq, messages } = await joinMessages(adapter, session);
      expect(seq).toBe(out.length);
      const page = chatPage();
      page.deliver(messages);
      expect(page.shown(), `joined after event ${joinAt}`).toEqual(watched[joinAt]);
      let delivered = seq;
      for (let next = joinAt; next < TURN.length; next++) {
        play(session, [TURN[next]]);
        page.deliver(out.slice(delivered));
        delivered = out.length;
        expect(page.shown(), `joined after event ${joinAt}, at event ${next + 1}`).toEqual(watched[next + 1]);
      }
      expect(promptEntryIds(page), `joined after event ${joinAt}`).toEqual(['u-entry']);
    }
  });

  it('shows a joining view the running shell call with its output and Stop, the ended call pi has not stored and the streaming answer', async () => {
    const shownAt = async (events: readonly unknown[]): Promise<Shown> => {
      const adapter = makeAdapter([]);
      const session = fakeSession();
      adapter.subscribe(session as never);
      adapter.beginTurn('c', { message: PROMPT, text: null });
      play(session, events);
      const page = chatPage();
      page.deliver((await joinMessages(adapter, session)).messages);
      return page.shown();
    };
    const readEnded = TURN.findIndex((event) => (event as { type: string; toolCallId?: string }).type === 'tool_execution_end') + 1;
    const midShell = await shownAt(TURN.slice(0, readEnded + 1));
    expect(cardsOf(midShell)).toEqual([
      { id: 'b1', name: 'Bash', status: 'running', output: 'line 1\nline 2\n' },
      { id: 'r1', name: 'Read', status: 'failed', outcome: 'not found', metadata: { path: 'a.ts' } },
    ]);
    // the status bar names the shell call and counts from the turn's start, one coalescing step per event played
    expect(midShell.statusBar).toEqual({ tool: 'Bash', turnElapsedMs: (readEnded + 1) * TOOL_OUTPUT_COALESCE_MS });
    const answering = TURN.length - 2;
    expect((await shownAt(TURN.slice(0, answering))).transcript.at(-1)).toEqual({ role: 'assistant', content: 'All good' });
  });

  it('a view that joins while a call waits for approval shows its prompt and card as one that watched', async () => {
    const PERMISSION: ExtensionToWebviewMessage = { type: 'requestPermission', toolUseId: 'b1', toolName: 'Bash', toolInput: BASH.arguments, command: 'npm test', owner: { kind: 'main' } };
    const watchedOut: ExtensionToWebviewMessage[] = [];
    const watcher = makeAdapter(watchedOut);
    const watcherSession = fakeSession();
    watcher.subscribe(watcherSession as never);
    watcher.beginTurn('c', { message: PROMPT, text: null });
    play(watcherSession, TURN.slice(0, AT_GATE));
    // the permission handler's prompt, which a joining view gets again from `repostPendingPrompts` once the live events are delivered
    watchedOut.push(PERMISSION);
    const watched = watching(watchedOut);

    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession();
    adapter.subscribe(session as never);
    adapter.beginTurn('c', { message: PROMPT, text: null });
    play(session, TURN.slice(0, AT_GATE));
    const page = chatPage();
    page.deliver([...(await joinMessages(adapter, session)).messages, PERMISSION]);
    expect(page.shown()).toEqual(watched.shown());
    expect(cardsOf(page.shown()).find((c) => c.id === 'b1')?.status).toBe('awaiting_approval');
    expect(page.shown().prompts).toEqual(['b1']);
  });

  it('a view that joins while a team runs shows its card running, as one that watched', async () => {
    const TEAM = { type: 'toolCall', id: 't1', name: 'create_team', arguments: { title: 'Ship it', agents: [{ name: 'lead', role: 'lead' }] } };
    const TEAM_TURN: unknown[] = [
      ...TURN.slice(0, 3),
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: TEAM } },
      { type: 'message_end', message: { role: 'assistant', content: [TEAM], stopReason: 'toolUse' } },
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'create_team', args: TEAM.arguments },
    ];
    const watched = watchedTurn(TEAM_TURN).at(-1);
    const adapter = makeAdapter([]);
    const session = fakeSession();
    adapter.subscribe(session as never);
    adapter.beginTurn('c', { message: PROMPT, text: null });
    play(session, TEAM_TURN);
    const page = chatPage();
    page.deliver((await joinMessages(adapter, session)).messages);
    expect(page.shown()).toEqual(watched);
    expect(page.shown().teams).toEqual([{ toolUseId: 't1', status: 'running' }]);
  });

  it('keeps a stored call no run owns unrecorded on a join, whatever message names it later', async () => {
    const OLD = { type: 'toolCall', id: 'old', name: 'bash', arguments: { command: 'sleep 9' } };
    const earlier = [
      { type: 'message', id: 'u-old', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'before' }] } },
      { type: 'message', id: 'a-old', parentId: 'u-old', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'assistant', content: [OLD], stopReason: 'toolUse' } },
    ] as unknown as SessionEntry[];
    const adapter = makeAdapter([]);
    const session = fakeSession(earlier);
    adapter.subscribe(session as never);
    adapter.beginTurn('c', { message: PROMPT, text: null });
    play(session, TURN.slice(0, AT_GATE));
    const page = chatPage();
    page.deliver((await joinMessages(adapter, session)).messages);
    page.deliver([{ type: 'toolPending', toolUseId: 'old', toolName: 'Bash', input: OLD.arguments, parentToolUseId: null }]);
    expect(cardsOf(page.shown()).map((c) => [c.id, c.status])).toEqual([['old', 'unrecorded'], ['b1', 'running'], ['r1', 'pending']]);
  });

  it('numbers every emitted message and holds nothing once the turn settled', () => {
    const out: ExtensionToWebviewMessage[] = [];
    const adapter = makeAdapter(out);
    const session = fakeSession();
    adapter.subscribe(session as never);
    expect(adapter.liveSnapshot()).toEqual({ seq: 0, messages: [], liveToolCallIds: new Set(), liveFailedCalls: new Set() });
    adapter.beginTurn('c', { message: PROMPT, text: null });
    play(session, TURN);
    expect(adapter.eventSeq).toBe(out.length);
    expect(adapter.liveSnapshot()).toEqual({ seq: out.length, messages: [], liveToolCallIds: new Set(), liveFailedCalls: new Set() });
  });

  it('shows a prompt or a cancel note pi accepted until pi delivers it, whatever pi delivers before it', () => {
    const NOTE = { type: 'userMessage', content: 'stop that', correlationId: 'n', promptIndex: 0, isInjected: true } as const;
    const userEnd = (text: string) => ({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } });
    const adapter = makeAdapter([], (text) => text !== 'hi');
    const session = fakeSession();
    adapter.subscribe(session as never);
    adapter.beginTurn('c', { message: PROMPT, text: null });
    const echoes = () => adapter.liveSnapshot().messages.filter((m) => m.type === 'userMessage');
    // a prompt pi queued as a follow-up waits behind a batch steered into the run before it
    play(session, [userEnd('a queued batch')]);
    expect(echoes()).toEqual([PROMPT]);
    play(session, [userEnd('hi')]);
    expect(echoes()).toEqual([]);
    adapter.echoUser({ message: NOTE, text: 'stop that' });
    expect(echoes()).toEqual([NOTE]);
    play(session, [userEnd('a queued batch')]);
    expect(echoes()).toEqual([NOTE]);
    play(session, [userEnd('stop that')]);
    expect(echoes()).toEqual([]);
  });

  it('a view that joins after a Stop, while pi still winds the run down, ends with the stores of one that watched it all', async () => {
    for (let stopAt = 1; stopAt < TURN.length; stopAt++) {
      const out: ExtensionToWebviewMessage[] = [];
      const turn: Turn = { running: false };
      const adapter = makeAdapter(out, undefined, turn);
      const session = fakeSession();
      adapter.subscribe(session as never);
      adapter.beginTurn('c', { message: PROMPT, text: null });
      play(session, TURN.slice(0, stopAt));
      // the session's Stop (`stopTurn`, `publishTurnStopped`): it ends the turn and posts its own messages, before pi settles the run
      turn.running = false;
      adapter.markAborted();
      out.push({ type: 'sessionCancelled' }, { type: 'processing', isProcessing: false });
      const joinedAt = out.length;
      const page = chatPage();
      page.deliver((await joinMessages(adapter, session)).messages);
      expect(page.shown(), `joined after a Stop at event ${stopAt}`).toEqual(watching(out).shown());
      play(session, [{ type: 'agent_settled' }]);
      page.deliver(out.slice(joinedAt));
      expect(page.shown(), `joined after a Stop at event ${stopAt}, once pi settled`).toEqual(watching(out).shown());
    }
  });

  it('a view that joins after the session gave a prompt back before pi took it ends with the stores of one that watched', async () => {
    const out: ExtensionToWebviewMessage[] = [];
    const turn: Turn = { running: false };
    const adapter = makeAdapter(out, undefined, turn);
    const session = fakeSession();
    adapter.subscribe(session as never);
    adapter.beginTurn('c', { message: PROMPT, text: null });
    // a Stop during the prompt's UserPromptSubmit hook: the send ends the turn and `returnUnsentMessage` gives the prompt back
    turn.running = false;
    out.push({ type: 'processing', isProcessing: false }, { type: 'interruptRecovery', correlationId: 'c', promptContent: 'hi' });
    adapter.withdrawEcho('c');
    const page = chatPage();
    page.deliver((await joinMessages(adapter, session)).messages);
    expect(page.shown()).toEqual(watching(out).shown());
  });
});

describe('a joining view of a running subagent', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const AGENT = { type: 'toolCall', id: 'a1', name: 'Agent', arguments: { description: 'Survey', prompt: 'Look around.', subagent_type: 'general-purpose' } };
  const NESTED_BASH = { type: 'toolCall', id: 'nb1', name: 'bash', arguments: { command: 'ls' } };
  const NESTED_RESULT = { content: [{ type: 'text', text: 'a.ts\nb.ts' }], details: {} };
  // The parent turn up to the running Agent call.
  const PARENT: unknown[] = [
    { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: AGENT } },
    { type: 'message_end', message: { role: 'assistant', content: [AGENT], stopReason: 'toolUse' } },
    { type: 'tool_execution_start', toolCallId: 'a1', toolName: 'Agent', args: AGENT.arguments },
  ];
  const SECOND = { type: 'toolCall', id: 'a2', name: 'Agent', arguments: { description: 'Tests', prompt: 'And the tests.', subagent_type: 'general-purpose', run_in_background: true } };
  // The parent turn with a second `Agent` call beside the first, run in parallel.
  const PARENT_TWO: unknown[] = [
    ...PARENT.slice(0, 3),
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: AGENT } },
    { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: SECOND } },
    { type: 'message_end', message: { role: 'assistant', content: [AGENT, SECOND], stopReason: 'toolUse' } },
    { type: 'tool_execution_start', toolCallId: 'a1', toolName: 'Agent', args: AGENT.arguments },
    { type: 'tool_execution_start', toolCallId: 'a2', toolName: 'Agent', args: SECOND.arguments },
  ];
  const LAUNCHED = { content: [{ type: 'text', text: JSON.stringify({ status: 'async_launched', agentId: 'pending' }) }], details: {} };
  // A background spawn's call returns at once, and the parent's turn ends while the subagent runs.
  const PARENT_AFTER_BACKGROUND_SPAWN: unknown[] = [
    { type: 'tool_execution_end', toolCallId: 'a1', toolName: 'Agent', result: LAUNCHED, isError: false, durationMs: 1 },
    { type: 'message_start', message: { role: 'toolResult', toolCallId: 'a1', toolName: 'Agent', ...LAUNCHED, isError: false } },
    { type: 'message_end', message: { role: 'toolResult', toolCallId: 'a1', toolName: 'Agent', ...LAUNCHED, isError: false } },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Started it.' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Started it.' }], stopReason: 'stop' } },
    { type: 'agent_settled' },
  ];
  // The subagent's model call, once pi committed its task: it streams text, runs a shell tool that streams output, then answers.
  const NESTED: unknown[] = [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Look' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ing' } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking' }, NESTED_BASH], stopReason: 'toolUse' } },
    { type: 'tool_execution_start', toolCallId: 'nb1', toolName: 'bash', args: NESTED_BASH.arguments },
    { type: 'tool_execution_update', toolCallId: 'nb1', toolName: 'bash', args: {}, partialResult: { content: [{ type: 'text', text: 'a.ts\n' }], details: {} } },
    { type: 'tool_execution_update', toolCallId: 'nb1', toolName: 'bash', args: {}, partialResult: { content: [{ type: 'text', text: 'a.ts\nb.ts\n' }], details: {} } },
    { type: 'tool_execution_end', toolCallId: 'nb1', toolName: 'bash', result: NESTED_RESULT, isError: false, durationMs: 30 },
    { type: 'message_start', message: { role: 'toolResult', toolCallId: 'nb1', toolName: 'bash', ...NESTED_RESULT, isError: false } },
    { type: 'message_end', message: { role: 'toolResult', toolCallId: 'nb1', toolName: 'bash', ...NESTED_RESULT, isError: false } },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Two files' } },
  ];
  const SHELL_RUNNING = NESTED.findIndex((event) => (event as { type: string }).type === 'tool_execution_update') + 1;

  const NO_RESOURCE_RULES = async (): Promise<McpResourceRuleFilter> => ({ serverCovered: () => false, resourceDenied: () => false, resourceDenyRule: () => undefined, contentCovered: () => false });
  const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;
  const managers: AgentManager[] = [];
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.dispose();
  });

  /**
   * A panel's chat session whose parent turn runs an `Agent` call, a real `AgentManager` that runs the subagent on a pi session
   * fake, and a page that watched from the start. A join is `HistoryManager.replayLive` of the session's `liveConversation()`.
   */
  async function runningSubagent(background: boolean, maxConcurrent = 2, parentTurn: readonly unknown[] = PARENT) {
    const out: ExtensionToWebviewMessage[] = [];
    const watcher = chatPage();
    const post = (message: ExtensionToWebviewMessage): void => {
      out.push(message);
      watcher.deliver([message]);
    };
    const chat = liveChatSession(post, { agents: () => manager.liveSnapshot() });
    chat.turn.running = true;
    chat.adapter.beginTurn('c', { message: PROMPT, text: null });
    const nested = new FakeSession();
    const engine: SubagentEngine = {
      cwd: '/cwd',
      trust: createFakePlatform().trust,
      registry: new AgentRegistry(),
      createSession: async () => nested as unknown as AgentSession,
      forgetSession: () => undefined,
      permissionHandler: {} as never,
      isPlanMode: () => false,
      shellCancelFor: () => new ShellCancelStore().forContext(() => undefined),
      postMessage: post,
      getParentSystemPrompt: () => '',
      getParentSessionId: () => 'SID',
      subagentStoreDir: () => '/cwd/subagents',
      recordInvocation: (data) => {
        chat.pi.branch.push({ type: 'custom', customType: 'damocles-agent-invocation', id: `inv-${chat.pi.branch.length}`, parentId: null, timestamp: '2026-01-01T00:00:00.000Z', data } as unknown as SessionEntry);
      },
      parentBranch: () => chat.pi.branch,
      assertResumableModel: () => undefined,
      parentFullToolNames: () => [],
      buildAgentToolset: () => ({ customTools: [], mcp: buildNestedMcpToolset(piStub, null, { eligible: new Set(), disabledEntries: [], resourceRuleFilter: NO_RESOURCE_RULES }) }),
      disposeBrowserScope: () => undefined,
      cancelAgentDialogs: () => undefined,
      resolveModel: () => ({ modelLabel: 'claude-haiku-5-5' }),
      modelDollarBilled: () => true,
      onSubagentCost: () => undefined,
      onRunsChanged: () => undefined,
    };
    const manager = new AgentManager(engine, maxConcurrent);
    managers.push(manager);
    const playParent = (events: readonly unknown[]): void => {
      for (const event of events) {
        chat.pi.emit(event);
        vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS);
      }
    };
    playParent(parentTurn);
    manager.spawn({ kind: 'spawn', type: 'general-purpose', prompt: 'Look around.', description: 'Survey', toolCallId: 'a1', runInBackground: background });
    // pi committed the task and asks the model
    await nested.whenModelCalled(1);
    if (background) {
      playParent(PARENT_AFTER_BACKGROUND_SPAWN);
      chat.turn.running = false;
    }
    const playNested = (events: readonly unknown[]): void => {
      for (const event of events) {
        nested.emit(event);
        vi.advanceTimersByTime(TOOL_OUTPUT_COALESCE_MS);
      }
    };
    /** What a joining view is posted, captured at one moment as `replayLiveConversation` captures it. */
    const join = async (): Promise<ExtensionToWebviewMessage[]> => {
      const messages: ExtensionToWebviewMessage[] = [];
      const history = new HistoryManager({ postMessage: () => undefined, maxCheckpointFileSizeBytes: () => 0 });
      await history.replayLive({ reasons: undefined, isContextOverflow: undefined }, '/cwd', chat as never, {} as never, (m) => messages.push(m), chat.liveConversation() as never);
      return messages;
    };
    return { out, watcher, chat, nested, manager, playNested, join };
  }

  for (const background of [false, true]) {
    it(`a view that joins while a ${background ? 'background' : 'foreground'} subagent streams text and runs a shell tool ends with the stores of one that watched, its running call pending, never unrecorded`, async () => {
      for (let joinAt = 0; joinAt <= NESTED.length; joinAt++) {
        const { out, watcher, playNested, join } = await runningSubagent(background);
        playNested(NESTED.slice(0, joinAt));
        const page = chatPage();
        page.deliver(await join());
        expect(page.shown(), `joined after nested event ${joinAt}`).toEqual(watcher.shown());
        for (let next = joinAt; next < NESTED.length; next++) {
          const from = out.length;
          playNested([NESTED[next]]);
          page.deliver(out.slice(from));
          expect(page.shown(), `joined after nested event ${joinAt}, at nested event ${next + 1}`).toEqual(watcher.shown());
        }
      }
      // joined while the shell call runs: its card is running with its output, as the watcher's is
      const { watcher, playNested, join } = await runningSubagent(background);
      playNested(NESTED.slice(0, SHELL_RUNNING + 1));
      const page = chatPage();
      page.deliver(await join());
      const shown = page.shown();
      const sub = shown.subagents.find((s) => s.id === 'a1');
      expect(sub?.status).toBe('running');
      expect(sub?.header).toMatchObject({ description: 'Survey', model: 'claude-haiku-5-5', isBackground: background });
      expect(sub?.transcript.flatMap((m) => m.cards ?? []).find((c) => c.id === 'nb1')).toEqual({ id: 'nb1', name: 'Bash', status: 'running', output: 'a.ts\nb.ts\n' });
      // a background subagent's tool is never the turn's, and its Background Tasks row is shown
      expect(shown.statusBar.tool).toBe(background ? null : 'Bash');
      expect(shown.backgroundTasks).toEqual(background ? [expect.objectContaining({ toolUseId: 'a1', description: 'Survey', status: 'running' })] : []);
      expect(shown).toEqual(watcher.shown());
    });
  }

  it('a view that joins while a subagent waits for a free slot shows it queued, as one that watched', async () => {
    const { watcher, manager, playNested, join } = await runningSubagent(false, 1, PARENT_TWO);
    playNested(NESTED.slice(0, SHELL_RUNNING + 1));
    manager.spawn({ kind: 'spawn', type: 'general-purpose', prompt: 'And the tests.', description: 'Tests', toolCallId: 'a2', runInBackground: true });
    const page = chatPage();
    page.deliver(await join());
    expect(page.shown()).toEqual(watcher.shown());
    expect(page.shown().subagents.find((s) => s.id === 'a2')?.header).toMatchObject({ queued: true, isBackground: true });
  });

  it("shows the subagent's whole run after pi compacted its context, as the file replay would, not the kept tail", async () => {
    const { watcher, nested, playNested, join } = await runningSubagent(false);
    playNested(NESTED.slice(0, SHELL_RUNNING + 1));
    // pi's compaction replaces the context it sends with a summary and the kept messages (`_refreshFinalizedContext`)
    Object.defineProperty(nested, 'messages', { get: () => [{ role: 'compactionSummary', summary: 'Looked around.' }] });
    const page = chatPage();
    page.deliver(await join());
    expect(page.shown().subagents).toEqual(watcher.shown().subagents);
    expect(page.shown().subagents[0]?.transcript.some((m) => m.content === 'Looking')).toBe(true);
  });
});
