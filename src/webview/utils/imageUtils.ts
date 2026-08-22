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

const SDK_MAX_DIMENSION = 2000;
const SDK_MAX_BASE64_SIZE = 3_932_160;

export interface ResizedImage {
  dataUrl: string;
  base64Data: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

function loadImage(
  file: File,
): Promise<{ img: HTMLImageElement; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const img = new Image();
      img.onload = () => resolve({ img, dataUrl });
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = dataUrl;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function calculateTargetDimensions(
  width: number,
  height: number,
  maxDim: number,
): { width: number; height: number } {
  if (width <= maxDim && height <= maxDim) return { width, height };
  const scale = Math.min(maxDim / width, maxDim / height);
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

function drawToCanvas(
  img: HTMLImageElement,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

/** Payload half of a `data:<mime>;base64,<payload>` URL. */
function base64Payload(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

function tryCanvasExport(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number,
): string | null {
  const dataUrl = canvas.toDataURL(mimeType, quality);
  if (base64Payload(dataUrl).length <= SDK_MAX_BASE64_SIZE) return dataUrl;
  return null;
}

type SupportedMediaType = ResizedImage['mediaType'];

const JPEG_QUALITY_CASCADE = [0.85, 0.7, 0.5, 0.3] as const;

export async function resizeImageForSDK(file: File): Promise<ResizedImage> {
  if (!VALID_MEDIA_TYPES.has(file.type)) {
    throw new Error(`Unsupported media type: ${file.type}`);
  }
  const mediaType = file.type as SupportedMediaType;

  const { img, dataUrl } = await loadImage(file);
  const needsResize =
    img.naturalWidth > SDK_MAX_DIMENSION ||
    img.naturalHeight > SDK_MAX_DIMENSION;

  if (!needsResize) {
    const base64 = base64Payload(dataUrl);
    if (base64.length <= SDK_MAX_BASE64_SIZE) {
      return { dataUrl, base64Data: base64, mediaType };
    }
  }

  const { width, height } = calculateTargetDimensions(
    img.naturalWidth,
    img.naturalHeight,
    SDK_MAX_DIMENSION,
  );
  const canvas = drawToCanvas(img, width, height);

  try {
    const isGif = mediaType === 'image/gif';
    const nativeFormat = isGif ? 'image/png' : mediaType;

    const nativeResult = tryCanvasExport(canvas, nativeFormat);
    if (nativeResult) {
      const resultType = (isGif ? 'image/png' : mediaType) as SupportedMediaType;
      return {
        dataUrl: nativeResult,
        base64Data: base64Payload(nativeResult),
        mediaType: resultType,
      };
    }

    for (const quality of JPEG_QUALITY_CASCADE) {
      const result = tryCanvasExport(canvas, 'image/jpeg', quality);
      if (result) {
        return {
          dataUrl: result,
          base64Data: base64Payload(result),
          mediaType: 'image/jpeg',
        };
      }
    }

    throw new Error('Image too large to compress within SDK limits');
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
