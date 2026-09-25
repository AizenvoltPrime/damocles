import type { TeamAgentContentBlock, TeamAgentHistoryMessage } from '../../shared/types/team';
import { joinResultText } from '../pi-session/tool-result-text';
import { toImageBlocks } from '../pi-session/branch-text';
import { mapPiToolName, normalizeToolInput, normalizeToolDetails } from '../pi-session/tool-normalization';
import type { PersistedAgentMessage } from '../pi-session/agent-records';

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

export function assistantContentBlocks(content: ReadonlyArray<PiAssistantBlock>): TeamAgentContentBlock[] {
  const blocks: TeamAgentContentBlock[] = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) {
      blocks.push({ type: 'text', text: b.text });
    } else if (b.type === 'thinking') {
      blocks.push({ type: 'thinking', thinking: b.thinking ?? '' });
    } else if (b.type === 'toolCall' && b.id && b.name) {
      // normalizeToolInput switches on the raw pi name, so it takes b.name and never the mapped one.
      blocks.push({ type: 'tool_use', id: b.id, name: mapPiToolName(b.name), input: normalizeToolInput(b.name, b.arguments ?? {}) });
    }
  }
  return blocks;
}

/** `result` is a tool result, or a persisted `toolResult` message; both carry `content` and `details`. */
export function toolResultBlock(toolCallId: string, result: unknown, isError: boolean): Extract<TeamAgentContentBlock, { type: 'tool_result' }> {
  const details = (result as { details?: unknown } | undefined)?.details;
  // The cancelled marker lives in the details, so the card knows a stopped call only through `metadata`.
  const metadata = details && typeof details === 'object' ? normalizeToolDetails(details as Record<string, unknown>) : undefined;
  return {
    type: 'tool_result',
    tool_use_id: toolCallId,
    content: joinResultText(result),
    is_error: isError,
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

/** One card message per pi message with an entry id, in session order. */
export function memberHistoryMessages(
  messages: readonly PersistedAgentMessage[],
  entryIds: ReadonlyMap<PersistedAgentMessage, string>,
): TeamAgentHistoryMessage[] {
  const out: TeamAgentHistoryMessage[] = [];
  for (const message of messages) {
    const id = entryIds.get(message);
    if (id === undefined) continue;
    if (message.role === 'user') {
      out.push({ id, role: 'user', content: [{ type: 'text', text: userText(message['content']) }, ...toImageBlocks(message['content'])] });
    } else if (message.role === 'assistant' && Array.isArray(message['content'])) {
      const blocks = assistantContentBlocks(message['content'] as PiAssistantBlock[]);
      if (blocks.length > 0) out.push({ id, role: 'assistant', content: blocks });
    } else if (message.role === 'toolResult' && typeof message['toolCallId'] === 'string') {
      out.push({ id, role: 'toolResult', content: [toolResultBlock(message['toolCallId'], message, message['isError'] === true)] });
    }
  }
  return out;
}
