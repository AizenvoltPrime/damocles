import { ref, onUnmounted, type Ref } from 'vue';
import type { ImageBlock } from '@shared/types/content';
import { imageBlockToDataUrl } from '@/utils/imageUtils';

const MAX_CACHE_ENTRIES = 128;
const dimensionCache = new Map<string, { width: number; height: number }>();

function readCache(key: string): { width: number; height: number } | undefined {
  const hit = dimensionCache.get(key);
  if (!hit) return undefined;
  dimensionCache.delete(key);
  dimensionCache.set(key, hit);
  return hit;
}

function writeCache(key: string, dims: { width: number; height: number }): void {
  if (dimensionCache.has(key)) dimensionCache.delete(key);
  dimensionCache.set(key, dims);
  if (dimensionCache.size > MAX_CACHE_ENTRIES) {
    const oldest = dimensionCache.keys().next();
    if (!oldest.done) dimensionCache.delete(oldest.value);
  }
}

export function useImageBlockDimensions(block: ImageBlock): Ref<{ width: number; height: number } | null> {
  const key = `${block.source.data.length}:${block.source.data.slice(0, 64)}`;
  const cached = readCache(key);
  const result = ref<{ width: number; height: number } | null>(cached ?? null);

  if (!cached) {
    const img = new Image();
    img.onload = () => {
      const dims = { width: img.naturalWidth, height: img.naturalHeight };
      writeCache(key, dims);
      result.value = dims;
    };
    img.onerror = () => {
      result.value = null;
    };
    img.src = imageBlockToDataUrl(block);

    onUnmounted(() => {
      img.onload = null;
      img.onerror = null;
    });
  }

  return result;
}
