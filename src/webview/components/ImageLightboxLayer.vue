<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogClose, DialogTitle } from 'reka-ui';
import { IconX } from '@/components/icons';
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
  <DialogRoot :open="true" @update:open="(v) => !v && emit('close')">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        :style="{ zIndex }"
      />
      <!-- Escape belongs to the overlay stack, so the dialog's own Escape dismissal is suppressed. -->
      <DialogContent
        class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 outline-none"
        :style="{ zIndex }"
        :aria-describedby="undefined"
        @escape-key-down="(e: KeyboardEvent) => e.preventDefault()"
      >
        <DialogTitle class="sr-only">{{ t('imageLightbox.title') }}</DialogTitle>
        <div class="relative inline-block">
          <img
            :src="imageUrl"
            :alt="t('imageLightbox.enlarged')"
            class="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
          />
          <DialogClose
            class="absolute -top-3 -right-3 w-8 h-8 rounded-full bg-background text-foreground border border-border
                   flex items-center justify-center shadow-lg
                   hover:bg-muted transition-colors cursor-pointer"
          >
            <IconX :size="18" />
            <span class="sr-only">{{ t('common.close') }}</span>
          </DialogClose>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
