import { ref, computed } from 'vue';
import {
  isImageMediaType,
  MAX_IMAGES_PER_MESSAGE,
  type ImageMediaType,
  type UserImageBlock,
  type UserImageOrigin,
} from '@shared/types/content';
import type { DesignPreviewImage } from '@shared/types/design';
import { i18n } from '@/i18n';
import { resizeImageForSDK } from '@/utils/imageUtils';

export interface ImageAttachment {
  id: string;
  dataUrl: string;
  base64Data: string;
  mediaType: ImageMediaType;
  fileName?: string;
  width: number;
  height: number;
  /** Where Damocles made the image (PD-40); absent for one the user brought (file, paste, drop). */
  origin?: UserImageOrigin;
}

const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;

function loadDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  const img = new Image();
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('Failed to probe image dimensions'));
    img.src = dataUrl;
  }).finally(() => {
    img.onload = null;
    img.onerror = null;
  });
}

export function useImageAttachments() {
  const attachments = ref<ImageAttachment[]>([]);

  const hasAttachments = computed(() => attachments.value.length > 0);
  const canAddMore = computed(() => attachments.value.length < MAX_IMAGES_PER_MESSAGE);

  function generateId(): string {
    return `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  async function addFromFile(file: File): Promise<{ success: boolean; error?: string }> {
    if (!canAddMore.value) {
      return { success: false, error: i18n.global.t('imageAttachment.maxAllowed', { n: MAX_IMAGES_PER_MESSAGE }) };
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      return { success: false, error: i18n.global.t('imageAttachment.tooLarge', { n: MAX_IMAGE_SIZE_BYTES / 1024 / 1024 }) };
    }

    if (!isImageMediaType(file.type)) {
      return { success: false, error: i18n.global.t('imageAttachment.unsupportedType') };
    }

    try {
      const resized = await resizeImageForSDK(file);
      const { width, height } = await loadDimensions(resized.dataUrl);

      attachments.value.push({
        id: generateId(),
        dataUrl: resized.dataUrl,
        base64Data: resized.base64Data,
        mediaType: resized.mediaType,
        fileName: file.name,
        width,
        height,
      });

      return { success: true };
    } catch {
      return { success: false, error: i18n.global.t('imageAttachment.resizeFailed') };
    }
  }

  async function addFromClipboard(clipboardData: DataTransfer): Promise<{ success: boolean; error?: string }> {
    const imageItems = Array.from(clipboardData.items).filter(
      (item) => item.kind === "file" && item.type.startsWith("image/")
    );

    if (imageItems.length === 0) {
      return { success: false, error: i18n.global.t('imageAttachment.noImagesInClipboard') };
    }

    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) {
        const result = await addFromFile(file);
        if (!result.success) {
          return result;
        }
      }
    }

    return { success: true };
  }

  /** Re-attach an image a message already carried, so already resized for the SDK. Skipped past the per-message cap. */
  async function addFromBlock(block: UserImageBlock): Promise<void> {
    const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`;
    const { width, height } = await loadDimensions(dataUrl).catch(() => ({ width: 0, height: 0 }));
    if (!canAddMore.value) return;
    attachments.value.push({ id: generateId(), dataUrl, base64Data: block.source.data, mediaType: block.source.media_type, width, height, ...(block.origin && { origin: block.origin }) });
  }

  /** An image main captured for this composer (the design preview's Screenshot); main bounds its size. */
  function addCaptured(image: DesignPreviewImage, origin: UserImageOrigin): { success: boolean; error?: string } {
    if (!canAddMore.value) {
      return { success: false, error: i18n.global.t('imageAttachment.maxAllowed', { n: MAX_IMAGES_PER_MESSAGE }) };
    }
    attachments.value.push({
      id: generateId(),
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
      base64Data: image.data,
      mediaType: image.mimeType,
      width: image.width,
      height: image.height,
      origin,
    });
    return { success: true };
  }

  function remove(id: string): void {
    const index = attachments.value.findIndex((a) => a.id === id);
    if (index !== -1) {
      attachments.value.splice(index, 1);
    }
  }

  function clear(): void {
    attachments.value = [];
  }

  function toContentBlocks(): UserImageBlock[] {
    return attachments.value.map((attachment) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: attachment.mediaType,
        data: attachment.base64Data,
      },
      ...(attachment.origin && { origin: attachment.origin }),
    }));
  }

  return {
    attachments,
    hasAttachments,
    canAddMore,
    addFromFile,
    addFromClipboard,
    addFromBlock,
    addCaptured,
    remove,
    clear,
    toContentBlocks,
  };
}
