import type { ContentBlock, TextBlock, ToolUseBlock, ThinkingBlock } from '../../shared/types/content';

/** SDK error message when abort is triggered - used for semantic error filtering */
export const SDK_USER_ABORT_MESSAGE = 'Claude Code process aborted by user';

/** Retry with exponential backoff until condition is met or max attempts reached */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  predicate: (result: T) => boolean,
  maxAttempts = 5,
  baseDelayMs = 20
): Promise<T | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await fn();
    if (predicate(result)) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.pow(2, attempt)));
  }
  return null;
}

/** Serialize SDK content blocks to our ContentBlock format */
export function serializeContent(content: unknown[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const block of content) {
    const b = block as { type: string; [key: string]: unknown };
    if (b.type === 'text' && typeof b['text'] === 'string') {
      blocks.push({ type: 'text', text: b['text'] } satisfies TextBlock);
    } else if (b.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: b['id'] as string,
        name: b['name'] as string,
        input: (b['input'] as Record<string, unknown>) || {},
      } satisfies ToolUseBlock);
    } else if (b.type === 'thinking' && typeof b['thinking'] === 'string') {
      blocks.push({ type: 'thinking', thinking: b['thinking'] } satisfies ThinkingBlock);
    }
  }

  return blocks;
}

/** Serialize tool result to string for display */
export function serializeToolResult(result: unknown): string {
  if (result === null || result === undefined) {
    return '';
  }
  if (typeof result === 'string') {
    return result;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/** Check if message content is CLI internal output (local command wrapper) */
export function isLocalCommandOutput(content: unknown[]): boolean {
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block = content[0] as { type?: string; text?: string };
  if (block.type !== 'text' || typeof block.text !== 'string') return false;
  return block.text.trim().startsWith('<local-command-');
}

/** Check if text content is CLI internal output */
export function isLocalCommandText(text: string): boolean {
  return text.trim().startsWith('<local-command-');
}

/** Check if content is a tool_result message (not actual user input) */
export function isToolResultMessage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(block =>
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    (block as { type: string }).type === 'tool_result'
  );
}

/** Extract error tool_result blocks from message content (for external hook rejections) */
export function extractErrorToolResults(content: unknown): Array<{
  toolUseId: string;
  error: string;
}> {
  if (!Array.isArray(content)) return [];
  return content
    .filter(block =>
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      (block as { type: string }).type === 'tool_result' &&
      'is_error' in block &&
      (block as { is_error: boolean }).is_error === true &&
      'tool_use_id' in block &&
      typeof (block as { tool_use_id: unknown }).tool_use_id === 'string'
    )
    .map(block => ({
      toolUseId: (block as { tool_use_id: string }).tool_use_id,
      error: typeof (block as { content: unknown }).content === 'string'
        ? (block as { content: string }).content
        : 'Hook blocked execution',
    }));
}
