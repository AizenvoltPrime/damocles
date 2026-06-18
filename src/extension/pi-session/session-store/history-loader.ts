import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';
import type { ContentBlock, HistoryToolCall } from '@shared/types/content';
import { initPiLoader } from '../pi-loader';
import { log } from '../../logger';
import { mapPiToolName, normalizeToolInput, normalizeToolDetails } from '../tool-normalization';
import { getCheckpointEntries } from '../checkpoints';
import { readSubagentTranscripts } from '../subagents/output-file';
import { TOOL_AGENT } from '../../../shared/tool-names';
import { ensurePiSessionDir } from './session-dir';
import { resolvePiSessionFile } from './reading';

type ValidMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
const VALID_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

interface PiToolResult {
  text: string;
  isError: boolean;
  details?: Record<string, unknown>;
}

interface ReplayUser {
  kind: 'user';
  entryId: string;
  content: string;
  contentBlocks?: ContentBlock[];
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
type ReplayMessage = ReplayUser | ReplayAssistant | ReplayError;

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Reverse-map pi image blocks to the webview `{ source: { base64 } }` shape, with the user text. */
function userContentBlocks(content: unknown): ContentBlock[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const images = content.filter(
    (b): b is { type: 'image'; data: string; mimeType: string } =>
      !!b && (b as { type?: string }).type === 'image' && VALID_MEDIA_TYPES.has((b as { mimeType?: string }).mimeType ?? ''),
  );
  if (images.length === 0) return undefined;
  const text = textOf(content);
  return [
    ...images.map((img) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: img.mimeType as ValidMediaType, data: img.data },
    })),
    ...(text ? [{ type: 'text' as const, text }] : []),
  ];
}

/**
 * Reconstruct the displayable replay messages from a pi session's active branch (root→leaf order),
 * pairing assistant `toolCall` blocks with their `toolResult` message entries and skipping inert
 * custom entries (`damocles-checkpoint` / `damocles-user-renamed`) and non-message entry types.
 */
function reconstructMessages(branch: readonly SessionEntry[]): { messages: ReplayMessage[]; usage: UsageTotals } {
  const toolResults = new Map<string, PiToolResult>();
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message = (entry as { message?: { role?: string; toolCallId?: string; content?: unknown; details?: unknown; isError?: boolean } }).message;
    if (message?.role !== 'toolResult' || !message.toolCallId) continue;
    toolResults.set(message.toolCallId, {
      text: textOf(message.content),
      isError: message.isError === true,
      ...(message.details && typeof message.details === 'object' ? { details: message.details as Record<string, unknown> } : {}),
    });
  }

  const messages: ReplayMessage[] = [];
  const usage: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message = (entry as {
      message?: {
        role?: string;
        content?: unknown;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
        stopReason?: string;
        errorMessage?: string;
      };
    }).message;
    const role = message?.role;

    if (role === 'user') {
      const content = textOf(message?.content);
      if (!content && !Array.isArray(message?.content)) continue;
      const blocks = userContentBlocks(message?.content);
      messages.push({ kind: 'user', entryId: entry.id, content, ...(blocks ? { contentBlocks: blocks } : {}) });
      continue;
    }

    if (role !== 'assistant') continue;

    if (message?.usage) {
      // Output is the session's cumulative spend (summed). Input + cache, however, are the CURRENT
      // context-window occupancy, which is the LAST assistant message's snapshot — not a sum. A
      // multi-step turn makes several LLM calls and each re-reads the same context, so summing
      // double-counts it (e.g. turn-1 cacheWrite ≈ turn-2 cacheRead). This matches the live adapter,
      // which emits per-message and lets the webview snap to the latest (pi's context usage = last usage).
      usage.output += message.usage.output ?? 0;
      usage.input = message.usage.input ?? 0;
      usage.cacheRead = message.usage.cacheRead ?? 0;
      usage.cacheWrite = message.usage.cacheWrite ?? 0;
    }

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

/**
 * Attach each replayed `Agent` tool call to its subagent transcript on disk so the resumed parent card
 * rehydrates its nested conversation, model, and tool count (§4.8). Best-effort: missing/unreadable
 * transcripts leave the card as a bare tool entry rather than failing the session load. Keyed by the
 * spawning `Agent` tool-call id (the webview subagent-card key), which the transcript records natively.
 */
async function hydrateSubagentTranscripts(cwd: string, sessionId: string, messages: ReplayMessage[]): Promise<void> {
  const hasAgentTool = messages.some((m) => m.kind === 'assistant' && m.tools.some((t) => t.name === TOOL_AGENT));
  if (!hasAgentTool) return;

  let transcripts: Awaited<ReturnType<typeof readSubagentTranscripts>>;
  try {
    transcripts = await readSubagentTranscripts(cwd, sessionId);
  } catch (err) {
    log('[session-store] subagent transcript hydrate failed for %s: %O', sessionId, err);
    return;
  }
  if (transcripts.size === 0) return;

  for (const msg of messages) {
    if (msg.kind !== 'assistant') continue;
    for (const tool of msg.tools) {
      if (tool.name !== TOOL_AGENT) continue;
      const transcript = transcripts.get(tool.id);
      if (!transcript) continue;
      tool.sdkAgentId = transcript.agentId;
      if (transcript.messages.length > 0) tool.agentMessages = transcript.messages;
      if (transcript.model) tool.agentModel = transcript.model;
      if (transcript.templatePath) tool.agentTemplatePath = transcript.templatePath;
      if (transcript.startTimestamp !== undefined) tool.agentStartTimestamp = transcript.startTimestamp;
      if (transcript.endTimestamp !== undefined) tool.agentEndTimestamp = transcript.endTimestamp;
      tool.agentToolCount = transcript.totalToolUseCount;
      if (transcript.status) tool.agentStatus = transcript.status;
      if (transcript.finalResult !== undefined) tool.agentResultText = transcript.finalResult;
    }
  }
}

/**
 * Replay a resumed pi session's transcript into a webview host using the existing replay contract
 * (`sessionCleared` → `userReplay`/`assistantReplay`/`errorReplay` → `tokenUsageUpdate` + `done`).
 * Each `userReplay.sdkMessageId` is the pi entry id — the stable rewind/checkpoint key (FR-3). No
 * `compactBoundary` is emitted (compaction is force-disabled on the pi path).
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
  const finish = (numTurns: number, outputTokens: number): void =>
    post({
      type: 'done',
      data: { type: 'result', session_id: sessionId, is_done: true, total_output_tokens: outputTokens, num_turns: numTurns },
    });
  const fail = (reason: string): void => {
    post({ type: 'errorReplay', content: reason });
    finish(0, 0);
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
  let usage: UsageTotals;
  const checkpointUserIds: string[] = [];
  try {
    const sm = pi.SessionManager.open(filePath, ensurePiSessionDir(cwd));
    const leafId = sm.getLeafId();
    const branch = sm.getBranch(leafId ?? undefined);
    ({ messages, usage } = reconstructMessages(branch));
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

  await hydrateSubagentTranscripts(cwd, sessionId, messages);
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
        promptIndex: promptIndex++,
        nodeId: null,
      });
    } else if (msg.kind === 'error') {
      post({ type: 'errorReplay', content: msg.content });
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
    outputTokens: usage.output,
  });
  if (checkpointUserIds.length > 0) {
    post({ type: 'checkpointInfo', userMessageIds: checkpointUserIds });
  }
  finish(promptIndex, usage.output);
}
