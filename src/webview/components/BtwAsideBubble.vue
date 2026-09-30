<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { BtwAside } from '@/stores/useBtwStore';
import { Button } from '@/components/ui/button';
import { IconMessageSquare, IconBan } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import OverlayShell from './OverlayShell.vue';

const props = defineProps<{
  aside: BtwAside;
}>();
const { t } = useI18n();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'dismiss'): void;
}>();

const statusBadge = computed(() => {
  if (props.aside.error) {
    return { label: t('common.error'), class: 'bg-destructive/30 text-destructive border-destructive/30', icon: IconBan };
  }
  if (props.aside.isStreaming) {
    return { label: t('btw.streaming'), class: 'bg-primary/30 text-primary border-primary/30', showSpinner: true };
  }
  return undefined;
});
</script>

<template>
  <OverlayShell
    :title="t('btw.title')"
    :subtitle="t('btw.subtitle')"
    :icon="IconMessageSquare"
    icon-class="text-muted-foreground"
    :status-badge="statusBadge"
    @close="emit('close')"
  >
    <template #header-actions>
      <Button
        variant="ghost"
        size="sm"
        class="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0 text-xs h-7 px-2"
        @click="emit('dismiss')"
      >
        {{ t('common.dismiss') }}
      </Button>
    </template>

    <div class="p-4 space-y-4">
      <div class="py-2 px-3 border-l-2 border-border bg-muted/70 rounded-r-md">
        <p class="text-sm text-muted-foreground italic">{{ aside.question }}</p>
      </div>

      <div v-if="aside.error" class="text-sm text-destructive px-1">
        {{ aside.error }}
      </div>

      <div v-else-if="aside.text" class="px-1">
        <MarkdownRenderer :content="aside.text" />
      </div>

      <div v-else-if="aside.isStreaming" class="flex items-center gap-2 text-sm text-muted-foreground px-1 py-4">
        <LoadingSpinner :size="16" />
        <span>{{ t('btw.thinking') }}</span>
      </div>
    </div>
  </OverlayShell>
</template>
