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
import type { McpResourceToolName } from '../../../shared/tool-names';
import type { BuiltinDeferredGroup } from '../tools/deferred-tools';
import { classifyInlineImage } from '../../../shared/inline-image';
import { oneLine } from '../untrusted-text';
import { quotedServerName } from './resource-errors';

const READ_MCP_RESOURCE_TOOL: McpResourceToolName = 'read_mcp_resource';
const MCP_RESOURCES_GROUP: BuiltinDeferredGroup = 'mcp_resources';

/** How `read_mcp_resource` reaches the calling agent for one server's resources. */
export interface ResourceReadReach {
  /** Active now, loadable through ToolSearch, or null when this agent cannot read the server's resources. */
  readTool: 'direct' | 'deferred' | null;
  /** The URIs this agent cannot read: its tool lists turn them off (`disabledResourceMatcher`) or a deny rule covers them. */
  unreadable: (uri: string) => boolean;
}

/** No way to read: a link names no tool. */
export const NO_RESOURCE_READ: ResourceReadReach = { readTool: null, unreadable: () => true };

/** How a result's resource links point the agent at `read_mcp_resource`. */
export interface ResourceLinkContext extends ResourceReadReach {
  /** The server whose result this is. */
  server: string;
}

/** Ported from pi-coding-agent/src/core/tools/truncate.ts `formatSize`. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Ported from pi-coding-agent/src/extensions/mcp/tools.ts: a resource link as one line naming the read tool. */
function resourceLinkText(c: McpContent, links: ResourceLinkContext | undefined): string {
  const uri = c.uri ?? '(no URI)';
  const details = [c.mimeType, typeof c.size === 'number' ? formatSize(c.size) : undefined].filter(Boolean);
  const description = c.description ? `: ${c.description}` : '';
  let read = '';
  if (links && links.readTool !== null && typeof c.uri === 'string' && !links.unreadable(c.uri)) {
    read = `. Read it with ${READ_MCP_RESOURCE_TOOL} (server ${quotedServerName(links.server)})`;
    if (links.readTool === 'deferred') read += `, after loading it with ToolSearch({tools:["${MCP_RESOURCES_GROUP}"]})`;
  }
  return `[Resource ${uri} "${c.title ?? c.name ?? uri}"${details.length > 0 ? ` (${details.join(', ')})` : ''}${description}${read}]`;
}

export function transformMcpContent(content: McpContent[], links?: ResourceLinkContext): ContentBlock[] {
  return content.map((c): ContentBlock => {
    if (c.type === 'text') {
      return { type: 'text', text: c.text ?? '' };
    }
    if (c.type === 'image') {
      const image = classifyInlineImage(c.data ?? '', c.mimeType);
      if (!image.ok) return { type: 'text', text: `[Image content omitted: ${oneLine(c.mimeType ?? '', 100) ?? 'unknown type'}]` };
      return { type: 'image', data: image.data, mimeType: image.mediaType };
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
      return { type: 'text', text: resourceLinkText(c, links) };
    }
    if (c.type === 'audio') {
      return { type: 'text', text: `[Audio content: ${c.mimeType ?? 'audio/*'}]` };
    }
    return { type: 'text', text: JSON.stringify(c) };
  });
}

/** Decoded byte length of a base64 string (without allocating the buffer). */
export function base64ByteLength(b64: string): number {
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

/** The files this module wrote in this process; an agent may read one until the runtime shuts down. */
const savedOutputFiles = new Set<string>();

/**
 * Results can carry private data, so the file gets an unguessable name and only the user may read it.
 * The name never comes from server output, and `wx` never follows a link someone placed at the path.
 */
async function saveOutputFile(extension: '.txt' | '.bin', data: string | Uint8Array): Promise<string> {
  const filePath = join(tmpdir(), `damocles-mcp-${randomBytes(8).toString('hex')}${extension}`);
  await writeFile(filePath, data, { mode: 0o600, flag: 'wx' });
  savedOutputFiles.add(filePath);
  return filePath;
}

export function saveMcpOutputToTempFile(text: string): Promise<string> {
  return saveOutputFile('.txt', text);
}

/** A resource's binary content, for the agent to open by path. */
export function saveMcpBinaryToTempFile(data: Uint8Array): Promise<string> {
  return saveOutputFile('.bin', data);
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
