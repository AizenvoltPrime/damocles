import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { ContentBlock, HistoryAgentMessage, HistoryToolCall, ImageBlock } from '@shared/types/content';
import { initPiLoader } from '../pi-loader';
import { log } from '../../logger';
import { mapPiToolName, normalizeToolInput, normalizeToolDetails } from '../tool-normalization';
import { getCheckpointEntries } from '../checkpoints';
import { piMessagesToHistoryAgentMessages } from '../subagents/message-mapper';
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
import { extractOriginalInputs } from './original-input';
import { extractMidStreamEntryIds } from './mid-stream';
import { isSteerData } from './steer';
import { DAMOCLES_STEER_ENTRY } from './constants';
import { stripIdeContext } from './ide-context';
import { toImageBlocks } from '../branch-text';
import { resultImageCount } from '../tool-result-text';
import { sessionUsageMessage, type SessionUsageMessage } from '../session-usage';
import { contextSnapshotOf, emptyContextSnapshot, type ContextSnapshot } from '../context-snapshot';

interface PiToolResult {
  text: string;
  isError: boolean;
  imageCount?: number;
  details?: Record<string, unknown>;
}

interface ReplayUser {
  kind: 'user';
  entryId: string;
  content: string;
  contentBlocks?: ContentBlock[];
  isMidStream?: boolean;
}
interface ReplayAssistant {
  kind: 'assistant';
  content: string;
  thinking: string;
  tools: HistoryToolCall[];
  contentBlocks: ContentBlock[];
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
}
type ReplayMessage = ReplayUser | ReplayAssistant | ReplayError | ReplayCompaction | ReplaySteer;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('');
}

function userVisibleText(content: unknown): string {
  if (typeof content === 'string') return stripIdeContext(content);
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text')
    .map((b) => stripIdeContext(b.text))
    .join('');
}

/** Reverse-map pi image blocks to the webview `{ source: { base64 } }` shape, with the user text.
 *  `overrideText` substitutes the displayed text (the original typed input when a slash command was expanded). */
function userContentBlocks(content: unknown, overrideText?: string): ContentBlock[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const images = toImageBlocks(content);
  if (images.length === 0) return undefined;
  const text = overrideText ?? userVisibleText(content);
  return [...images, ...(text ? [{ type: 'text' as const, text }] : [])];
}

/**
 * Reconstruct the displayable replay messages from a pi session's active branch (root→leaf order),
 * pairing assistant `toolCall` blocks with their `toolResult` message entries and skipping inert
 * custom entries (`damocles-checkpoint` / `damocles-user-renamed` / `damocles-original-input` /
 * `damocles-mid-stream`) and non-message entry types. A user message whose typed slash command was
 * expanded is shown as the original text from its `damocles-original-input` sidecar, not the stored
 * expansion; a user message flagged by `damocles-mid-stream` carries `isMidStream` for replay styling.
 * The `damocles-steer` custom entry is NOT skipped — it is mapped in position to a replayed amber
 * injected "You steered" chip.
 */
export function reconstructMessages(branch: readonly SessionEntry[]): { messages: ReplayMessage[]; usage: ContextSnapshot } {
  const originalInputs = extractOriginalInputs(branch);
  const midStreamIds = extractMidStreamEntryIds(branch);
  const toolResults = new Map<string, PiToolResult>();
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message = (entry as { message?: { role?: string; toolCallId?: string; content?: unknown; details?: unknown; isError?: boolean } }).message;
    if (message?.role !== 'toolResult' || !message.toolCallId) continue;
    const isError = message.isError === true;
    const imageCount = isError ? 0 : resultImageCount(message);
    toolResults.set(message.toolCallId, {
      text: textOf(message.content),
      isError,
      ...(imageCount > 0 ? { imageCount } : {}),
      ...(message.details && typeof message.details === 'object' ? { details: message.details as Record<string, unknown> } : {}),
    });
  }

  const messages: ReplayMessage[] = [];
  let usage = emptyContextSnapshot();

  for (const entry of branch) {
    if (entry.type === 'compaction') {
      // pi compaction summarizes (and the live view hides) every preceding message. Mirror that on replay:
      // drop the display messages accumulated so far and surface a summary marker in their place. Prior
      // markers are kept so a session compacted more than once shows a boundary for each.
      const keptMarkers = messages.filter((m) => m.kind === 'compaction');
      messages.length = 0;
      messages.push(...keptMarkers);
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
      if (isSteerData(data))
        messages.push({
          kind: 'steer',
          agentId: data.agentId,
          ...(data.agentType ? { agentType: data.agentType } : {}),
          ...(data.description ? { description: data.description } : {}),
          message: data.message,
          ...(data.images ? { images: data.images } : {}),
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
      };
    }).message;
    const role = message?.role;

    if (role === 'user') {
      const original = originalInputs.get(entry.id);
      const content = original ?? userVisibleText(message?.content);
      if (!content && !Array.isArray(message?.content)) continue;
      const blocks = userContentBlocks(message?.content, original);
      messages.push({
        kind: 'user',
        entryId: entry.id,
        content,
        ...(blocks ? { contentBlocks: blocks } : {}),
        ...(midStreamIds.has(entry.id) ? { isMidStream: true } : {}),
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

    if (message?.stopReason === 'error' && message.errorMessage) {
      messages.push({ kind: 'error', content: message.errorMessage });
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
        const result = toolResults.get(b.id);
        const tool: HistoryToolCall = { id: b.id, name: toolName, input };
        if (result) {
          tool.result = result.text;
          tool.isError = result.isError;
          if (result.imageCount !== undefined) tool.imageCount = result.imageCount;
          if (result.details) tool.metadata = normalizeToolDetails(result.details);
        }
        tools.push(tool);
        contentBlocks.push({ type: 'tool_use', id: b.id, name: toolName, input });
      }
    }

    if (!text && !thinking && tools.length === 0) continue;
    messages.push({ kind: 'assistant', content: text, thinking, tools, contentBlocks });
  }

  return { messages, usage };
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
): Promise<void> {
  const invocations = new Map<string, AgentInvocationData>();
  for (const inv of agentInvocationsOnBranch(branch)) {
    if (inv.kind === 'subagent') invocations.set(inv.toolCallId, inv);
  }
  if (invocations.size === 0) return;
  const injected = injectedAgentResultsOnBranch(branch);

  let files: Map<string, string>;
  try {
    files = await indexAgentFiles(subagentsDir(ensurePiSessionDir(cwd), sessionId));
  } catch (err) {
    log('[session-store] indexing subagent files failed for %s: %O', sessionId, err);
    files = new Map();
  }
  const read = new Map<string, Promise<AgentFile | null>>();
  const readOnce = (path: string): Promise<AgentFile | null> => {
    let pending = read.get(path);
    if (!pending) {
      pending = readAgentFile(path).catch((err: unknown) => {
        log('[session-store] reading subagent file %s failed: %O', path, err);
        return null;
      });
      read.set(path, pending);
    }
    return pending;
  };

  for (const msg of messages) {
    if (msg.kind !== 'assistant') continue;
    for (const tool of msg.tools) {
      if (tool.name !== TOOL_AGENT) continue;
      const inv = invocations.get(tool.id);
      if (!inv) continue;
      tool.sdkAgentId = inv.id;
      if (inv.resume) tool.agentResumedFrom = inv.id;
      const path = files.get(inv.id);
      const file = path ? await readOnce(path) : null;
      const segment = file ? segmentForInvocation(file, inv) : undefined;
      if (file?.launch.kind === 'subagent') {
        const { agentType, description, prompt, background } = file.launch;
        tool.agentLaunch = { agentType, description, prompt, background };
        if (file.launch.modelLabel) tool.agentModel = file.launch.modelLabel;
        if (file.launch.templatePath) tool.agentTemplatePath = file.launch.templatePath;
        // A resume segment records the billing of the model it ran on, which a launch written earlier may lack.
        const dollarBilled = segment?.dollarBilled ?? file.launch.dollarBilled;
        if (dollarBilled !== undefined) tool.agentDollarBilled = dollarBilled;
      }
      if (segment) {
        const agentMessages = piMessagesToHistoryAgentMessages(segment.messages);
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
}

/**
 * Replay a resumed pi session's transcript into a webview host using the existing replay contract
 * (`sessionCleared` → `userReplay`/`assistantReplay`/`errorReplay` → `tokenUsageUpdate` + `sessionUsage` + `done`).
 * Each `userReplay.sdkMessageId` is the pi entry id — the stable rewind/checkpoint key (FR-3). A
 * `compaction` entry on the branch replays as a historical `compactBoundary` + `compactSummary`, mirroring
 * the live post-compaction view (preceding messages hidden, summary marker shown).
 */
export async function loadPiSessionHistory(
  cwd: string,
  sessionId: string,
  post: (m: ExtensionToWebviewMessage) => void,
  signal?: AbortSignal,
): Promise<void> {
  // A superseding replay already aborted us — leave the panel to the newer load, don't blank it.
  if (signal?.aborted) return;
  post({ type: 'sessionCleared' });

  // Resolve the webview's replaying state on EVERY terminal path. Without a `done`, a failed/empty
  // load leaves a blank, permanently-spinning panel — the "silent failure that masks the issue" the
  // quality bar forbids. Failures additionally surface an `errorReplay` so the user sees the cause.
  const finish = (): void => post({ type: 'done', data: { type: 'result', session_id: sessionId, is_done: true } });
  const fail = (reason: string): void => {
    post({ type: 'errorReplay', content: reason });
    finish();
  };

  const pi = await initPiLoader();
  if (!pi) {
    fail('The pi runtime is unavailable, so this session could not be loaded.');
    return;
  }
  const filePath = await resolvePiSessionFile(cwd, sessionId);
  if (!filePath) {
    fail('This session’s file could not be found — it may have been deleted.');
    return;
  }

  let messages: ReplayMessage[];
  let usage: ContextSnapshot;
  let sessionUsage: SessionUsageMessage;
  let branch: SessionEntry[];
  const checkpointUserIds: string[] = [];
  try {
    const sm = pi.SessionManager.open(filePath, ensurePiSessionDir(cwd));
    const leafId = sm.getLeafId();
    branch = sm.getBranch(leafId ?? undefined);
    ({ messages, usage } = reconstructMessages(branch));
    sessionUsage = sessionUsageMessage(sm);
    // Re-surface checkpoints so resumed turns are immediately rewindable, on EVERY resume path (the
    // `ready` auto-resume defers the live session — and its hydrate — until the first message). The
    // userEntryId is the same pi entry id used as `userReplay.sdkMessageId`, so the webview links them.
    const seen = new Set<string>();
    for (const cp of getCheckpointEntries(branch)) {
      if (!seen.has(cp.userEntryId)) {
        seen.add(cp.userEntryId);
        checkpointUserIds.push(cp.userEntryId);
      }
    }
  } catch (err) {
    log('[session-store] loadPiSessionHistory failed for %s: %O', sessionId, err);
    fail(`Failed to load this session: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // A newer replay superseded us mid-load; stop silently (it owns the panel and emits its own done).
  if (signal?.aborted) return;

  await hydrateSubagentCards(cwd, sessionId, branch, messages);
  if (signal?.aborted) return;

  let promptIndex = 0;
  for (const msg of messages) {
    if (msg.kind === 'user') {
      post({
        type: 'userReplay',
        content: msg.content,
        ...(msg.contentBlocks ? { contentBlocks: msg.contentBlocks } : {}),
        isSynthetic: false,
        sdkMessageId: msg.entryId,
        ...(msg.isMidStream ? { isMidStream: true } : {}),
        promptIndex: promptIndex++,
      });
    } else if (msg.kind === 'steer') {
      // An injected chip consumes NO prompt index — the counting predicate excludes injected messages
      // (session.ts:178), so surrounding real prompts must keep their indices. Post the CURRENT value.
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
        promptIndex: promptIndex,
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
      });
    }
  }
  if (signal?.aborted) return;

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
}
