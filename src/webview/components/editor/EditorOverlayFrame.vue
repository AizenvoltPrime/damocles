<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { IconArrowLeft } from '@/components/icons';
import { useOverlayDialog } from '@/composables/useOverlayDialog';

defineProps<{
  title: string;
  subtitle?: string | undefined;
  closeTestId: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const { zIndex, root, titleId } = useOverlayDialog(() => emit('close'));
</script>

<template>
  <div
    ref="root"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    tabindex="-1"
    class="absolute inset-0 flex flex-col bg-background overflow-hidden outline-none"
    :style="{ zIndex }"
  >
    <header class="flex items-center gap-3 px-4 py-3 bg-muted border-b border-border/30 shrink-0">
      <Button
        variant="ghost"
        size="icon-sm"
        :aria-label="t('overlay.close')"
        :data-testid="closeTestId"
        class="text-muted-foreground hover:text-foreground hover:bg-background shrink-0"
        @click="emit('close')"
      >
        <IconArrowLeft :size="18" />
      </Button>
      <div class="flex-1 min-w-0">
        <h2
          :id="titleId"
          class="text-sm font-medium text-foreground truncate"
        >
          {{ title }}
        </h2>
        <div
          v-if="subtitle"
          class="text-xs text-muted-foreground truncate"
        >
          {{ subtitle }}
        </div>
      </div>
      <slot name="header-actions" />
    </header>
    <slot name="banner" />
    <div class="flex-1 min-h-0 relative">
      <slot />
    </div>
    <slot name="footer" />
  </div>
</template>
