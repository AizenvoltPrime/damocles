<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogClose, DialogTitle } from 'reka-ui';
import { X } from 'lucide-vue-next';
import { useOverlayEscape } from '@/composables/useOverlayEscape';

const { t } = useI18n();

defineProps<{
  imageUrl: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { zIndex } = useOverlayEscape(() => emit('close'));
</script>

<template>
  <DialogRoot
    :open="true"
    @update:open="(v) => !v && emit('close')"
  >
    <DialogPortal>
      <DialogOverlay
        class="d-scrim fixed inset-0 bg-(--d-scrim) backdrop-blur-[6px]"
        :style="{ zIndex }"
      />
      <!-- Escape belongs to the overlay stack: the dialog's own dismissal is suppressed and `data-overlay-layer` keeps the stack from yielding to it. -->
      <DialogContent
        data-overlay-layer
        class="d-dialog fixed left-1/2 top-1/2 -translate-1/2 outline-none"
        :style="{ zIndex }"
        :aria-describedby="undefined"
        @escape-key-down="(e: KeyboardEvent) => e.preventDefault()"
      >
        <DialogTitle class="sr-only">
          {{ t('imageLightbox.title') }}
        </DialogTitle>
        <div class="relative inline-block">
          <img
            :src="imageUrl"
            :alt="t('imageLightbox.enlarged')"
            class="max-h-[88vh] max-w-[90vw] rounded-xl border border-(--d-border2) object-contain shadow-(--d-shadow)"
          >
          <DialogClose
            class="d-press absolute -top-3 -right-3 flex size-7.5 items-center justify-center rounded-9 border border-(--d-border2) bg-(--d-card) text-(--d-muted) shadow-(--d-shadow) transition-colors hover:bg-(--d-hover) hover:text-(--d-text)"
            :title="t('overlays.closeHint')"
          >
            <X
              class="size-4"
              aria-hidden="true"
            />
            <span class="sr-only">{{ t('common.close') }}</span>
          </DialogClose>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
