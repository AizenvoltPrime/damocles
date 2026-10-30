// A chat page fed through the real webview dispatcher and Pinia stores, and a pi session whose turn a real PiStreamAdapter
// maps: what a test compares a joining or reloaded view against a view that watched the whole turn.
import { createApp, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { PiStreamAdapter, snapshotMessageAtPost } from '../pi-stream-adapter';
import { replayLiveBranch } from '../session-store/history-loader';
import type { AgentsLiveSnapshot } from '../subagents/agent-manager';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { ChatMessage, ToolCall } from '../../../shared/types/session';
import type { ContentBlock } from '../../../shared/types/content';
import { i18n } from '@/i18n';
import { createMessageDispatcher } from '@/composables/message-handler';
import { runningToolName } from '@/lib/running-tool';
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

// The chat page's stores select their host bridge on first use (`usePlatformBridge`).
(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => undefined, setState: () => undefined });

export const PROMPT = { type: 'userMessage', content: 'hi', correlationId: 'c', promptIndex: 0 } as const;
export const BASH = { type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'npm test' } };
export const READ = { type: 'toolCall', id: 'r1', name: 'read', arguments: { path: 'a.ts' } };
export const BASH_RESULT = { content: [{ type: 'text', text: 'line 1\nline 2\ndone' }], details: {} };
export const READ_RESULT = { content: [{ type: 'text', text: 'not found' }], details: { path: 'a.ts' } };

// The model call pi re-runs: it failed after streaming a little, and pi stores it like any message.
export const FAILED_CALL = { role: 'assistant', content: [{ type: 'text', text: 'Hm' }], stopReason: 'error', errorMessage: 'overloaded' };
const FAILED_CALL_ENTRY = 'e-failed';

// One turn: the prompt, an answer that calls a streaming shell tool and a read in parallel (the read ends first and fails, and
// pi stores both results only once both ended), a failed call pi re-runs after a retry wait, then a second answer. pi ends the
// failed call's run, starts the wait and only then takes the call out of model context (`_prepareRetry`, `agent-session.js:3103-3110`).
export const TURN: unknown[] = [
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
  { type: 'message_start', message: { role: 'assistant', content: [] } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hm' } },
  { type: 'message_end', message: FAILED_CALL },
  { type: 'turn_end', message: FAILED_CALL, toolResults: [] },
  { type: 'agent_end', messages: [FAILED_CALL], willRetry: true },
  { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: 'overloaded' },
  { type: 'entry_appended', entry: { type: 'context_edit', id: 'e-omit', parentId: FAILED_CALL_ENTRY, timestamp: '2026-01-01T00:00:00.000Z', targetId: FAILED_CALL_ENTRY, replacement: null } },
  { type: 'message_start', message: { role: 'assistant', content: [] } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'All' } },
  { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' good' } },
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'All good' }], stopReason: 'stop' } },
  { type: 'agent_settled' },
];
// pi has started the shell call, where the gate runs.
export const AT_GATE = TURN.findIndex((event) => (event as { type: string; toolCallId?: string }).type === 'tool_execution_start') + 1;

/**
 * A pi session whose branch gains each message right after its `message_end` reached the listeners, as pi stores it, and an
 * appended entry before its `entry_appended` does, as pi appends it first.
 */
export function fakeSession(stored: SessionEntry[] = []) {
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
      const { type, message, entry: appended } = e as { type: string; message?: { role: string }; entry?: SessionEntry };
      if (type === 'entry_appended' && appended) branch.push(appended);
      listener?.(e);
      if (type !== 'message_end' || !message) return;
      const id = message === FAILED_CALL ? FAILED_CALL_ENTRY : message.role === 'user' && !branch.some((entry) => entry.id === 'u-entry') ? 'u-entry' : `e${branch.length}`;
      branch.push({ type: 'message', id, parentId: branch.at(-1)?.id ?? null, timestamp: '2026-01-01T00:00:00.000Z', message } as unknown as SessionEntry);
    },
  };
}
export type FakeSession = ReturnType<typeof fakeSession>;

/** The session's turn state, which the adapter moves through `onTurnStateChanged` and the session's own Stop or give-back ends. */
export interface Turn { running: boolean }

export function makeAdapter(out: ExtensionToWebviewMessage[] | ((message: ExtensionToWebviewMessage) => void), queued: (text: string) => boolean = () => false, turn: Turn = { running: false }): PiStreamAdapter {
  // pi commits the prompt's entry at its user `message_end`, and the session finds it only from then (`watchPromptEntry`)
  let promptStored = false;
  return new PiStreamAdapter({
    onMessage: (m) => (typeof out === 'function' ? out(m) : out.push(m)),
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
    onUserMessageDelivered: (text) => {
      const delivered = queued(text);
      if (!delivered) promptStored = true;
      return delivered;
    },
    onMidStreamEntryCommitted: () => undefined,
    promptEntryId: () => (promptStored ? 'u-entry' : null),
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
export async function joinMessages(adapter: PiStreamAdapter, session: FakeSession): Promise<{ seq: number; messages: ExtensionToWebviewMessage[] }> {
  const snapshot = adapter.liveSnapshot();
  const branch = [...session.branch];
  const messages: ExtensionToWebviewMessage[] = [];
  await replayLiveBranch({ reasons: undefined, isContextOverflow: undefined }, '/cwd', 'SID', session.sessionManager, branch, (m) => messages.push(m), false, snapshot);
  messages.push(...snapshot.messages.map((message) => snapshotMessageAtPost(snapshot, message)), { type: 'sessionStarted', sessionId: 'SID', stored: true });
  return { seq: snapshot.seq, messages };
}

/**
 * A panel's chat session whose conversation a real adapter maps from `pi`, as `PiSession` does: each emitted message goes to
 * `post` numbered by the adapter's count, and `liveConversation` reads the branch and the snapshots in one step, the subagents'
 * from `agents` (`AgentManager.liveSnapshot`). `onWebviewReady` stands for the session's repost of its prompts and state to a
 * page that loaded again.
 */
export function liveChatSession(post: (message: ExtensionToWebviewMessage) => void, options: { readonly onWebviewReady?: () => void; readonly worktree?: unknown; readonly agents?: () => AgentsLiveSnapshot } = {}) {
  const pi = fakeSession();
  const seqs = new WeakMap<object, number>();
  const turn: Turn = { running: false };
  const adapter: PiStreamAdapter = makeAdapter((message) => {
    seqs.set(message, adapter.eventSeq);
    post(message);
  }, undefined, turn);
  adapter.subscribe(pi as never);
  const session = {
    pi,
    adapter,
    turn,
    cwd: '/cwd',
    currentSessionId: pi.sessionId,
    storedSessionId: pi.sessionId,
    persistenceSessionId: pi.sessionId,
    fileCheckpoints: false,
    holdsSession: (id: string) => id === pi.sessionId,
    holdsLiveConversation: (id: string | undefined) => id === undefined || id === pi.sessionId,
    hasConversation: () => true,
    hasSessionFile: () => true,
    whenConversationSettled: async () => undefined,
    liveConversation: () => {
      const agents = options.agents?.();
      return { sessionId: pi.sessionId, stored: true, branch: [...pi.branch], sessionManager: pi.sessionManager, snapshot: adapter.liveSnapshot(), ...(agents ? { agents } : {}) };
    },
    get eventSeq() { return adapter.eventSeq; },
    eventSeqOf: (message: object) => seqs.get(message),
    // a restore of the conversation pi holds switches to it at once
    setResumeSession: () => undefined,
    openResumeTarget: async () => ({ kind: 'switched' as const }),
    letGoOfUnreadTarget: () => false,
    seedCheckpoints: () => undefined,
    onSessionLeaseLost: () => undefined,
    onSessionReleaseRequested: async () => undefined,
    replayLiveAgents: () => undefined,
    onWebviewReady: () => options.onWebviewReady?.(),
    publishAccountInfo: () => undefined,
    getToolStatus: () => ({}),
    setPanelToken: () => undefined,
    setActivityListener: () => undefined,
    setTurnSettledListener: () => undefined,
    setChatChangesListener: () => undefined,
    setMcpStatusListener: () => undefined,
    initializeEarly: async () => undefined,
    dispose: async () => undefined,
    worktree: options.worktree ?? { bindPanel: () => undefined, setListener: () => undefined, publish: () => undefined, republish: () => undefined, readOnly: () => false, inLiveWorktree: () => undefined, entry: () => undefined, record: () => undefined, place: () => 'project' },
  };
  return session;
}
export type LiveChatSession = ReturnType<typeof liveChatSession>;

export function handlerRegistry(): HandlerRegistry {
  let registry!: HandlerRegistry;
  const app = createApp({ setup: () => { registry = createHandlerRegistry(); return () => null; } });
  app.use(i18n);
  app.mount(document.createElement('div'));
  app.unmount();
  return registry;
}

export interface Card { id: string; name: string; status: ToolCall['status']; output?: string; outcome?: string; metadata?: Record<string, unknown>; abandonReason?: string }
/**
 * A transcript row as the page renders it. Left out: its id and timestamp, which no two pages share, the ids that link a row
 * to its stored entry, which a replayed row holds from the start and a watched one from its prompt's next message
 * (`promptEntryIds`), and the thinking duration, a clock reading pi does not store, so only a watching page can show it.
 */
export interface Row {
  role: string;
  content: string;
  thinking?: string;
  /** Text and tool blocks in the order the row interleaves them. */
  blocks?: string[];
  cards?: Card[];
  flags?: Partial<Pick<ChatMessage, 'promptIndex' | 'isInjected' | 'isThinkingPhase' | 'effort' | 'isCombinedQueue'>>;
}
export interface Shown {
  processing: boolean;
  /** What the status bar shows: the tool it names (`runningToolName`, as App.vue reads it) and how long the turn has run. */
  statusBar: { tool: string | null; turnElapsedMs: number | null };
  retry: unknown;
  /** Every prompt the page asks the user to answer: approvals, questions, forms and MCP elicitations. */
  prompts: string[];
  teams: Array<{ toolUseId: string | undefined; status: string }>;
  transcript: Row[];
  /** The Background Tasks rows. */
  backgroundTasks: unknown[];
  /** Each subagent card: what its header shows, its nested transcript, the message it streams and its usage. */
  subagents: Array<{ id: string; status: string; header: Record<string, unknown>; transcript: Row[]; streaming?: string; usage?: unknown }>;
}

// A live card keeps a failure as its error and a replayed one as its result; both render the same text.
export function card(tool: ToolCall): Card {
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

// A nested card's elapsed time is the clock when its progress was last sent, which a joining view reads later.
function nestedCard(tool: ToolCall): Card {
  const { elapsedTimeSeconds: _elapsed, ...metadata } = tool.metadata ?? {};
  return card({ ...tool, metadata });
}

function blocksOf(blocks: readonly ContentBlock[] | undefined): string[] | undefined {
  const shown = (blocks ?? []).flatMap((b) => (b.type === 'text' ? [`text:${b.text}`] : b.type === 'tool_use' ? [`tool:${b.id}`] : []));
  return shown.length > 0 ? shown : undefined;
}

function flagsOf(m: ChatMessage): Row['flags'] | undefined {
  const flags = Object.fromEntries(Object.entries({
    promptIndex: m.promptIndex, isInjected: m.isInjected,
    isThinkingPhase: m.isThinkingPhase, effort: m.effort, isCombinedQueue: m.isCombinedQueue,
  }).filter(([, value]) => value !== undefined && value !== false));
  return Object.keys(flags).length > 0 ? flags : undefined;
}

function rowOf(m: ChatMessage, toCard: (tool: ToolCall) => Card): Row {
  const blocks = blocksOf(m.contentBlocks);
  const flags = flagsOf(m);
  return {
    role: m.role,
    content: m.content,
    ...(m.thinking ? { thinking: m.thinking } : {}),
    ...(blocks ? { blocks } : {}),
    ...(m.toolCalls?.length ? { cards: m.toolCalls.map(toCard) } : {}),
    ...(flags ? { flags } : {}),
  };
}

/** A chat page: its own Pinia stores, fed through the real message dispatcher and handlers. */
export function chatPage() {
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
    stores,
    deliver(messages: readonly ExtensionToWebviewMessage[]): void {
      setActivePinia(pinia);
      for (const message of messages) dispatch(message);
    },
    /** Resolves once the page has handled every message delivered so far, those held behind a language switch included. */
    async settled(): Promise<void> {
      setActivePinia(pinia);
      await dispatch.settled();
    },
    shown(): Shown {
      stores.streamingStore.flushReplayQueue();
      const startedAt = stores.uiStore.turnStartedAt;
      return {
        processing: stores.uiStore.isProcessing,
        statusBar: {
          tool: runningToolName(stores.streamingStore.messages, (id) => stores.subagentStore.subagents[id]),
          turnElapsedMs: startedAt === null ? null : Date.now() - startedAt,
        },
        retry: stores.uiStore.retryStatus,
        prompts: [
          ...Object.keys(stores.permissionStore.pendingPermissions),
          ...(stores.questionStore.pendingQuestion ? [stores.questionStore.pendingQuestion.toolUseId] : []),
          ...(stores.formStore.pendingForm ? [stores.formStore.pendingForm.toolUseId] : []),
          ...stores.elicitationStore.pendingElicitations.map((e) => e.elicitationId),
        ],
        teams: Object.values(stores.teamStore.teams).map((team) => ({ toolUseId: team.toolUseId, status: team.status })),
        transcript: stores.streamingStore.messages.map((m) => rowOf(m, card)),
        backgroundTasks: stores.backgroundTaskStore.tasks.map((task) => ({ ...task })),
        subagents: Object.values(stores.subagentStore.subagents).map((s) => {
          const streaming = stores.subagentStore.getSubagentStreaming(s.id)?.content;
          const header = Object.fromEntries(Object.entries({
            agentType: s.agentType, description: s.description, model: s.model, effort: s.effort, templatePath: s.templatePath,
            sdkAgentId: s.sdkAgentId, isBackground: s.isBackground, queued: s.queued, windDown: s.windDown, retry: s.retry, resume: s.resume,
          }).filter(([, value]) => value !== undefined));
          return {
            id: s.id,
            status: s.status,
            header,
            transcript: [
              ...s.messages.map((m): Row => {
                // a live message carries its text as content, a replayed one as blocks; the card renders either
                const blocks = m.contentBlocks ?? [];
                const content = m.content || blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
                const thinking = m.thinking || blocks.flatMap((b) => (b.type === 'thinking' ? [b.thinking] : [])).join('\n\n');
                return { ...rowOf(m, nestedCard), content, ...(thinking ? { thinking } : {}) };
              }),
              ...(s.toolCalls.length ? [{ role: 'tools', content: '', cards: s.toolCalls.map(nestedCard) }] : []),
            ],
            ...(streaming ? { streaming } : {}),
            ...(s.usage ? { usage: s.usage } : {}),
          };
        }),
      };
    },
  };
}
export type ChatPage = ReturnType<typeof chatPage>;

export function watching(messages: readonly ExtensionToWebviewMessage[]): ChatPage {
  const page = chatPage();
  page.deliver(messages);
  return page;
}

export const cardsOf = (shown: Shown): Card[] => shown.transcript.flatMap((m) => m.cards ?? []);

/** The stored entry each user row's rewind control names. */
export const promptEntryIds = (page: ChatPage): Array<string | undefined> =>
  page.stores.streamingStore.messages.filter((m) => m.role === 'user').map((m) => m.sdkMessageId);
