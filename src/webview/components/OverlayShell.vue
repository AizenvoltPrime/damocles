<script setup lang="ts">
import type { Component } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IconArrowLeft } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import { useOverlayDialog } from '@/composables/useOverlayDialog';

defineProps<{
  title: string;
  subtitle?: string | undefined;
  icon: Component;
  iconClass?: string | undefined;
  titleClass?: string | undefined;
  statusBadge?: {
    label: string;
    class: string;
    icon?: Component | undefined;
    showSpinner?: boolean | undefined;
  } | undefined;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
/** The close button is the first focusable in the header, which is what the dialog focuses on open. */
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
        class="text-muted-foreground hover:text-foreground hover:bg-background shrink-0"
        @click="emit('close')"
      >
        <IconArrowLeft :size="18" />
      </Button>

      <component :is="icon" :size="20" class="shrink-0" :class="iconClass ?? 'text-foreground'" />

      <div class="flex-1 min-w-0">
        <h2 :id="titleId" class="text-sm font-medium text-foreground truncate" :class="titleClass">{{ title }}</h2>
        <div v-if="$slots.subtitle || subtitle" class="text-xs text-muted-foreground leading-none">
          <slot name="subtitle">{{ subtitle }}</slot>
        </div>
      </div>

      <slot name="header-actions" />

      <Badge v-if="statusBadge" variant="secondary" :class="statusBadge.class" class="gap-1.5 shrink-0">
        <LoadingSpinner v-if="statusBadge.showSpinner" :size="12" />
        <component v-else-if="statusBadge.icon" :is="statusBadge.icon" :size="12" />
        <span>{{ statusBadge.label }}</span>
      </Badge>
    </header>

    <div class="flex-1 min-h-0 relative overflow-y-auto" style="scrollbar-gutter: stable">
      <slot />
    </div>

    <slot name="footer" />
  </div>
</template>
