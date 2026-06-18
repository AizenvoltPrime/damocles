/**
 * message-mapper.ts — Map pi session messages → the webview `HistoryAgentMessage[]` shape.
 *
 * New for the Damocles port. The subagent card renders its nested conversation from
 * `HistoryAgentMessage` (`{ role, contentBlocks }`). This maps pi's `AgentMessage[]`, pairing each
 * `toolResult` message back to its originating `toolCall` id so the tool_use block carries its result.
 * Tool names/inputs go through the same normalization the parent stream uses, so nested tool cards
 * render identically.
 */

import type { HistoryAgentContentBlock, HistoryAgentMessage } from '../../../shared/types/content';
import { mapPiToolName, normalizeToolInput } from '../tool-normalization';

interface PiTextBlock {
  type: 'text';
  text?: string;
}
interface PiThinkingBlock {
  type: 'thinking';
  thinking?: string;
}
interface PiToolCallBlock {
  type: 'toolCall';
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}
type PiAssistantBlock = PiTextBlock | PiThinkingBlock | PiToolCallBlock;

interface PiMessageLike {
  role: 'user' | 'assistant' | 'toolResult' | string;
  content: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/** Join the text blocks of a content array (or a raw string) into one string. */
function joinText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && (c as { type?: string }).type === 'text')
    .map((c) => (c as { text?: string }).text ?? '')
    .join('');
}

/** Map pi `session.messages` to the webview's `HistoryAgentMessage[]`. Pure — no session access. */
export function piMessagesToHistoryAgentMessages(messages: readonly unknown[]): HistoryAgentMessage[] {
  // First pass: collect tool results (text + error flag) keyed by the tool-call id they answer.
  const resultsById = new Map<string, { text: string; isError: boolean }>();
  for (const raw of messages) {
    const msg = raw as PiMessageLike;
    if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string') {
      resultsById.set(msg.toolCallId, { text: joinText(msg.content), isError: msg.isError === true });
    }
  }

  const out: HistoryAgentMessage[] = [];
  for (const raw of messages) {
    const msg = raw as PiMessageLike;
    if (msg.role === 'user') {
      const text = joinText(msg.content);
      if (text.trim()) out.push({ role: 'user', contentBlocks: [{ type: 'text', text }] });
      continue;
    }
    if (msg.role !== 'assistant') continue; // toolResult messages fold into tool_use blocks

    const blocks: HistoryAgentContentBlock[] = [];
    const content = Array.isArray(msg.content) ? (msg.content as PiAssistantBlock[]) : [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        blocks.push({ type: 'thinking', thinking: block.thinking });
      } else if (block.type === 'toolCall') {
        const result = resultsById.get(block.id);
        blocks.push({
          type: 'tool_use',
          id: block.id,
          name: mapPiToolName(block.name),
          input: normalizeToolInput(block.name, block.arguments ?? {}),
          ...(result !== undefined ? { result: result.text } : {}),
          ...(result?.isError ? { isError: true } : {}),
        });
      }
    }
    if (blocks.length > 0) out.push({ role: 'assistant', contentBlocks: blocks });
  }
  return out;
}
