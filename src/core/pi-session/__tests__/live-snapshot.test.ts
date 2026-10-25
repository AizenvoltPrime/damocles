// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { PiStreamAdapter } from '../pi-stream-adapter';
import { TOOL_OUTPUT_COALESCE_MS } from '../tool-output-coalescer';
import { replayLiveBranch } from '../session-store/history-loader';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ToolCall } from '../../../shared/types/session';
import { i18n } from '@/i18n';
import { createMessageDispatcher } from '@/composables/message-handler';
import { createHandlerRegistry } from '@/composables/message-handler/handler-registry';
import type { HandlerContext, HandlerRegistry, StoreContext } from '@/composables/message-handler/types';
import { useUIStore } from '@/stores/useUIStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useStreamingStore } from '@/stores/useStreamingStore';
import { useSubagentStore } from '@/stores/useSubagentStore';
import { useQuestionStore } from '@/stores/useQuestionStore';
import { useFormStore } from '@/stores/useFormStore';
import { usePlanViewStore } from '@/stores/usePlanViewStore';
import { useMemoryStore } from '@/stores/useMemoryStore';
import { useContextInjectionStore } from '@/stores/useContextInjectionStore';
import { useContextUsageStore } from '@/stores/useContextUsageStore';
import { useSubscriptionUsageStore } from '@/stores/useSubscriptionUsageStore';
import { useElicitationStore } from '@/stores/useElicitationStore';
import { useBtwStore } from '@/stores/useBtwStore';
import { useBackgroundTaskStore } from '@/stores/useBackgroundTaskStore';
import { useCompassStore } from '@/stores/useCompassStore';
import { useTeamStore } from '@/stores/useTeamStore';
import { useVoiceJarvisStore } from '@/stores/useVoiceJarvisStore';
import { usePromptNavigatorStore } from '@/stores/usePromptNavigatorStore';
import { useConsolidationStore } from '@/stores/useConsolidationStore';
import { useMemoryAuditStore } from '@/stores/useMemoryAuditStore';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';

vi.mock('../../logger', () => ({ log: vi.fn() }));
// The chat page's stores select their host bridge on first use (`usePlatformBridge`).
(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => undefined, setState: () => undefined });

const PROMPT = { type: 'userMessage', content: 'hi', correlationId: 'c', promptIndex: 0 } as const;
const BASH = { type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'npm test' } };
const READ = { type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'a.ts' } };
const BASH_RESULT = { content: [{ type: 'text', text: 'line 1\nline 2\ndone' }], details: {} };
const READ_RESULT = { content: [{ type: 'text', text: 'not found' }], details: { path: 'a.ts' } };

// One turn: the prompt, an answer that calls a streaming shell tool and a read in parallel (the read ends first and fails, and
// pi stores both results only once both ended), a retry wait, then a second answer.
const TURN: unknown[] = [
  { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
  { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
  { type: 'message_start', message: { role: 'assistant', content: [] } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Plan' } },
  { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'Plan' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Run' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ning' } },
  { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: BASH } },
  { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: READ } },
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan' }, { type: 'text', text: 'Running' }, BASH, READ], stopReason: 'toolUse' } },
  { type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: BASH.arguments },
  { type: 'tool_execution_start', toolCallId: 'r1', toolName: 'read', args: READ.arguments },
  { type: 'tool_execution_update', toolCallId: 'b1', toolName: 'bash', args: {}, partialResult: { content: [{ type: 'text', text: 'line 1\n' }], details: {} } },
  { type: 'tool_execution_end', toolCallId: 'r1', toolName: 'read', result: READ_RESULT, isError: true, durationMs: 5 },
  { type: 'tool_execution_update', toolCallId: 'b1', toolName: 'bash', args: {}, partialResult: { content: [{ type: 'text', text: 'line 1\nline 2\n' }], details: {} } },
  { type: 'tool_execution_end', toolCallId: 'b1', toolName: 'bash', result: BASH_RESULT, isError: false, durationMs: 1200 },
  { type: 'message_start', message: { role: 'toolResult', toolCallId: 'b1', toolName: 'bash', ...BASH_RESULT, isError: false } },
  { type: 'message_end', message: { role: 'toolResult', toolCallId: 'b1', toolName: 'bash', ...BASH_RESULT, isError: false } },
  { type: 'message_start', message: { role: 'toolResult', toolCallId: 'r1', toolName: 'read', ...READ_RESULT, isError: true } },
  { type: 'message_end', message: { role: 'toolResult', toolCallId: 'r1', toolName: 'read', ...READ_RESULT, isError: true } },
  { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'overloaded' },
  { type: 'message_start', message: { role: 'assistant', content: [] } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'All' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' good' } },
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'All good' }], stopReason: 'stop' } },
  { type: 'agent_settled' },
];
// pi has started the shell call, where the gate runs.
const AT_GATE = TURN.findIndex((event) => (event as { type: string; toolCallId?: string }).type === 'tool_execution_start') + 1;

/** A pi session whose branch gains each message right after its `message_end` reached the listeners, as pi stores it. */
function fakeSession(stored: SessionEntry[] = []) {
  let listener: ((e: unknown) => void) | undefined;
  const branch = [...stored];
  const sessionManager = { getLeafId: () => branch.at(-1)?.id ?? null, getBranch: () => branch, getEntries: () => branch, getHeader: () => null };
  return {
    sessionId: 'SID',
    branch,
    sessionManager,
    modelRuntime: { getModel: () => undefined },
    subscribe: (l: (e: unknown) => void) => { listener = l; return () => undefined; },
    getLastAssistantText: () => 'All good',
    getContextUsage: () => undefined,
    emit: (e: unknown) => {
      listener?.(e);
      const { type, message } = e as { type: string; message?: { role: string } };
      if (type !== 'message_end' || !message) return;
      const id = message.role === 'user' && !branch.some((entry) => entry.id === 'u-entry') ? 'u-entry' : `e${branch.length}`;
      branch.push({ type: 'message', id, parentId: branch.at(-1)?.id ?? null, timestamp: '2026-01-01T00:00:00.000Z', message } as unknown as SessionEntry);
    },
  };
}
type FakeSession = ReturnType<typeof fakeSession>;

/** The session's turn state, which the adapter moves through `onTurnStateChanged` and the session's own Stop or give-back ends. */
interface Turn { running: boolean }

function makeAdapter(out: ExtensionToWebviewMessage[], queued: (text: string) => boolean = () => false, turn: Turn = { running: false }): PiStreamAdapter {
  return new PiStreamAdapter({
    onMessage: (m) => out.push(m),
    cwd: '/cwd',
    sessionId: () => 'SID',
    modelValue: () => 'claude-opus-4-8',
    supportedModels: () => [],
    permissionMode: () => 'default',
    budgetLimit: () => null,
    sessionCost: () => 0,
    showCacheMissNotices: () => false,
    showThinkingDroppedNotices: () => true,
    onBudgetStop: () => undefined,
    onUserMessageDelivered: (text) => queued(text),
    onMidStreamEntryCommitted: () => undefined,
    promptEntryId: () => 'u-entry',
    onTurnStateChanged: (...[state]) => {
      turn.running = state === 'running';
    },
    turnRunning: () => turn.running,
  });
}

/**
 * What a views.join posts (`createViewJoin`): the replay of the branch pi holds and the adapter's snapshot, captured at one
 * moment, then `sessionStarted`. The live events after the snapshot's `seq` follow it.
 */
async function joinMessages(adapter: PiStreamAdapter, session: FakeSession): Promise<{ seq: number; messages: ExtensionToWebviewMessage[] }> {
  const snapshot = adapter.liveSnapshot();
  const branch = [...session.branch];
  const messages: ExtensionToWebviewMessage[] = [];
  await replayLiveBranch({ reasons: undefined, isContextOverflow: undefined }, '/cwd', 'SID', session.sessionManager, branch, (m) => messages.push(m), false, snapshot.liveToolCallIds);
  messages.push(...snapshot.messages, { type: 'sessionStarted', sessionId: 'SID', stored: true });
  return { seq: snapshot.seq, messages };
}

function handlerRegistry(): HandlerRegistry {
  let registry!: HandlerRegistry;
  const app = createApp({ setup: () => { registry = createHandlerRegistry(); return () => null; } });
  app.use(i18n);
  app.mount(document.createElement('div'));
  app.unmount();
  return registry;
}

interface Card { id: string; name: string; status: ToolCall['status']; output?: string; outcome?: string; metadata?: Record<string, unknown>; abandonReason?: string }
interface Shown {
  processing: boolean;
  retry: unknown;
  prompts: string[];
  teams: Array<{ toolUseId: string | undefined; status: string }>;
  transcript: Array<{ role: string; content: string; thinking?: string; cards?: Card[] }>;
}

// A live card keeps a failure as its error and a replayed one as its result; both render the same text.
function card(tool: ToolCall): Card {
  const outcome = tool.errorMessage ?? tool.result;
  return {
    id: tool.id,
    name: tool.name,
    status: tool.status,
    ...(tool.liveOutput !== undefined ? { output: tool.liveOutput } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(tool.metadata && Object.keys(tool.metadata).length > 0 ? { metadata: tool.metadata } : {}),
    ...(tool.abandonReason !== undefined ? { abandonReason: tool.abandonReason } : {}),
  };
}

/** A chat page: its own Pinia stores, fed through the real message dispatcher and handlers. */
function chatPage() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const stores: StoreContext = {
    uiStore: useUIStore(), settingsStore: useSettingsStore(), sessionStore: useSessionStore(), permissionStore: usePermissionStore(),
    streamingStore: useStreamingStore(), subagentStore: useSubagentStore(), questionStore: useQuestionStore(), formStore: useFormStore(),
    planViewStore: usePlanViewStore(), memoryStore: useMemoryStore(), contextInjectionStore: useContextInjectionStore(),
    contextUsageStore: useContextUsageStore(), subscriptionUsageStore: useSubscriptionUsageStore(), elicitationStore: useElicitationStore(),
    btwStore: useBtwStore(), backgroundTaskStore: useBackgroundTaskStore(), compassStore: useCompassStore(), teamStore: useTeamStore(),
    voiceJarvisStore: useVoiceJarvisStore(), promptNavigatorStore: usePromptNavigatorStore(), consolidationStore: useConsolidationStore(),
    memoryAuditStore: useMemoryAuditStore(), extensionUiStore: useExtensionUiStore(),
  };
  let state: unknown;
  const context: HandlerContext = {
    stores,
    refs: { chatInputRef: ref(null) },
    bridge: { postMessage: () => undefined, getState: <T>() => state as T | undefined, setState: (next) => { state = next; } },
  };
  const dispatch = createMessageDispatcher(handlerRegistry(), context, () => undefined);
  return {
    deliver(messages: readonly ExtensionToWebviewMessage[]): void {
      setActivePinia(pinia);
      for (const message of messages) dispatch(message);
    },
    shown(): Shown {
      stores.streamingStore.flushReplayQueue();
      return {
        processing: stores.uiStore.isProcessing,
        retry: stores.uiStore.retryStatus,
        prompts: Object.keys(stores.permissionStore.pendingPermissions),
        teams: Object.values(stores.teamStore.teams).map((team) => ({ toolUseId: team.toolUseId, status: team.status })),
        transcript: stores.streamingStore.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.thinking ? { thinking: m.thinking } : {}),
          ...(m.toolCalls?.length ? { cards: m.toolCalls.map(card) } : {}),
        })),
      };
    },
  };
}
type ChatPage = ReturnType<typeof chatPage>;

function watching(messages: readonly ExtensionToWebviewMessage[]): ChatPage {
  const page = chatPage();
  page.deliver(messages);
  return page;
}

const cardsOf = (shown: Shown): Card[] => shown.transcript.flatMap((m) => m.cards ?? []);

describe('PiStreamAdapter.liveSnapshot', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const play = (session: FakeSession, events: readonly unknown[]): void => {
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
    expect(cardsOf(await shownAt(TURN.slice(0, readEnded + 1)))).toEqual([
      { id: 'b1', name: 'Bash', status: 'running', output: 'line 1\nline 2\n' },
      { id: 'r1', name: 'Read', status: 'failed', outcome: 'not found', metadata: { path: 'a.ts' } },
    ]);
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
    expect(adapter.liveSnapshot()).toEqual({ seq: 0, messages: [], liveToolCallIds: new Set() });
    adapter.beginTurn('c', { message: PROMPT, text: null });
    play(session, TURN);
    expect(adapter.eventSeq).toBe(out.length);
    expect(adapter.liveSnapshot()).toEqual({ seq: out.length, messages: [], liveToolCallIds: new Set() });
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
