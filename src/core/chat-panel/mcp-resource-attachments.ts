import type { ReadResourceResult } from '@earendil-works/pi-mcp';
import type { McpResourceRow, McpResourceTemplateRow } from '../../shared/types/mcp';
import { MAX_MCP_RESOURCE_LABEL_CHARS, type McpResourceAttachmentInput } from '../../shared/types/chat-attachment';
import { MAX_IMAGES_PER_MESSAGE, type ImageBlock } from '../../shared/types/content';
import { isAttachableImageMimeType, isDirectoryResource, isTextMimeType } from '../../shared/mcp-resource-mime';
import { classifyInlineImage } from '../../shared/inline-image';
import type { McpResourceRuleFilter } from '../permission-handler/mcp-resource-rule';
import type { McpUserResourcePort } from '../pi-session/mcp/tool-source';
import { base64ByteLength } from '../pi-session/mcp/content';
import { isMcpAppResource, type ServerItem } from '../pi-session/tools/mcp-resource-tools';
import { oneLine } from '../pi-session/untrusted-text';
import { formatAttachmentBlock, formatMcpResourceAttachmentBlock } from '../terminal-attachment';
import { heldChars, MAX_PENDING_TERMINAL_ATTACHMENT_CHARS, type TakenAttachment } from './terminal-attachment-manager';
import { McpResourceServerGoneError } from '../pi-session/mcp/resource-errors';
import { formatNumber, t } from '../l10n';

/*
 * The MCP panel's resource picker and the send-time read of an attached resource. Server output is untrusted: text
 * fields are flattened to one line and capped, URIs are kept exactly as listed because the deny rules match them.
 */

const MAX_DESCRIPTION_CHARS = 500;
const MAX_MIME_TYPE_CHARS = 100;
const MAX_ERROR_CHARS = 300;

const isItem = (value: unknown): value is ServerItem => typeof value === 'object' && value !== null;
const items = (value: unknown): ServerItem[] => (Array.isArray(value) ? value.filter(isItem) : []);

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? oneLine(value, max) : undefined;
}

/** A resource name for a chip, a block attribute or a message: server or webview text, flattened and capped. */
export function resourceLabel(name: unknown, uri: string): string {
  return text(name, MAX_MCP_RESOURCE_LABEL_CHARS) ?? oneLine(uri, MAX_MCP_RESOURCE_LABEL_CHARS) ?? uri;
}

export function mimeTypeOf(value: unknown): string | undefined {
  return text(value, MAX_MIME_TYPE_CHARS);
}

/** An error's message as the user may read it: server text, flattened and capped. */
export function errorText(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error), MAX_ERROR_CHARS) ?? t('Unknown error');
}

function deniedOf(filter: McpResourceRuleFilter, server: string, uri: string): { denied?: { rule: string } } {
  const rule = filter.resourceDenyRule(server, uri);
  return rule === undefined ? {} : { denied: { rule } };
}

function contentBytes(item: ServerItem): number {
  if (typeof item.text === 'string') return Buffer.byteLength(item.text, 'utf8');
  return typeof item.blob === 'string' ? base64ByteLength(item.blob) : 0;
}

/** A listed page's resources as picker rows; MCP Apps and items without a URI are left out. */
export function resourceRows(listed: unknown, server: string, filter: McpResourceRuleFilter): McpResourceRow[] {
  return items(listed).flatMap((item): McpResourceRow[] => {
    if (typeof item.uri !== 'string' || item.uri === '' || isMcpAppResource(item)) return [];
    const mimeType = mimeTypeOf(item.mimeType);
    const title = text(item['title'], MAX_MCP_RESOURCE_LABEL_CHARS);
    const description = text(item['description'], MAX_DESCRIPTION_CHARS);
    const size = item['size'];
    return [{
      uri: item.uri,
      name: resourceLabel(item['name'], item.uri),
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(typeof size === 'number' && Number.isFinite(size) && size >= 0 ? { size } : {}),
      ...(isDirectoryResource(item.uri, mimeType) ? { directory: true as const } : {}),
      ...deniedOf(filter, server, item.uri),
    }];
  });
}

export function templateRows(listed: unknown): McpResourceTemplateRow[] {
  return items(listed).flatMap((item): McpResourceTemplateRow[] => {
    if (typeof item.uriTemplate !== 'string' || item.uriTemplate === '' || isMcpAppResource(item)) return [];
    const mimeType = mimeTypeOf(item.mimeType);
    const title = text(item['title'], MAX_MCP_RESOURCE_LABEL_CHARS);
    const description = text(item['description'], MAX_DESCRIPTION_CHARS);
    return [{
      uriTemplate: item.uriTemplate,
      name: resourceLabel(item['name'], item.uriTemplate),
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
    }];
  });
}

/**
 * A directory's children from reading it, VS Code's rule (`mcpResourceFilesystem.ts` `readdir`): a read that returns
 * content under the directory's own URI is a file, not a directory (null). Each content one path segment below the
 * directory is a child, a file unless its MIME type says directory or, with none, it is empty; a deeper content shows
 * as the sub-directory that holds it.
 */
export function directoryChildren(uri: string, result: ReadResourceResult, server: string, filter: McpResourceRuleFilter): McpResourceRow[] | null {
  const contents = items(result.contents);
  if (contents.some((item) => item.uri === uri)) return null;
  const base = uri.endsWith('/') ? uri : `${uri}/`;
  const children = new Map<string, McpResourceRow>();
  for (const item of contents) {
    if (typeof item.uri !== 'string' || !item.uri.startsWith(base) || isMcpAppResource(item)) continue;
    const segments = item.uri.slice(base.length).split('/');
    const name = segments[0]!;
    if (name === '') continue;
    if (segments.length > 1) {
      const childUri = `${base}${name}`;
      children.set(name, { uri: childUri, name: resourceLabel(name, childUri), directory: true, ...deniedOf(filter, server, childUri) });
      continue;
    }
    const mimeType = mimeTypeOf(item.mimeType);
    const size = contentBytes(item);
    children.set(name, {
      uri: item.uri,
      name: resourceLabel(name, item.uri),
      ...(mimeType !== undefined ? { mimeType } : {}),
      size,
      ...(isDirectoryResource(item.uri, mimeType) || (size === 0 && mimeType === undefined) ? { directory: true as const } : {}),
      ...deniedOf(filter, server, item.uri),
    });
  }
  return [...children.values()];
}

/** What an attached resource's read gave at send: its text, its images, or why the message cannot go. */
type ResourceRead = { ok: true; text: string | undefined; images: ImageBlock[] } | { ok: false; reason: string };

async function readAttached(port: McpUserResourcePort, filter: McpResourceRuleFilter, attachment: McpResourceAttachmentInput, signal: AbortSignal): Promise<ResourceRead> {
  const label = { name: attachment.name, server: attachment.server };
  const mcpApp = { ok: false as const, reason: t('{0} from {1} is an MCP App interface, which cannot be sent to the model.', label.name, label.server) };
  const replaced = { ok: false as const, reason: t('{0} from {1} was attached from a server that has since been replaced or removed. Attach it again to send it.', label.name, label.server) };
  if (isMcpAppResource({ uri: attachment.uri, mimeType: attachment.mimeType })) return mcpApp;
  if (port.serverIdOf(attachment.server) !== attachment.serverId) return replaced;
  const rule = filter.resourceDenyRule(attachment.server, attachment.uri);
  if (rule !== undefined) return { ok: false, reason: t('A deny rule now covers {0} from {1}: {2}', label.name, label.server, rule) };
  let result: ReadResourceResult;
  try {
    result = await port.readResource(attachment.server, attachment.uri, { signal, expectedServerId: attachment.serverId });
  } catch (error) {
    if (error instanceof McpResourceServerGoneError) return replaced;
    return { ok: false, reason: t('{0} from {1} could not be read: {2}', label.name, label.server, errorText(error)) };
  }
  const own = items(result.contents).filter((item) => item.uri === attachment.uri);
  if (own.length === 0) return { ok: false, reason: t('{0} from {1} returned no content of its own, so it may be a directory.', label.name, label.server) };
  const texts: string[] = [];
  const images: ImageBlock[] = [];
  let chars = 0;
  for (const item of own) {
    if (isMcpAppResource(item)) return mcpApp;
    const mimeType = mimeTypeOf(item.mimeType) ?? attachment.mimeType;
    if (typeof item.text === 'string') {
      texts.push(item.text);
      chars += item.text.length;
    } else if (typeof item.blob !== 'string') {
      continue;
    } else if (isTextMimeType(mimeType)) {
      // UTF-8 decoding yields at least one UTF-16 unit per three bytes, so this many bytes already exceed the cap.
      if (Math.ceil(base64ByteLength(item.blob) / 3) > MAX_PENDING_TERMINAL_ATTACHMENT_CHARS - chars) {
        return { ok: false, reason: t('{0} from {1} holds more text than one message can carry.', label.name, label.server) };
      }
      const decoded = Buffer.from(item.blob, 'base64').toString('utf8');
      texts.push(decoded);
      chars += decoded.length;
    } else if (isAttachableImageMimeType(mimeType)) {
      const image = classifyInlineImage(item.blob, mimeType);
      if (!image.ok) {
        return {
          ok: false,
          reason: image.reason === 'tooLarge'
            ? t('{0} from {1} is an image too large to send.', label.name, label.server)
            : t('{0} from {1} is labelled {2}, but its content is not a PNG, JPEG, GIF or WebP image.', label.name, label.server, mimeType ?? ''),
        };
      }
      images.push({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } });
    } else {
      return { ok: false, reason: t('{0} from {1} is binary content ({2}), which cannot be sent to the model.', label.name, label.server, mimeType ?? t('unknown type')) };
    }
  }
  return { ok: true, text: texts.length > 0 ? texts.join('\n') : images.length > 0 ? undefined : '', images };
}

/** The blocks that lead a sent message, in attachment order, and the images its resources add; `stopped` when `signal` aborted first. */
export type AttachmentContent = { ok: true; blocks: string[]; images: ImageBlock[] } | { ok: false; reason: string } | { ok: false; stopped: true };

/** Settles once `signal` aborts: a server still connecting cannot see the signal its read was given. */
function whenAborted(signal: AbortSignal): Promise<'stopped'> {
  if (signal.aborted) return Promise.resolve('stopped');
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve('stopped'), { once: true }));
}

/**
 * Builds every taken attachment's block, reading each MCP resource now (D12). A failed read, a server other than the one
 * it was attached from, a deny rule that covers a resource, an MCP App, binary content, an image `classifyInlineImage` refuses, text past
 * MAX_PENDING_TERMINAL_ATTACHMENT_CHARS with the other attachments, or images past MAX_IMAGES_PER_MESSAGE with the
 * `typedImages` refuses the whole message. An image goes as the type its bytes carry. An abort of `signal` ends the
 * reads at once.
 */
export async function attachmentContent(
  attached: readonly TakenAttachment[],
  typedImages: number,
  resources: () => Promise<{ port: McpUserResourcePort | null; filter: McpResourceRuleFilter }>,
  signal: AbortSignal,
): Promise<AttachmentContent> {
  const resourceAttachments = attached.flatMap(({ attachment }) => (attachment.kind === 'mcpResource' ? [attachment] : []));
  const reads = new Map<McpResourceAttachmentInput, ResourceRead>();
  if (resourceAttachments.length > 0) {
    const reading = (async (): Promise<ResourceRead[] | null> => {
      const { port, filter } = await resources();
      if (!port) return null;
      return Promise.all(resourceAttachments.map((attachment) => readAttached(port, filter, attachment, signal)));
    })();
    const results = await Promise.race([reading, whenAborted(signal)]);
    if (results === 'stopped') return { ok: false, stopped: true };
    if (!results) return { ok: false, reason: t('MCP is not available in this chat yet.') };
    resourceAttachments.forEach((attachment, index) => reads.set(attachment, results[index]!));
  }
  const blocks: string[] = [];
  const images: ImageBlock[] = [];
  let chars = 0;
  for (const { attachment } of attached) {
    if (attachment.kind !== 'mcpResource') {
      chars += heldChars(attachment);
      blocks.push(formatAttachmentBlock(attachment));
      continue;
    }
    const read = reads.get(attachment)!;
    if (!read.ok) return read;
    chars += read.text?.length ?? 0;
    // The typed images come first in the sent message, then each resource's in attachment order.
    const first = typedImages + images.length + 1;
    images.push(...read.images);
    blocks.push(formatMcpResourceAttachmentBlock(attachment, {
      ...(read.text !== undefined ? { text: read.text } : {}),
      ...(read.images.length > 0 ? { images: { first, count: read.images.length } } : {}),
    }));
  }
  if (chars > MAX_PENDING_TERMINAL_ATTACHMENT_CHARS) {
    return { ok: false, reason: t('The attachments hold {0} characters of text, more than the {1} one message can carry.', formatNumber(chars), formatNumber(MAX_PENDING_TERMINAL_ATTACHMENT_CHARS)) };
  }
  if (typedImages + images.length > MAX_IMAGES_PER_MESSAGE) {
    return { ok: false, reason: t('The message would carry {0} images, more than the {1} one message can carry.', typedImages + images.length, MAX_IMAGES_PER_MESSAGE) };
  }
  return { ok: true, blocks, images };
}
