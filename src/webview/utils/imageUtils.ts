import type { ImageBlock } from '@shared/types/content';

export function imageBlockToDataUrl(block: ImageBlock): string {
  return `data:${block.source.media_type};base64,${block.source.data}`;
}

const VALID_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export function isImageContentBlock(block: unknown): block is ImageBlock {
  if (typeof block !== 'object' || block === null) return false;
  const b = block as Record<string, unknown>;
  if (b.type !== 'image') return false;
  if (typeof b.source !== 'object' || b.source === null) return false;
  const src = b.source as Record<string, unknown>;
  return (
    src.type === 'base64' &&
    typeof src.media_type === 'string' &&
    VALID_MEDIA_TYPES.has(src.media_type) &&
    typeof src.data === 'string' &&
    (src.data as string).length > 0
  );
}
