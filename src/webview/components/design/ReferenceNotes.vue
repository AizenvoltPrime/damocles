<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Images } from 'lucide-vue-next';
import type { ImageBlock } from '@shared/types/content';
import type { DesignReferenceNote } from '@shared/types/design';
import { Button } from '@/components/ui/button';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useDesignStore } from '@/stores/useDesignStore';
import { imageBlockToDataUrl } from '@/utils/imageUtils';

// The images of a design chat message that core saved as references (PD-40): each one's thumbnail and the file it became.
const props = defineProps<{ references: readonly DesignReferenceNote[]; images: readonly ImageBlock[] }>();
const emit = defineEmits<{ openLightbox: [block: ImageBlock] }>();
const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const designStore = useDesignStore();

const designId = computed(() => designStore.design?.designId);
const notes = computed(() => props.references.map((reference) => {
  const block = props.images[reference.imageIndex];
  return { reference, block, url: block ? imageBlockToDataUrl(block) : undefined };
}));

function open(file: string): void {
  if (designId.value) postMessage({ type: 'openDesignFile', designId: designId.value, file });
}
</script>

<template>
  <ul
    class="mb-2 flex flex-col gap-1.5"
    data-testid="reference-notes"
  >
    <li
      v-for="{ reference, block, url } in notes"
      :key="reference.id"
      data-testid="reference-note"
      :data-reference="reference.id"
      class="flex max-w-full min-w-0 items-center gap-2.5 rounded-lg border border-[color-mix(in_srgb,var(--d-design)_30%,var(--d-border))] bg-[color-mix(in_srgb,var(--d-design)_5%,var(--d-card))] p-1.5 pe-2.5"
    >
      <Button
        v-if="block && url"
        type="button"
        variant="ghost"
        data-testid="reference-note-image"
        class="block size-11 flex-none cursor-zoom-in overflow-hidden rounded-6 border border-(--d-border) bg-(--d-bg) p-0 hover:bg-(--d-bg) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-1"
        :title="t('imageThumbnail.clickToPreview')"
        @click="emit('openLightbox', block)"
      >
        <img
          :src="url"
          :alt="t('design.reference.thumbnail', { id: reference.id })"
          class="size-full object-cover"
        >
      </Button>
      <span
        v-else
        aria-hidden="true"
        class="flex size-11 flex-none items-center justify-center rounded-6 bg-[color-mix(in_srgb,var(--d-design)_15%,transparent)] text-(--d-design-text)"
      >
        <Images class="size-4" />
      </span>
      <span class="flex min-w-0 flex-col gap-0.5">
        <span class="text-12 font-medium text-(--d-text)">{{ t('design.reference.title', { id: reference.id }) }}</span>
        <i18n-t
          keypath="design.reference.savedAs"
          tag="span"
          scope="global"
          class="min-w-0 text-11 text-(--d-muted)"
          data-testid="reference-note-text"
        >
          <template #file>
            <!-- A link in the sentence's flow, wrapping with it, which no Button part lays out. -->
            <button
              type="button"
              dir="ltr"
              data-testid="reference-note-file"
              :data-file="reference.image"
              :title="t('design.reference.open', { file: reference.image })"
              :disabled="!designId"
              class="rounded-sm font-mono break-all text-(--d-text) underline decoration-(--d-border2) underline-offset-2 enabled:hover:decoration-(--d-text) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--d-accent) disabled:no-underline"
              @click="open(reference.image)"
            >
              {{ reference.image }}
            </button>
          </template>
        </i18n-t>
      </span>
    </li>
  </ul>
</template>
