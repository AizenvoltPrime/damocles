import type { TeamAgentContentBlock, TeamAgentHistoryMessage } from '../../shared/types/team';
import type { ToolAbandonReason } from '../../shared/types/session';
import { joinResultText, resultImageCount } from '../pi-session/tool-result-text';
import { toImageBlocks } from '../pi-session/branch-text';
import { mapPiToolName, normalizeToolInput, normalizeToolDetails } from '../pi-session/tool-normalization';
import type { PersistedAgentMessage } from '../pi-session/agent-records';
import { failedCallError } from '../pi-session/nested-call-failures';
import { abandonReasonOf, skippedToolCalls } from '../pi-session/abandoned-tool-calls';

/**
 * Team member card blocks, built from pi's content. The live stream and a reopened member's pi session
 * file both go through these, so a reloaded card shows exactly what the live one did.
 */

export interface PiAssistantBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

const NONE_SKIPPED: ReadonlySet<string> = new Set();

/**
 * `abandoned`: the call ended on an error or aborted stop (`abandonReasonOf`), so pi never runs a tool it named.
 * `skipped`: the calls an abort cut from this message's batch, which are `stopped`: those it skipped (`skippedToolCalls`)
 * and those it settled before they ran (`unexecutedStoppedCalls`).
 */
export function assistantContentBlocks(content: ReadonlyArray<PiAssistantBlock>, abandoned: ToolAbandonReason | undefined, skipped: ReadonlySet<string> = NONE_SKIPPED): TeamAgentContentBlock[] {
  const blocks: TeamAgentContentBlock[] = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) {
      blocks.push({ type: 'text', text: b.text });
    } else if (b.type === 'thinking') {
      blocks.push({ type: 'thinking', thinking: b.thinking ?? '' });
    } else if (b.type === 'toolCall' && b.id && b.name) {
      const reason = skipped.has(b.id) ? 'stopped' : abandoned;
      // normalizeToolInput switches on the raw pi name, so it takes b.name and never the mapped one.
      blocks.push({ type: 'tool_use', id: b.id, name: mapPiToolName(b.name), input: normalizeToolInput(b.name, b.arguments ?? {}), ...(reason ? { abandoned: reason } : {}) });
    }
  }
  return blocks;
}

/** The ids of the calls an aborted message's abort cut from `previous`, the assistant message before it. */
export function skippedCallIds(previous: ReadonlyArray<PiAssistantBlock>, hasResult: (toolCallId: string) => boolean): Set<string> {
  const calls = previous.flatMap((b) => (b.type === 'toolCall' && b.id ? [{ id: b.id }] : []));
  return new Set(skippedToolCalls(calls, hasResult).map((call) => call.id));
}

/** `result` is a tool result, or a persisted `toolResult` message; both carry `content` and `details`. */
export function toolResultBlock(toolCallId: string, result: unknown, isError: boolean): Extract<TeamAgentContentBlock, { type: 'tool_result' }> {
  const details = (result as { details?: unknown } | undefined)?.details;
  // The cancelled marker lives in the details, so the card knows a stopped call only through `metadata`.
  const metadata = details && typeof details === 'object' ? normalizeToolDetails(details as Record<string, unknown>) : undefined;
  const imageCount = isError ? 0 : resultImageCount(result);
  return {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content: joinResultText(result),
    is_error: isError,
    ...(imageCount > 0 ? { imageCount } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } => typeof c === 'object' && c !== null && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/**
 * The calls a turn-stopped entry names that pi never executed: an aborted run settled them before `execute`,
 * so their result carries no `durationMs`. They show stopped, without the result pi wrote while stopping.
 */
export function unexecutedStoppedCalls(messages: readonly PersistedAgentMessage[], stoppedToolCallIds: ReadonlySet<string>): Set<string> {
  const executed = new Set(messages.flatMap((m) => (m.role === 'toolResult' && typeof m['durationMs'] === 'number' && typeof m['toolCallId'] === 'string' ? [m['toolCallId']] : [])));
  return new Set([...stoppedToolCallIds].filter((id) => !executed.has(id)));
}

const NONE_WOUND_DOWN: ReadonlySet<PersistedAgentMessage> = new Set();

/**
 * One card message per pi message with an entry id, in session order. `stoppedToolCallIds`: the calls the
 * member file's turn-stopped entries name (`AgentFile.stoppedToolCallIds`). `windDown`: the error stops that
 * were an abort's wind-down (`AgentFile.windDownMessages`), mapped as aborted stops.
 */
export function memberHistoryMessages(
  messages: readonly PersistedAgentMessage[],
  entryIds: ReadonlyMap<PersistedAgentMessage, string>,
  stoppedToolCallIds: ReadonlySet<string> = NONE_SKIPPED,
  windDown: ReadonlySet<PersistedAgentMessage> = NONE_WOUND_DOWN,
): TeamAgentHistoryMessage[] {
  const out: TeamAgentHistoryMessage[] = [];
  const answered = new Set(messages.flatMap((m) => (m.role === 'toolResult' && typeof m['toolCallId'] === 'string' ? [m['toolCallId']] : [])));
  const unexecuted = unexecutedStoppedCalls(messages, stoppedToolCallIds);
  /** The latest assistant message with its card, which an aborted one that follows may have cut short. */
  let batch: { index: number; content: PiAssistantBlock[] } | null = null;
  for (const message of messages) {
    const id = entryIds.get(message);
    if (id === undefined) continue;
    if (message.role === 'user') {
      out.push({ id, role: 'user', content: [{ type: 'text', text: userText(message['content']) }, ...toImageBlocks(message['content'])] });
    } else if (message.role === 'assistant' && Array.isArray(message['content'])) {
      const woundDown = windDown.has(message);
      const failed = message['stopReason'] === 'error' && !woundDown;
      const content = message['content'] as PiAssistantBlock[];
      const abandoned = woundDown ? 'stopped' : abandonReasonOf(message['stopReason']);
      // The live runner re-seals the cut message with these blocks under its id, so the merge matches the copies.
      if (abandoned === 'stopped' && batch) {
        const skipped = skippedCallIds(batch.content, (toolCallId) => answered.has(toolCallId));
        const cut = out[batch.index];
        if (cut && skipped.size > 0) out[batch.index] = { ...cut, content: assistantContentBlocks(batch.content, undefined, new Set([...skipped, ...unexecuted])) };
      }
      const blocks = assistantContentBlocks(content, abandoned, unexecuted);
      batch = null;
      if (blocks.length > 0) {
        out.push({ id, role: 'assistant', content: blocks });
        batch = { index: out.length - 1, content };
      }
      // The file reader drops a call pi re-ran, so every error stop here is one pi did not recover.
      if (failed) out.push({ id: `${id}:error`, role: 'error', content: [{ type: 'text', text: failedCallError(message['errorMessage']) }] });
    } else if (message.role === 'toolResult' && typeof message['toolCallId'] === 'string' && !unexecuted.has(message['toolCallId'])) {
      out.push({ id, role: 'toolResult', content: [toolResultBlock(message['toolCallId'], message, message['isError'] === true)] });
    }
  }
  return out;
}
