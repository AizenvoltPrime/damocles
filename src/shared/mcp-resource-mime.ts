import { inlineImageMediaType, mimeBaseType } from './inline-image';

/** VS Code's directory MIME type for MCP resources (`mcpResourceQuickAccess.ts` `_isDirectoryResource`). */
export const MCP_DIRECTORY_MIME_TYPE = 'inode/directory';

/** Blobs of these types read as text (pi's `isTextMimeType`). */
export function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  const type = mimeBaseType(mimeType);
  return type.startsWith('text/') || type === 'application/json' || type.endsWith('+json') || type.endsWith('+xml');
}

/** An image type the model takes as an image block, by its label; the bytes decide at read (`classifyInlineImage`). */
export function isAttachableImageMimeType(mimeType: string | undefined): boolean {
  return inlineImageMediaType(mimeType) !== undefined;
}

export function isDirectoryMimeType(mimeType: string | undefined): boolean {
  return mimeType !== undefined && mimeBaseType(mimeType) === MCP_DIRECTORY_MIME_TYPE;
}

/** A resource is a directory by its MIME type; a URI ending in `/` says so only when no MIME type does. */
export function isDirectoryResource(uri: string, mimeType: string | undefined): boolean {
  return mimeType !== undefined ? isDirectoryMimeType(mimeType) : uri.endsWith('/');
}

const BINARY_TYPES = new Set(['application/octet-stream', 'application/pdf', 'application/zip']);

/**
 * A MIME type whose content is never text the model reads nor an image it takes. Only clearly binary families are
 * named here, because text resources carry many other labels; whether content is text is decided when it is read.
 */
export function isBinaryMimeType(mimeType: string | undefined): boolean {
  if (!mimeType || isTextMimeType(mimeType) || isAttachableImageMimeType(mimeType)) return false;
  const type = mimeBaseType(mimeType);
  return BINARY_TYPES.has(type) || type.startsWith('audio/') || type.startsWith('image/');
}
