/*
 * Adapted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon. See THIRD-PARTY-NOTICES.md.
 * Transform MCP `tools/call` content blocks into pi content blocks. pi has no resource block, so
 * resource / resource_link / audio degrade to text (US-014.5/FR-5).
 */
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
