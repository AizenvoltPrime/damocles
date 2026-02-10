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
function serializeToolResult(result: unknown): string {
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

/**
 * Normalize and serialize a tool result for display.
 * Transforms SDK-specific wire formats into clean renderable content.
 * For tools with structured responses (e.g. WebSearch), extracts meaningful content
 * from the raw object before serialization.
 */
export function normalizeToolResult(toolName: string, response: unknown): string {
  if (toolName === 'WebSearch') {
    return normalizeWebSearchResult(response);
  }
  if (toolName === 'Read') {
    return normalizeReadResult(response);
  }
  if (toolName === 'WebFetch') {
    return normalizeWebFetchResult(response);
  }
  return serializeToolResult(response);
}

export interface ReadMetadata {
  numLines: number;
  startLine: number;
  totalLines: number;
}

export function extractReadMetadata(response: unknown): ReadMetadata | null {
  if (typeof response !== 'object' || response === null) return null;
  const obj = response as Record<string, unknown>;
  const file = obj['file'] as Record<string, unknown> | undefined;
  if (!file || typeof file !== 'object') return null;
  const numLines = file['numLines'];
  const startLine = file['startLine'];
  const totalLines = file['totalLines'];
  if (typeof numLines !== 'number' || typeof startLine !== 'number' || typeof totalLines !== 'number') return null;
  return { numLines, startLine, totalLines };
}

function normalizeReadResult(response: unknown): string {
  if (typeof response === 'object' && response !== null) {
    const extracted = extractReadFileContent(response);
    if (extracted !== null) return extracted;
  }

  if (typeof response === 'string') {
    const parsed = tryParseReadJson(response);
    if (parsed !== null) return parsed;
    return cleanReadContent(response);
  }

  return serializeToolResult(response);
}

function extractReadFileContent(response: unknown): string | null {
  if (Array.isArray(response)) {
    for (const item of response) {
      if (typeof item === 'object' && item !== null) {
        const result = extractReadFileContent(item);
        if (result !== null) return result;
      }
    }
    return null;
  }

  const obj = response as Record<string, unknown>;
  if (obj['file'] && typeof obj['file'] === 'object') {
    const content = (obj['file'] as Record<string, unknown>)['content'];
    if (typeof content === 'string') return content;
  }

  return null;
}

function tryParseReadJson(str: string): string | null {
  const trimmed = str.trimStart();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      return extractReadFileContent(parsed);
    }
  } catch {}
  return null;
}

const CAT_N_PREFIX = /^\s*\d+[→\t]/;
const SYSTEM_REMINDER_TAG = /\n*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;

function cleanReadContent(str: string): string {
  const firstNonEmpty = str.split('\n').find(line => line.trim().length > 0);
  if (!firstNonEmpty || !CAT_N_PREFIX.test(firstNonEmpty)) return str;

  const cleaned = str.replace(SYSTEM_REMINDER_TAG, '');
  return cleaned
    .split('\n')
    .map(line => line.replace(CAT_N_PREFIX, ''))
    .join('\n')
    .trimEnd();
}

function normalizeWebFetchResult(response: unknown): string {
  const extracted = extractWebFetchContent(response);
  if (extracted !== null) return extracted;

  if (typeof response === 'string') {
    const trimmed = response.trimStart();
    if (trimmed[0] === '{') {
      try {
        const parsed = extractWebFetchContent(JSON.parse(trimmed));
        if (parsed !== null) return parsed;
      } catch {}
    }
  }

  return serializeToolResult(response);
}

function extractWebFetchContent(response: unknown): string | null {
  if (typeof response !== 'object' || response === null) return null;
  const obj = response as Record<string, unknown>;
  return typeof obj['result'] === 'string' ? obj['result'] : null;
}

function normalizeWebSearchResult(response: unknown): string {
  if (typeof response === 'object' && response !== null) {
    const obj = response as Record<string, unknown>;
    const query = obj['query'] as string | undefined;
    const results = obj['results'] as unknown[] | undefined;

    if (query && Array.isArray(results)) {
      return formatWebSearchStructured(query, results);
    }
  }

  const raw = serializeToolResult(response);
  return formatWebSearchText(raw);
}

function formatWebSearchStructured(query: string, results: unknown[]): string {
  const parts: string[] = [];
  parts.push(`Web search: "${query}"`);

  for (const item of results) {
    if (typeof item === 'string') {
      const cleaned = item.replace(/\n*REMINDER:.*$/s, '').trimEnd();
      if (cleaned) parts.push(cleaned);
    } else if (typeof item === 'object' && item !== null) {
      const content = (item as Record<string, unknown>)['content'];
      if (Array.isArray(content)) {
        const links = content
          .filter((link): link is { title: string; url: string } =>
            typeof link === 'object' && link !== null && 'title' in link && 'url' in link)
          .map(link => `- [${link.title}](${link.url})`)
          .join('\n');
        if (links) parts.push(links);
      }
    }
  }

  return parts.join('\n\n');
}

function formatWebSearchText(raw: string): string {
  const linksIdx = raw.indexOf('Links: [');
  if (linksIdx === -1) return raw;

  const arrayStart = raw.indexOf('[', linksIdx);
  const arrayEnd = findMatchingBracket(raw, arrayStart);
  if (arrayEnd === -1) return raw;

  try {
    const links = JSON.parse(raw.slice(arrayStart, arrayEnd + 1)) as Array<{ title: string; url: string }>;
    const markdownLinks = links
      .map((link: { title: string; url: string }) => `- [${link.title}](${link.url})`)
      .join('\n');

    const before = raw.slice(0, linksIdx).trimEnd();
    const after = raw.slice(arrayEnd + 1).trimStart()
      .replace(/\n*REMINDER:.*$/s, '').trimEnd();

    return [before, markdownLinks, after].filter(Boolean).join('\n\n');
  } catch {
    return raw;
  }
}

function findMatchingBracket(str: string, openPos: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openPos; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') depth++;
    if (ch === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
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
