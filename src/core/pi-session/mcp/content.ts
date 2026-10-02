/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 * Transform MCP `tools/call` content blocks into pi content blocks. pi has no resource block, so
 * resource / resource_link / audio degrade to text (US-014.5/FR-5).
 */
import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TextContent } from '@earendil-works/pi-ai';
import type { McpContent, ContentBlock } from './types';

export function transformMcpContent(content: McpContent[]): ContentBlock[] {
  return content.map((c): ContentBlock => {
    if (c.type === 'text') {
      return { type: 'text', text: c.text ?? '' };
    }
    if (c.type === 'image') {
      const mimeType = c.mimeType ?? 'image/png';
      // Trust only well-formed image data; anything else degrades to a placeholder so a malformed or
      // non-image MIME never flows into pi's image inference path (L10).
      if (!c.data || !/^image\/[a-z0-9.+-]+$/i.test(mimeType)) {
        return { type: 'text', text: `[Image content omitted: ${mimeType || 'unknown type'}]` };
      }
      return { type: 'image', data: c.data, mimeType };
    }
    if (c.type === 'resource') {
      const resource = c.resource;
      const uri = resource?.uri ?? '(no URI)';
      if (resource && typeof resource.text === 'string') {
        return { type: 'text', text: `[Resource: ${uri}]\n${resource.text}` };
      }
      if (resource && typeof resource.blob === 'string') {
        // Summarize binary resources; never dump the base64 blob into a text block (M8).
        const mimeType = resource.mimeType ?? 'application/octet-stream';
        return { type: 'text', text: `[Resource: ${uri}] (binary ${mimeType}, ${base64ByteLength(resource.blob)} bytes)` };
      }
      return { type: 'text', text: `[Resource: ${uri}] (no content)` };
    }
    if (c.type === 'resource_link') {
      const name = c.name ?? c.uri ?? 'unknown';
      const uri = c.uri ?? '(no URI)';
      return { type: 'text', text: `[Resource Link: ${name}]\nURI: ${uri}` };
    }
    if (c.type === 'audio') {
      return { type: 'text', text: `[Audio content: ${c.mimeType ?? 'audio/*'}]` };
    }
    return { type: 'text', text: JSON.stringify(c) };
  });
}

/** Decoded byte length of a base64 string (without allocating the buffer). */
function base64ByteLength(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

/** Model-facing text of an MCP result beyond this many bytes is cut in the middle. */
export const MCP_OUTPUT_MAX_BYTES: number = 20 * 1024;

export interface MiddleTruncationResult {
  content: string;
  truncated: boolean;
  removedChars: number;
  totalBytes: number;
  totalLines: number;
}

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  return lines;
}

/** Ported from pi-coding-agent/src/core/tools/truncate.ts `truncateMiddle`. */
export function truncateMiddle(content: string, maxBytes: number): MiddleTruncationResult {
  const buf = Buffer.from(content, 'utf-8');
  const totalLines = splitLinesForCounting(content).length;
  if (buf.length <= maxBytes) {
    return { content, truncated: false, removedChars: 0, totalBytes: buf.length, totalLines };
  }
  // Continuation bytes (10xxxxxx) are not character starts.
  const isBoundary = (index: number): boolean => index >= buf.length || (buf[index]! & 0xc0) !== 0x80;
  let headEnd = Math.floor(maxBytes / 2);
  while (headEnd > 0 && !isBoundary(headEnd)) headEnd--;
  let tailStart = buf.length - (maxBytes - Math.floor(maxBytes / 2));
  while (tailStart < buf.length && !isBoundary(tailStart)) tailStart++;
  const head = buf.subarray(0, headEnd).toString('utf-8');
  const tail = buf.subarray(tailStart).toString('utf-8');
  const removedChars = Array.from(buf.subarray(headEnd, tailStart).toString('utf-8')).length;
  return {
    content: `${head}…${removedChars} chars truncated…${tail}`,
    truncated: true,
    removedChars,
    totalBytes: buf.length,
    totalLines,
  };
}

/** Saves the full text of a truncated result and returns the file path. */
export type McpOutputSaver = (text: string) => Promise<string>;

/** The files `saveMcpOutputToTempFile` wrote in this process; an agent may read one until the runtime shuts down. */
const savedOutputFiles = new Set<string>();

/** Results can carry private data, so the file gets an unguessable name and only the user may read it. */
export async function saveMcpOutputToTempFile(text: string): Promise<string> {
  const filePath = join(tmpdir(), `damocles-mcp-${randomBytes(8).toString('hex')}.txt`);
  await writeFile(filePath, text, { mode: 0o600, flag: 'wx' });
  savedOutputFiles.add(filePath);
  return filePath;
}

/** Delete every full-output file this process saved; run when the runtime shuts down and no session can read them. */
export async function removeSavedMcpOutputs(): Promise<void> {
  const files = [...savedOutputFiles];
  savedOutputFiles.clear();
  await Promise.all(files.map((file) => rm(file, { force: true })));
}

function textOf(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Ported from pi-coding-agent/src/extensions/mcp/tools.ts `limitMcpContent`. Text over
 * `MCP_OUTPUT_MAX_BYTES` becomes one text block cut in the middle, followed by the path of the file
 * holding the full text; images follow it.
 */
export async function limitMcpContent(
  content: ContentBlock[],
  saveOutput: McpOutputSaver = saveMcpOutputToTempFile,
): Promise<{ content: ContentBlock[]; fullOutputPath?: string }> {
  const combined = textOf(content);
  const truncation = truncateMiddle(combined, MCP_OUTPUT_MAX_BYTES);
  if (!truncation.truncated) return { content };
  let fullOutputPath: string | undefined;
  let where: string;
  try {
    fullOutputPath = await saveOutput(combined);
    where = `[Full output: ${fullOutputPath} (read it with offset/limit)]`;
  } catch (error) {
    where = `[Could not save the full output: ${error instanceof Error ? error.message : String(error)}]`;
  }
  const tokens = Math.ceil(truncation.totalBytes / 4);
  const text = `Warning: truncated output (original token count: ${tokens})\nTotal output lines: ${truncation.totalLines}\n\n${truncation.content}\n\n${where}`;
  return {
    content: [{ type: 'text', text }, ...content.filter((block) => block.type === 'image')],
    ...(fullOutputPath ? { fullOutputPath } : {}),
  };
}
