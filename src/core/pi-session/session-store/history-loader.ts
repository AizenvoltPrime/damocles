import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { ContentBlock, HistoryAgentMessage, HistoryToolCall, ImageBlock } from '@shared/types/content';
import { initPiLoader, loadPiAi } from '../pi-loader';
import { log } from '../../logger';
import { t } from '../../l10n';
import { approxStringLength, perfDebugEnabled, perfSpan } from '../../perf';
import { mapPiToolName, normalizeToolInput, normalizeToolDetails } from '../tool-normalization';
import { piMessagesToHistoryAgentMessages } from '../subagents/message-mapper';
import { failedCallError } from '../nested-call-failures';
import { abandonReasonOf, skippedToolCalls } from '../abandoned-tool-calls';
import {
  agentInvocationsOnBranch,
  indexAgentFiles,
  injectedAgentResultsOnBranch,
  isAgentToolDetails,
  readAgentFile,
  resolveAgentStatus,
  segmentForInvocation,
  subagentsDir,
  type AgentFile,
  type AgentInvocationData,
} from '../agent-records';
import { TOOL_AGENT } from '../../../shared/tool-names';
import { ensurePiSessionDir } from './session-dir';
import { resolvePiSessionFile } from './reading';
import { promptUserIdsOnBranch, rewindableUserIdsOnBranch } from './rewind';
import { promptTest } from './prompt-index';
import { extractOriginalInputs } from './original-input';
import { extractMidStreamEntryIds } from './mid-stream';
import { stoppedOnBranch } from './turn-stopped';
import { isSteerData } from './steer';
import { DAMOCLES_STEER_ENTRY } from './constants';
import { storedTypedText } from './prompt-context';
import { extractTerminalAttachmentCounts } from './terminal-attachments';
import { splitTerminalAttachments, terminalAttachmentInfo } from '../../terminal-attachment';
import type { TerminalAttachmentInfo } from '../../../shared/types/terminal-attachment';
import { toImageBlocks } from '../branch-text';
import { resultImageCount } from '../tool-result-text';
import { sessionUsageMessage, type SessionUsageMessage } from '../session-usage';
import { contextSnapshotOf, emptyContextSnapshot, type ContextSnapshot } from '../context-snapshot';
import { publishedEffort, type EffortBadgeLevel } from '../../../shared/effort-badge';

/** Whether the registry's model of that provider and id reasons; undefined when it is not in the registry. */
export type ModelReasonsLookup = (provider: string, modelId: string) => boolean | undefined;

/** pi-ai's `isContextOverflow` for a failed call, the test pi used to choose overflow recovery over auto-retry. */
export type OverflowTest = (message: AssistantMessage) => boolean;

interface PiToolResult {
  text: string;
  isError: boolean;
  imageCount?: number;
  details?: Record<string, unknown>;
  durationMs?: number;
}

interface ReplayUser {
  kind: 'user';
  entryId: string;
  content: string;
  contentBlocks?: ContentBlock[];
  terminalAttachments?: TerminalAttachmentInfo[];
  isMidStream?: boolean;
  /** Present on a prompt only; a user entry delivered mid-run consumes no index. */
  promptIndex?: number;
  sentAt?: number;
}
interface ReplayAssistant {
  kind: 'assistant';
  content: string;
  thinking: string;
  tools: HistoryToolCall[];
  contentBlocks: ContentBlock[];
  effort?: EffortBadgeLevel;
}
interface ReplayError {
  kind: 'error';
  content: string;
}
interface ReplayCompaction {
  kind: 'compaction';
  summary: string;
  preTokens: number;
  timestamp: number;
  entryId: string;
}
interface ReplaySteer {
  kind: 'steer';
  agentId: string;
  agentType?: string;
  description?: string;
  message: string;
  images?: ImageBlock[];
  sentAt?: number;
}
type ReplayMessage = ReplayUser | ReplayAssistant | ReplayError | ReplayCompaction | ReplaySteer;

// When the entry was written: pi's message time (epoch ms), else the entry's ISO time; undefined when neither parses.
function sentAtOf(entry: SessionEntry): number | undefined {
  const messageTime = (entry as { message?: { timestamp?: unknown } }).message?.timestamp;
  if (typeof messageTime === 'number' && Number.isFinite(messageTime)) return messageTime;
  const entryTime = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(entryTime) ? entryTime : undefined;
}

/**
 * Entries whose latest `context_edit` takes them out of model context. pi omits a failed call it
 * re-runs (auto-retry or overflow recovery, `_omitRecoveryAttempt`), and the latest edit of a target wins (`buildSessionProjection`).
 * pi omits an overflow before it knows the recovery compaction will run, so only that compaction shows it was recovered.
 */
function omittedEntryIds(branch: readonly SessionEntry[]): Set<string> {
  const omitted = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== 'context_edit') continue;
    if (entry.replacement === null) omitted.add(entry.targetId);
    else omitted.delete(entry.targetId);
  }
  return omitted;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('');
}

function userVisibleText(content: unknown, attachmentCount: number): string {
  return storedTypedText(textOf(content), attachmentCount);
}

/** Reverse-map pi image blocks to the webview `{ source: { base64 } }` shape, with the user text.
 *  `overrideText` substitutes the displayed text (the original typed input when a slash command was expanded). */
function userContentBlocks(content: unknown, attachmentCount: number, overrideText?: string): ContentBlock[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const images = toImageBlocks(content);
  if (images.length === 0) return undefined;
  const text = overrideText ?? userVisibleText(content, attachmentCount);
  return [...images, ...(text ? [{ type: 'text' as const, text }] : [])];
}

/**
 * Reconstruct the displayable replay messages from a pi session's active branch (root→leaf order),
 * pairing assistant `toolCall` blocks with their `toolResult` message entries and skipping inert
 * custom entries (`damocles-checkpoint` / `damocles-user-renamed` / `damocles-original-input` /
 * `damocles-mid-stream` / `damocles-terminal-attachments`) and non-message entry types. A user message whose typed slash command was
 * expanded is shown as the original text from its `damocles-original-input` sidecar, not the stored
 * expansion; a user message flagged by `damocles-mid-stream` carries `isMidStream` for replay styling;
 * a user message named by `damocles-terminal-attachments` shows that many leading attachment blocks as chips, not text.
 * Every prompt carries its index (`promptTest`, counted over the whole branch, so the prompts a
 * compaction hid still count). The `damocles-steer` custom entry is NOT skipped — it is mapped in
 * position to a replayed amber injected "You steered" chip.
 */
export function reconstructMessages(
  branch: readonly SessionEntry[],
  modelReasons: ModelReasonsLookup = () => undefined,
  isContextOverflow: OverflowTest = () => false,
): { messages: ReplayMessage[]; usage: ContextSnapshot } {
  const originalInputs = extractOriginalInputs(branch);
  const attachmentCounts = extractTerminalAttachmentCounts(branch);
  const midStreamIds = extractMidStreamEntryIds(branch);
  const stopped = stoppedOnBranch(branch);
  const omitted = omittedEntryIds(branch);
  const isPrompt = promptTest(branch);
  let promptCount = 0;
  const toolResults = new Map<string, PiToolResult>();
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message = (entry as { message?: { role?: string; toolCallId?: string; content?: unknown; details?: unknown; isError?: boolean; durationMs?: unknown } }).message;
    if (message?.role !== 'toolResult' || !message.toolCallId) continue;
    const isError = message.isError === true;
    const imageCount = isError ? 0 : resultImageCount(message);
    toolResults.set(message.toolCallId, {
      text: textOf(message.content),
      isError,
      ...(imageCount > 0 ? { imageCount } : {}),
      ...(message.details && typeof message.details === 'object' ? { details: message.details as Record<string, unknown> } : {}),
      ...(typeof message.durationMs === 'number' ? { durationMs: message.durationMs } : {}),
    });
  }

  const messages: ReplayMessage[] = [];
  let usage = emptyContextSnapshot();
  /** The tool calls of the latest assistant entry, which an aborted one that follows may have cut short. */
  let batch: HistoryToolCall[] = [];

  for (const entry of branch) {
    if (entry.type === 'compaction') {
      // pi compaction summarizes every preceding message, earlier summaries included, and the live view
      // clears them all (`clearCompactMarkers`). Mirror that on replay: only the latest marker survives.
      messages.length = 0;
      // pi reads the context size as unknown until a response lands after the compaction.
      usage = emptyContextSnapshot();
      const c = entry as { summary?: unknown; tokensBefore?: unknown; timestamp?: unknown };
      messages.push({
        kind: 'compaction',
        summary: typeof c.summary === 'string' ? c.summary : '',
        preTokens: typeof c.tokensBefore === 'number' ? c.tokensBefore : 0,
        timestamp: typeof c.timestamp === 'string' ? Date.parse(c.timestamp) : 0,
        entryId: entry.id,
      });
      continue;
    }
    if (entry.type === 'custom' && entry.customType === DAMOCLES_STEER_ENTRY) {
      const data = (entry as { data?: unknown }).data;
      const sentAt = sentAtOf(entry);
      if (isSteerData(data))
        messages.push({
          kind: 'steer',
          agentId: data.agentId,
          ...(data.agentType ? { agentType: data.agentType } : {}),
          ...(data.description ? { description: data.description } : {}),
          message: data.message,
          ...(data.images ? { images: data.images } : {}),
          ...(sentAt !== undefined ? { sentAt } : {}),
        });
      continue;
    }
    if (entry.type !== 'message') continue;
    const message = (entry as {
      message?: {
        role?: string;
        content?: unknown;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number };
        stopReason?: string;
        errorMessage?: string;
        provider?: unknown;
        model?: unknown;
        thinkingLevel?: unknown;
      };
    }).message;
    const role = message?.role;

    if (role === 'user') {
      const promptIndex = isPrompt(entry) ? promptCount++ : undefined;
      const original = originalInputs.get(entry.id);
      const attachmentCount = attachmentCounts.get(entry.id) ?? 0;
      const content = original ?? userVisibleText(message?.content, attachmentCount);
      if (!content && !Array.isArray(message?.content)) continue;
      const blocks = userContentBlocks(message?.content, attachmentCount, original);
      const sentAt = sentAtOf(entry);
      const attachments = splitTerminalAttachments(textOf(message?.content), attachmentCount).attachments.map((attachment, index) => terminalAttachmentInfo(`${entry.id}:${index}`, attachment));
      messages.push({
        kind: 'user',
        entryId: entry.id,
        content,
        ...(blocks ? { contentBlocks: blocks } : {}),
        ...(attachments.length > 0 ? { terminalAttachments: attachments } : {}),
        ...(midStreamIds.has(entry.id) ? { isMidStream: true } : {}),
        ...(promptIndex !== undefined ? { promptIndex } : {}),
        ...(sentAt !== undefined ? { sentAt } : {}),
      });
      continue;
    }

    // Drops mid-conversation system entries with every other non-assistant role: a pi 0.86 system entry
    // patches prompt sections rather than carrying chat, so rendering it shows text the user never saw.
    if (role !== 'assistant') continue;

    // The last assistant message pi's `getContextUsage` trusts gives the context-window occupancy. Billing
    // totals are summed over the whole file in `loadPiSessionHistory`, never from this snapshot.
    const snapshot = message ? contextSnapshotOf(message) : undefined;
    if (snapshot) usage = snapshot;

    const failed = message?.stopReason === 'error';
    // An abort's wind-down error shows no card, as it showed none live; the turn-stopped record names it.
    const windDown = stopped.entryIds.has(entry.id);
    const failureCard = failed && !windDown ? failedCallError(message.errorMessage) : undefined;
    // pi returns from a turn whose call failed or was aborted before it executes any tool that call named.
    const unexecuted = windDown ? 'stopped' : abandonReasonOf(message?.stopReason);
    if (message?.stopReason === 'aborted' || windDown) {
      for (const tool of skippedToolCalls(batch, (id) => toolResults.has(id))) tool.abandoned = 'stopped';
    }
    batch = [];
    // pi re-ran an omitted call, and the live view took back what it streamed. A retried call shows no card, as it
    // showed none live; an omitted overflow's card is cleared by the recovery compaction that follows it.
    if (failed && !windDown && omitted.has(entry.id)) {
      if (failureCard && isContextOverflow(message as unknown as AssistantMessage)) messages.push({ kind: 'error', content: failureCard });
      continue;
    }

    let text = '';
    let thinking = '';
    const tools: HistoryToolCall[] = [];
    const contentBlocks: ContentBlock[] = [];
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      const b = block as { type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
      if (b.type === 'text' && typeof b.text === 'string') {
        text += b.text;
        contentBlocks.push({ type: 'text', text: b.text });
      } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
        thinking = thinking ? `${thinking}\n\n${b.thinking}` : b.thinking;
      } else if (b.type === 'toolCall' && b.id && b.name) {
        const toolName = mapPiToolName(b.name);
        const input = normalizeToolInput(b.name, b.arguments ?? {});
        const recorded = toolResults.get(b.id);
        // A Stop abandons the calls it cut short, and the live view shows the late end only of one pi executed.
        const stoppedUnexecuted = stopped.toolCallIds.has(b.id) && recorded?.durationMs === undefined;
        const abandoned = stoppedUnexecuted ? 'stopped' : unexecuted;
        const result = stoppedUnexecuted ? undefined : recorded;
        const tool: HistoryToolCall = { id: b.id, name: toolName, input, ...(abandoned ? { abandoned } : {}) };
        if (result) {
          tool.result = result.text;
          tool.isError = result.isError;
          if (result.imageCount !== undefined) tool.imageCount = result.imageCount;
          if (result.details) tool.metadata = normalizeToolDetails(result.details);
          if (result.durationMs !== undefined) tool.durationMs = result.durationMs;
        }
        tools.push(tool);
        batch.push(tool);
        contentBlocks.push({ type: 'tool_use', id: b.id, name: toolName, input });
      }
    }

    if (text || thinking || tools.length > 0) {
      const effort = message && typeof message.provider === 'string' && typeof message.model === 'string'
        ? publishedEffort(message.thinkingLevel, modelReasons(message.provider, message.model))
        : undefined;
      messages.push({ kind: 'assistant', content: text, thinking, tools, contentBlocks, ...(effort ? { effort } : {}) });
    }
    // The live view shows a failed call's card after what the call streamed.
    if (failureCard) messages.push({ kind: 'error', content: failureCard });
  }

  return { messages, usage };
}

const AGENT_FILE_READ_CONCURRENCY = 8;

/** Each file read once, at most `AGENT_FILE_READ_CONCURRENCY` at a time; a failed read maps to null. */
async function readAgentFiles(paths: readonly string[]): Promise<Map<string, AgentFile | null>> {
  const results = new Map<string, AgentFile | null>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const path = paths[next++]!;
      const file = await readAgentFile(path).catch((err: unknown) => {
        log('[session-store] reading subagent file %s failed: %O', path, err);
        return null;
      });
      results.set(path, file);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AGENT_FILE_READ_CONCURRENCY, paths.length) }, worker));
  return results;
}

function countToolUses(messages: readonly HistoryAgentMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    for (const block of msg.contentBlocks) {
      if (block.type === 'tool_use') count++;
    }
  }
  return count;
}

/**
 * Attach each replayed `Agent` tool call to its subagent's pi session file, found through the parent
 * branch's invocation entries, so the card rehydrates its nested conversation and outcome. A resume
 * call gets its own card holding only the segment it opened. A call with no invocation entry (sessions
 * recorded before agent files existed) stays a bare tool card.
 */
async function hydrateSubagentCards(
  cwd: string,
  sessionId: string,
  branch: readonly SessionEntry[],
  messages: ReplayMessage[],
): Promise<number> {
  const invocations = new Map<string, AgentInvocationData>();
  for (const inv of agentInvocationsOnBranch(branch)) {
    if (inv.kind === 'subagent') invocations.set(inv.toolCallId, inv);
  }
  if (invocations.size === 0) return 0;
  const injected = injectedAgentResultsOnBranch(branch);

  let files: Map<string, string>;
  try {
    files = (await indexAgentFiles(subagentsDir(ensurePiSessionDir(cwd), sessionId))).paths;
  } catch (err) {
    log('[session-store] indexing subagent files failed for %s: %O', sessionId, err);
    files = new Map();
  }
  const paths = new Set<string>();
  for (const msg of messages) {
    if (msg.kind !== 'assistant') continue;
    for (const tool of msg.tools) {
      const inv = tool.name === TOOL_AGENT ? invocations.get(tool.id) : undefined;
      const path = inv && files.get(inv.id);
      if (path) paths.add(path);
    }
  }
  const agentFiles = await readAgentFiles([...paths]);

  for (const msg of messages) {
    if (msg.kind !== 'assistant') continue;
    for (const tool of msg.tools) {
      if (tool.name !== TOOL_AGENT) continue;
      const inv = invocations.get(tool.id);
      if (!inv) continue;
      tool.sdkAgentId = inv.id;
      if (inv.resume) tool.agentResumedFrom = inv.id;
      const path = files.get(inv.id);
      const file = path ? (agentFiles.get(path) ?? null) : null;
      const segment = file ? segmentForInvocation(file, inv) : undefined;
      if (file?.launch.kind === 'subagent') {
        const { agentType, description, prompt, background } = file.launch;
        tool.agentLaunch = { agentType, description, prompt, background };
        if (file.launch.modelLabel) tool.agentModel = file.launch.modelLabel;
        if (file.launch.templatePath) tool.agentTemplatePath = file.launch.templatePath;
        // A resume segment records the billing of the model it ran on, which a launch written earlier may lack.
        const dollarBilled = segment?.dollarBilled ?? file.launch.dollarBilled;
        if (dollarBilled !== undefined) tool.agentDollarBilled = dollarBilled;
        // The launch's effort describes the launch run only; a resume card shows only what its own segment recorded.
        const effort = inv.resume ? segment?.effort : file.launch.effort;
        if (effort !== undefined) tool.agentEffort = effort;
      }
      if (file && segment) {
        const agentMessages = piMessagesToHistoryAgentMessages(segment.messages, file.stoppedToolCallIds, file.windDownMessages);
        if (agentMessages.length > 0) tool.agentMessages = agentMessages;
        tool.agentToolCount = countToolUses(agentMessages);
        tool.agentUsage = segment.usage;
        if (segment.startTimestamp !== undefined) tool.agentStartTimestamp = segment.startTimestamp;
        if (segment.endTimestamp !== undefined) tool.agentEndTimestamp = segment.endTimestamp;
      }
      const resolved = resolveAgentStatus({
        file: segment?.status,
        toolResult: isAgentToolDetails(tool.metadata) ? tool.metadata : undefined,
        injection: injected.get(tool.id),
      });
      tool.agentStatus = resolved.status;
      if (resolved.result !== undefined) tool.agentResultText = resolved.result;
    }
  }
  return invocations.size;
}

/**
 * Replay a resumed pi session's transcript into a webview host using the existing replay contract
 * (`sessionCleared` → `userReplay`/`assistantReplay`/`errorReplay` → `tokenUsageUpdate` + `sessionUsage` + `done`).
 * Each `userReplay.sdkMessageId` is the pi entry id — the stable rewind/checkpoint key (FR-3). A
 * `compaction` entry on the branch replays as a historical `compactBoundary` + `compactSummary`, mirroring
 * the live post-compaction view (preceding messages hidden, summary marker shown).
 * Resolves to the user entry ids with a rewind control, or null when the file was not read: those with a
 * checkpoint (`rewindableUserIdsOnBranch`), or every prompt when `fileCheckpoints` is false (a chat with no
 * project folder, which can rewind only its conversation).
 */
export async function loadPiSessionHistory(
  cwd: string,
  sessionId: string,
  post: (m: ExtensionToWebviewMessage) => void,
  signal?: AbortSignal,
  modelReasons?: ModelReasonsLookup | Promise<ModelReasonsLookup | undefined>,
  fileCheckpoints = true,
): Promise<string[] | null> {
  // A superseding replay already aborted us — leave the panel to the newer load, don't blank it.
  if (signal?.aborted) return null;
  const totalSpan = perfSpan('replay.total');
  post({ type: 'sessionCleared' });

  // Resolve the webview's replaying state on EVERY terminal path. Without a `done`, a failed/empty
  // load leaves a blank, permanently-spinning panel — the "silent failure that masks the issue" the
  // quality bar forbids. Failures additionally surface an `errorReplay` so the user sees the cause.
  const finish = (): void => post({ type: 'done', data: { type: 'result', session_id: sessionId, is_done: true } });
  const fail = (reason: string): void => {
    // Checked here because every call follows an await, during which a newer replay may have taken the panel.
    if (signal?.aborted) return;
    post({ type: 'errorReplay', content: reason });
    finish();
  };

  const pi = await initPiLoader();
  if (!pi) {
    fail(t('The pi runtime is unavailable, so this conversation could not be loaded.'));
    return null;
  }
  const resolveSpan = perfSpan('replay.resolve');
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  resolveSpan.end();
  if (!filePath) {
    fail(t("This conversation's file could not be found. It may have been deleted."));
    return null;
  }
  const reasons = await modelReasons;
  const piAi = await loadPiAi();
  const isContextOverflow: OverflowTest | undefined = piAi ? (message) => piAi.isContextOverflow(message) : undefined;

  let messages: ReplayMessage[];
  let usage: ContextSnapshot;
  let sessionUsage: SessionUsageMessage;
  let branch: SessionEntry[];
  let checkpointUserIds: string[];
  try {
    const openSpan = perfSpan('replay.open');
    const sm = pi.SessionManager.open(filePath, ensurePiSessionDir(cwd));
    openSpan.end();
    const reconstructSpan = perfSpan('replay.reconstruct');
    const leafId = sm.getLeafId();
    branch = sm.getBranch(leafId ?? undefined);
    ({ messages, usage } = reconstructMessages(branch, reasons, isContextOverflow));
    reconstructSpan.end({ entries: branch.length, items: messages.length });
    const usageSpan = perfSpan('replay.usage');
    sessionUsage = sessionUsageMessage(sm);
    usageSpan.end();
    // Read from the file on every resume path, so replayed turns are rewindable without waiting on the live
    // session. The userEntryId is the same pi entry id used as `userReplay.sdkMessageId`, so the webview links them.
    checkpointUserIds = fileCheckpoints ? rewindableUserIdsOnBranch(branch) : promptUserIdsOnBranch(branch);
  } catch (err) {
    log('[session-store] loadPiSessionHistory failed for %s: %O', sessionId, err);
    fail(t('This conversation could not be opened: {0}', err instanceof Error ? err.message : String(err)));
    return null;
  }
  // A newer replay superseded us mid-load; stop silently (it owns the panel and emits its own done).
  if (signal?.aborted) return checkpointUserIds;

  const hydrateSpan = perfSpan('replay.hydrate');
  const agents = await hydrateSubagentCards(cwd, sessionId, branch, messages);
  hydrateSpan.end({ agents });
  if (signal?.aborted) return checkpointUserIds;

  const approxChars = perfDebugEnabled() ? approxStringLength(messages) : undefined;
  const postSpan = perfSpan('replay.post');
  for (const msg of messages) {
    if (msg.kind === 'user') {
      post({
        type: 'userReplay',
        content: msg.content,
        ...(msg.contentBlocks ? { contentBlocks: msg.contentBlocks } : {}),
        ...(msg.terminalAttachments ? { terminalAttachments: msg.terminalAttachments } : {}),
        isSynthetic: false,
        sdkMessageId: msg.entryId,
        ...(msg.isMidStream ? { isMidStream: true } : {}),
        ...(msg.promptIndex !== undefined ? { promptIndex: msg.promptIndex } : {}),
        ...(msg.sentAt !== undefined ? { timestamp: msg.sentAt } : {}),
      });
    } else if (msg.kind === 'steer') {
      post({
        type: 'userReplay',
        content: msg.message,
        ...(msg.images ? { contentBlocks: msg.images } : {}),
        isSynthetic: false,
        isInjected: true,
        steerTarget: {
          agentId: msg.agentId,
          ...(msg.agentType ? { agentType: msg.agentType } : {}),
          ...(msg.description ? { description: msg.description } : {}),
        },
        ...(msg.sentAt !== undefined ? { timestamp: msg.sentAt } : {}),
      });
    } else if (msg.kind === 'error') {
      post({ type: 'errorReplay', content: msg.content });
    } else if (msg.kind === 'compaction') {
      post({
        type: 'compactBoundary',
        preTokens: msg.preTokens,
        trigger: 'manual',
        isHistorical: true,
        ...(msg.summary ? { summary: msg.summary } : {}),
        ...(msg.timestamp ? { timestamp: msg.timestamp } : {}),
        ...(msg.entryId ? { entryId: msg.entryId } : {}),
      });
      if (msg.summary) post({ type: 'compactSummary', summary: msg.summary });
    } else {
      post({
        type: 'assistantReplay',
        content: msg.content,
        ...(msg.thinking ? { thinking: msg.thinking } : {}),
        ...(msg.tools.length > 0 ? { tools: msg.tools } : {}),
        ...(msg.contentBlocks.length > 0 ? { contentBlocks: msg.contentBlocks } : {}),
        ...(msg.effort ? { effort: msg.effort } : {}),
      });
    }
  }
  postSpan.end({ items: messages.length, approxChars });
  if (signal?.aborted) return checkpointUserIds;

  post({
    type: 'tokenUsageUpdate',
    inputTokens: usage.input,
    cacheCreationTokens: usage.cacheWrite,
    cacheReadTokens: usage.cacheRead,
  });
  post(sessionUsage);
  if (checkpointUserIds.length > 0) {
    post({ type: 'checkpointInfo', userMessageIds: checkpointUserIds });
  }
  finish();
  totalSpan.end({ items: messages.length });
  return checkpointUserIds;
}
