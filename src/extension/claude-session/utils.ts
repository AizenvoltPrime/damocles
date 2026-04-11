import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ContentBlock, TextBlock, ToolUseBlock, ThinkingBlock } from '../../shared/types/content';
import { TOOL_WEB_SEARCH, TOOL_READ, TOOL_WEB_FETCH, TOOL_TOOL_SEARCH, TOOL_CRON_CREATE, TOOL_CRON_DELETE, TOOL_CRON_LIST, TOOL_EDIT, TOOL_WRITE, TOOL_MONITOR } from '../../shared/tool-names';
import { log } from '../logger';

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
      const thinkingBlock: ThinkingBlock = { type: 'thinking', thinking: b['thinking'] };
      if (typeof b['signature'] === 'string') thinkingBlock.signature = b['signature'];
      blocks.push(thinkingBlock);
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

export interface ToolMetadataConfig {
  extract?: (response: unknown) => Record<string, unknown> | null;
  normalize?: (response: unknown) => string;
  hasStructuredResult?: (response: unknown) => boolean;
}

const editWriteExtractor: ToolMetadataConfig = {
  extract: (response) => {
    if (typeof response !== 'object' || response === null) return null;
    const obj = response as Record<string, unknown>;
    const patches = obj['structuredPatch'];
    if (!Array.isArray(patches) || !patches.length) return null;
    const first = patches[0] as Record<string, unknown> | undefined;
    const editLineNumber = first?.['oldStart'];
    return typeof editLineNumber === 'number' ? { editLineNumber } : null;
  },
};

export const TOOL_METADATA_REGISTRY: Map<string, ToolMetadataConfig> = new Map<string, ToolMetadataConfig>([
  [TOOL_EDIT, editWriteExtractor],
  [TOOL_WRITE, editWriteExtractor],
  [TOOL_READ, {
    extract: (r) => extractReadMetadata(r) as Record<string, unknown> | null,
    normalize: normalizeReadResult,
  }],
  [TOOL_WEB_SEARCH, {
    normalize: normalizeWebSearchResult,
  }],
  [TOOL_WEB_FETCH, {
    normalize: normalizeWebFetchResult,
  }],
  [TOOL_TOOL_SEARCH, {
    extract: (r) => extractToolSearchMetadata(r) as Record<string, unknown> | null,
    normalize: normalizeToolSearchResult,
    hasStructuredResult: (r) => {
      const obj = r as Record<string, unknown>;
      return obj['matches'] !== undefined && obj['total_deferred_tools'] !== undefined;
    },
  }],
  [TOOL_CRON_CREATE, {
    extract: (r) => extractCronCreateMetadata(r) as Record<string, unknown> | null,
    normalize: normalizeCronCreateResult,
    hasStructuredResult: (r) => (r as Record<string, unknown>)['humanSchedule'] !== undefined,
  }],
  [TOOL_CRON_LIST, {
    extract: (r) => extractCronListMetadata(r) as Record<string, unknown> | null,
    normalize: normalizeCronListResult,
    hasStructuredResult: (r) => {
      const jobs = (r as Record<string, unknown>)['jobs'];
      return Array.isArray(jobs) && jobs.length > 0
        && (jobs[0] as Record<string, unknown> | undefined)?.['cron'] !== undefined;
    },
  }],
  [TOOL_CRON_DELETE, {
    normalize: normalizeCronDeleteResult,
  }],
  [TOOL_MONITOR, {
    extract: (response) => {
      if (typeof response === 'object' && response !== null && 'taskId' in response) {
        const obj = response as Record<string, unknown>;
        return {
          taskId: obj['taskId'],
          timeoutMs: obj['timeoutMs'],
          persistent: obj['persistent'],
        };
      }
      return null;
    },
    normalize: (response: unknown): string => {
      if (typeof response === 'object' && response !== null) {
        const obj = response as Record<string, unknown>;
        if (typeof obj['taskId'] === 'string') {
          const taskId = obj['taskId'];
          const persistent = obj['persistent'] === true;
          if (persistent) return `Monitor started (task ${taskId}, persistent)`;
          const timeoutMs = typeof obj['timeoutMs'] === 'number' ? obj['timeoutMs'] : undefined;
          if (timeoutMs !== undefined) return `Monitor started (task ${taskId}, timeout ${timeoutMs}ms)`;
          return `Monitor started (task ${taskId})`;
        }
      }
      return serializeToolResult(response);
    },
  }],
]);

export function normalizeToolResult(toolName: string, response: unknown): string {
  const config = TOOL_METADATA_REGISTRY.get(toolName);
  if (config?.normalize) return config.normalize(response);
  return serializeToolResult(response);
}

interface ReadMetadata {
  numLines: number;
  startLine: number;
  totalLines: number;
}

function extractReadMetadata(response: unknown): ReadMetadata | null {
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

interface ToolSearchMetadata {
  matches: string[];
  totalDeferredTools: number;
  pendingMcpServers?: string[];
}

function extractToolSearchMetadata(response: unknown): ToolSearchMetadata | null {
  if (typeof response !== 'object' || response === null) return null;
  const obj = response as Record<string, unknown>;
  const matches = obj['matches'];
  const totalDeferredTools = obj['total_deferred_tools'];
  if (!Array.isArray(matches) || typeof totalDeferredTools !== 'number') return null;
  const validMatches = matches.filter((m): m is string => typeof m === 'string');
  const rawServers = obj['pending_mcp_servers'];
  const pendingMcpServers = Array.isArray(rawServers) ? rawServers.filter((s): s is string => typeof s === 'string') : undefined;
  return { matches: validMatches, totalDeferredTools, ...(pendingMcpServers?.length ? { pendingMcpServers } : {}) };
}

interface CronCreateMetadata {
  jobId: string;
  humanSchedule: string;
  recurring: boolean;
  durable?: boolean;
}

function extractCronCreateMetadata(response: unknown): CronCreateMetadata | null {
  if (typeof response !== 'object' || response === null) return null;
  const obj = response as Record<string, unknown>;
  const id = obj['id'];
  const humanSchedule = obj['humanSchedule'];
  const recurring = obj['recurring'];
  if (typeof id !== 'string' || typeof humanSchedule !== 'string' || typeof recurring !== 'boolean') return null;
  const durable = typeof obj['durable'] === 'boolean' ? obj['durable'] : undefined;
  return { jobId: id, humanSchedule, recurring, ...(durable !== undefined ? { durable } : {}) };
}

interface CronListJob {
  id: string;
  cron: string;
  humanSchedule: string;
  prompt: string;
  recurring?: boolean;
  durable?: boolean;
}

interface CronListMetadata {
  jobs: CronListJob[];
}

function extractCronListMetadata(response: unknown): CronListMetadata | null {
  if (typeof response !== 'object' || response === null) return null;
  const obj = response as Record<string, unknown>;
  const jobs = obj['jobs'];
  if (!Array.isArray(jobs)) return null;
  const validJobs: CronListJob[] = jobs
    .filter((j): j is Record<string, unknown> => typeof j === 'object' && j !== null)
    .filter(j => typeof j['id'] === 'string' && typeof j['cron'] === 'string'
      && typeof j['humanSchedule'] === 'string' && typeof j['prompt'] === 'string')
    .map(j => ({
      id: j['id'] as string,
      cron: j['cron'] as string,
      humanSchedule: j['humanSchedule'] as string,
      prompt: j['prompt'] as string,
      ...(typeof j['recurring'] === 'boolean' ? { recurring: j['recurring'] } : {}),
      ...(typeof j['durable'] === 'boolean' ? { durable: j['durable'] } : {}),
    }));
  return { jobs: validJobs };
}

function normalizeCronCreateResult(response: unknown): string {
  let meta = extractCronCreateMetadata(response);
  if (!meta && typeof response === 'string') {
    try { meta = extractCronCreateMetadata(JSON.parse(response)); } catch {}
  }
  if (meta) {
    const parts: string[] = [];
    parts.push(`Scheduled: ${meta.humanSchedule}`);
    parts.push(`Job ID: ${meta.jobId}`);
    parts.push(meta.recurring ? 'Recurring (auto-expires after 3 days)' : 'One-shot (fires once)');
    if (meta.durable) parts.push('Durable (persists across sessions)');
    return parts.join('\n');
  }
  return serializeToolResult(response);
}

function normalizeCronListResult(response: unknown): string {
  let meta = extractCronListMetadata(response);
  if (!meta && typeof response === 'string') {
    try { meta = extractCronListMetadata(JSON.parse(response)); } catch {}
  }
  if (meta) {
    if (meta.jobs.length === 0) return 'No scheduled jobs';
    const jobLines = meta.jobs.map(j => {
      const prompt = j.prompt.length > 60 ? j.prompt.slice(0, 60) + '...' : j.prompt;
      return `- ${j.humanSchedule}: ${prompt}`;
    });
    return `${meta.jobs.length} scheduled job(s):\n${jobLines.join('\n')}`;
  }
  return serializeToolResult(response);
}

function normalizeCronDeleteResult(response: unknown): string {
  if (typeof response === 'object' && response !== null) {
    const id = (response as Record<string, unknown>)['id'];
    if (typeof id === 'string') return `Deleted job: ${id}`;
  }
  if (typeof response === 'string') {
    try {
      const parsed = JSON.parse(response);
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.id === 'string') {
        return `Deleted job: ${parsed.id}`;
      }
    } catch {}
  }
  return serializeToolResult(response);
}

function normalizeToolSearchResult(response: unknown): string {
  let meta = extractToolSearchMetadata(response);
  if (!meta && typeof response === 'string') {
    try {
      meta = extractToolSearchMetadata(JSON.parse(response));
    } catch {}
  }
  if (meta) {
    const parts: string[] = [];
    if (meta.matches.length > 0) {
      parts.push('Loaded tools:\n' + meta.matches.map(m => `- ${m}`).join('\n'));
    }
    parts.push(`${meta.matches.length} of ${meta.totalDeferredTools} deferred tools`);
    if (meta.pendingMcpServers?.length) {
      parts.push('Pending MCP servers: ' + meta.pendingMcpServers.join(', '));
    }
    return parts.join('\n\n');
  }
  return serializeToolResult(response);
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

const DOWNLOADED_FILE_PATTERN = /Downloaded\s+"([^"]+\.(gif|png|jpe?g|webp))"/gi;
const MAX_ENRICHMENT_FILE_SIZE = 10 * 1024 * 1024;
const MEDIA_TYPE_MAP: Record<string, string> = {
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export async function enrichResultWithDownloadedFiles(result: string): Promise<string> {
  let textToSearch = result;
  let parsedContentArray: unknown[] | null = null;

  try {
    const parsed = JSON.parse(result);
    if (Array.isArray(parsed)) {
      parsedContentArray = parsed;
      textToSearch = parsed
        .filter((b: unknown) => {
          const block = b as Record<string, unknown>;
          return typeof block === 'object' && block !== null && block['type'] === 'text' && typeof block['text'] === 'string';
        })
        .map((b: unknown) => (b as { text: string }).text)
        .join('\n');
    }
  } catch {
    // Not JSON — search the raw string
  }

  const matches = [...textToSearch.matchAll(DOWNLOADED_FILE_PATTERN)];
  if (matches.length === 0) return result;

  const imageBlocks: Array<{ type: 'image'; source: { type: 'base64'; media_type: string; data: string } }> = [];

  const downloadsDir = path.resolve(path.join(os.homedir(), 'Downloads'));

  for (const match of matches) {
    const filename = match[1] as string;
    const ext = (match[2] as string).toLowerCase();
    const mediaType = MEDIA_TYPE_MAP[ext];
    if (!mediaType) continue;

    const filePath = path.resolve(path.join(downloadsDir, filename));
    if (!filePath.startsWith(downloadsDir + path.sep)) continue;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_ENRICHMENT_FILE_SIZE) {
        log('[enrichResult] Skipping %s: %dMB exceeds limit', filename, Math.round(stat.size / 1024 / 1024));
        continue;
      }
      const data = await fs.readFile(filePath);
      imageBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: data.toString('base64') },
      });
    } catch {
      log('[enrichResult] File not found or unreadable: %s', filePath);
    }
  }

  if (imageBlocks.length === 0) return result;

  const contentArray = parsedContentArray ?? [{ type: 'text', text: result }];
  return JSON.stringify([...contentArray, ...imageBlocks]);
}
