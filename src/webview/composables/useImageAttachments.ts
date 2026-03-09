import { ref, computed } from 'vue';
import type { ImageBlock } from '@shared/types/content';
import { i18n } from '@/i18n';
import { resizeImageForSDK } from '@/utils/imageUtils';

export interface ImageAttachment {
  id: string;
  dataUrl: string;
  base64Data: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  fileName?: string;
}

const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const SUPPORTED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function useImageAttachments() {
  const attachments = ref<ImageAttachment[]>([]);

  const hasAttachments = computed(() => attachments.value.length > 0);
  const canAddMore = computed(() => attachments.value.length < MAX_ATTACHMENTS);

  function generateId(): string {
    return `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function isValidMediaType(type: string): type is ImageAttachment['mediaType'] {
    return SUPPORTED_TYPES.has(type);
  }

  async function addFromFile(file: File): Promise<{ success: boolean; error?: string }> {
    if (!canAddMore.value) {
      return { success: false, error: i18n.global.t('imageAttachment.maxAllowed', { n: MAX_ATTACHMENTS }) };
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      return { success: false, error: i18n.global.t('imageAttachment.tooLarge', { n: MAX_IMAGE_SIZE_BYTES / 1024 / 1024 }) };
    }

    if (!isValidMediaType(file.type)) {
      return { success: false, error: i18n.global.t('imageAttachment.unsupportedType') };
    }

    try {
      const resized = await resizeImageForSDK(file);

      attachments.value.push({
        id: generateId(),
        dataUrl: resized.dataUrl,
        base64Data: resized.base64Data,
        mediaType: resized.mediaType,
        fileName: file.name,
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

  function remove(id: string): void {
    const index = attachments.value.findIndex((a) => a.id === id);
    if (index !== -1) {
      attachments.value.splice(index, 1);
    }
  }

  function clear(): void {
    attachments.value = [];
  }

  function toContentBlocks(): ImageBlock[] {
    return attachments.value.map((attachment) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: attachment.mediaType,
        data: attachment.base64Data,
      },
    }));
  }

  return {
    attachments,
    hasAttachments,
    canAddMore,
    addFromFile,
    addFromClipboard,
    remove,
    clear,
    toContentBlocks,
  };
}
