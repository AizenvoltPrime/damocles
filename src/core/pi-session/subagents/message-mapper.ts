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
import { mapPiToolName, normalizeToolDetails, normalizeToolInput } from '../tool-normalization';
import { toImageBlocks } from '../branch-text';
import { resultImageCount } from '../tool-result-text';
import { failedCallError } from '../nested-call-failures';
import { abandonReasonOf, skippedToolCalls } from '../abandoned-tool-calls';

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
  details?: unknown;
  durationMs?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
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

const NONE_STOPPED: ReadonlySet<string> = new Set();
const NONE_WOUND_DOWN: ReadonlySet<unknown> = new Set();

/**
 * Map pi `session.messages` to the webview's `HistoryAgentMessage[]`. Pure — no session access.
 * `stoppedToolCallIds`: the calls the session's turn-stopped entries name (`AgentFile.stoppedToolCallIds`).
 * `windDown`: the error stops that were an abort's wind-down (`AgentFile.windDownMessages`), mapped as aborted stops.
 */
export function piMessagesToHistoryAgentMessages(
  messages: readonly unknown[],
  stoppedToolCallIds: ReadonlySet<string> = NONE_STOPPED,
  windDown: ReadonlySet<unknown> = NONE_WOUND_DOWN,
): HistoryAgentMessage[] {
  // First pass: collect tool results keyed by the tool-call id they answer.
  const resultsById = new Map<string, { text: string; isError: boolean; imageCount: number; metadata?: Record<string, unknown>; durationMs?: number }>();
  for (const raw of messages) {
    const msg = raw as PiMessageLike;
    if (msg.role === 'toolResult' && typeof msg.toolCallId === 'string') {
      const isError = msg.isError === true;
      // The details carry what the live card got through `toolMetadata`: an edit's patch, a cancelled marker.
      const metadata = msg.details && typeof msg.details === 'object' ? normalizeToolDetails(msg.details as Record<string, unknown>) : undefined;
      resultsById.set(msg.toolCallId, {
        text: joinText(msg.content),
        isError,
        imageCount: isError ? 0 : resultImageCount(msg),
        ...(metadata ? { metadata } : {}),
        ...(typeof msg.durationMs === 'number' ? { durationMs: msg.durationMs } : {}),
      });
    }
  }

  const out: HistoryAgentMessage[] = [];
  /** The tool_use blocks of the latest assistant message, which an aborted one that follows may have cut short. */
  let batch: Array<Extract<HistoryAgentContentBlock, { type: 'tool_use' }>> = [];
  for (const raw of messages) {
    const msg = raw as PiMessageLike;
    if (msg.role === 'user') {
      const text = joinText(msg.content);
      const images = toImageBlocks(msg.content);
      if (text.trim() || images.length) {
        out.push({ role: 'user', contentBlocks: [...(text.trim() ? [{ type: 'text' as const, text }] : []), ...images] });
      }
      continue;
    }
    if (msg.role !== 'assistant') continue; // toolResult messages fold into tool_use blocks

    const blocks: HistoryAgentContentBlock[] = [];
    const content = Array.isArray(msg.content) ? (msg.content as PiAssistantBlock[]) : [];
    const woundDown = windDown.has(raw);
    const failed = msg.stopReason === 'error' && !woundDown;
    // pi ends a turn whose call failed or was aborted before it executes any tool that call named.
    const abandoned = woundDown ? 'stopped' : abandonReasonOf(msg.stopReason);
    if (abandoned === 'stopped') {
      for (const block of skippedToolCalls(batch, (id) => resultsById.has(id))) block.abandoned = 'stopped';
    }
    batch = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        blocks.push({ type: 'text', text: block.text });
      } else if (block.type === 'thinking' && block.thinking) {
        blocks.push({ type: 'thinking', thinking: block.thinking });
      } else if (block.type === 'toolCall') {
        const recorded = resultsById.get(block.id);
        // A call the aborted run settled before it ran shows not executed, without the result pi wrote while stopping.
        const unexecuted = stoppedToolCallIds.has(block.id) && recorded?.durationMs === undefined;
        const result = unexecuted ? undefined : recorded;
        const reason = unexecuted ? 'stopped' : abandoned;
        const toolUse: Extract<HistoryAgentContentBlock, { type: 'tool_use' }> = {
          type: 'tool_use',
          id: block.id,
          name: mapPiToolName(block.name),
          input: normalizeToolInput(block.name, block.arguments ?? {}),
          ...(result !== undefined ? { result: result.text } : {}),
          ...(result?.isError ? { isError: true } : {}),
          ...(result && result.imageCount > 0 ? { imageCount: result.imageCount } : {}),
          ...(result?.metadata ? { metadata: result.metadata } : {}),
          ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
          ...(reason ? { abandoned: reason } : {}),
        };
        blocks.push(toolUse);
        batch.push(toolUse);
      }
    }
    if (blocks.length > 0) out.push({ role: 'assistant', contentBlocks: blocks });
    // A call pi re-ran is not among these messages, so every error stop here is one pi did not recover.
    if (failed) out.push({ role: 'error', contentBlocks: [{ type: 'text', text: failedCallError(msg.errorMessage) }] });
  }
  return out;
}
