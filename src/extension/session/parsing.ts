import * as fs from 'fs';
import { stripControlChars, extractSlashCommandDisplay } from '@shared/utils';
import type { ClaudeSessionEntry, JsonlContentBlock } from './types';
import { isContentBlockArray } from './types';

interface LineCacheEntry {
  mtimeMs: number;
  size: number;
  lines: string[];
}

const LINE_CACHE_MAX = 8;
const lineCache = new Map<string, LineCacheEntry>();
const entryCache = new WeakMap<string[], ClaudeSessionEntry[]>();

export function parseSessionEntry(line: string): ClaudeSessionEntry {
  const entry: ClaudeSessionEntry = JSON.parse(line);

  if (entry.message?.content) {
    if (typeof entry.message.content === 'string') {
      entry.message.content = stripControlChars(entry.message.content);
    } else if (isContentBlockArray(entry.message.content)) {
      entry.message.content = entry.message.content.map(block => {
        if (block.type === 'text' && typeof block.text === 'string') {
          return { ...block, text: stripControlChars(block.text) };
        }
        if (block.type === 'thinking' && typeof block.thinking === 'string') {
          return { ...block, thinking: stripControlChars(block.thinking) };
        }
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          return { ...block, content: stripControlChars(block.content) };
        }
        return block;
      });
    }
  }

  return entry;
}

export async function readSessionFileLines(filePath: string): Promise<string[]> {
  const stat = await fs.promises.stat(filePath);
  const cached = lineCache.get(filePath);

  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.lines;
  }

  const content = await fs.promises.readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());

  if (lineCache.size >= LINE_CACHE_MAX) {
    const oldest = lineCache.keys().next().value;
    if (oldest) lineCache.delete(oldest);
  }

  lineCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, lines });
  return lines;
}

export async function readSessionFileTail(filePath: string, maxBytes: number = 65536): Promise<string[]> {
  const stat = await fs.promises.stat(filePath);

  if (stat.size <= maxBytes) {
    return readSessionFileLines(filePath);
  }

  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fd.read(buffer, 0, maxBytes, stat.size - maxBytes);
    const content = buffer.toString('utf-8', 0, bytesRead);
    const firstNewline = content.indexOf('\n');
    const validContent = firstNewline >= 0 ? content.slice(firstNewline + 1) : content;
    return validContent.trim().split('\n').filter(line => line.trim());
  } finally {
    await fd.close();
  }
}

export function parseSessionLines<T>(
  lines: string[],
  processor: (entry: ClaudeSessionEntry) => T | null
): T[] {
  const results: T[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = parseSessionEntry(line);
      const result = processor(entry);
      if (result !== null) results.push(result);
    } catch {
      continue;
    }
  }
  return results;
}

export function parseAllSessionEntries(lines: string[]): ClaudeSessionEntry[] {
  const cached = entryCache.get(lines);
  if (cached) return cached;

  const entries = parseSessionLines(lines, entry => entry);
  entryCache.set(lines, entries);
  return entries;
}

export function invalidateSessionFileCache(filePath?: string): void {
  if (filePath) {
    lineCache.delete(filePath);
  } else {
    lineCache.clear();
  }
}

export function findUserTextBlock(
  content: JsonlContentBlock[]
): { type: 'text'; text: string } | undefined {
  return content.find(
    (b): b is { type: 'text'; text: string } =>
      b.type === 'text' && typeof b.text === 'string' && !b.text.startsWith('<ide_')
  );
}

export type RawImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export function findUserImageBlocks(content: JsonlContentBlock[]): RawImageBlock[] {
  return content.filter((b): b is RawImageBlock => b.type === 'image');
}

export function isDisplayableMessage(entry: ClaudeSessionEntry): boolean {
  if (entry.type === 'user' && entry.message && !entry.isMeta) {
    return true;
  }
  if (entry.type === 'assistant' && entry.message) {
    return true;
  }
  return false;
}

export function extractPreviewText(content: string): string {
  const commandDisplay = extractSlashCommandDisplay(content);
  if (commandDisplay) {
    return commandDisplay.slice(0, 100);
  }

  if (content.startsWith('<local-command-')) {
    return '';
  }

  let text = content.replace(/<[^>]+>/g, ' ');
  text = text.replace(/[#*_`]/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text.slice(0, 100);
}

export function extractTextFromSlashCommand(text: string): string {
  if (text.startsWith('/')) {
    const spaceIndex = text.indexOf(' ');
    if (spaceIndex > 0) {
      return text.slice(spaceIndex + 1);
    }
  }
  return text;
}
