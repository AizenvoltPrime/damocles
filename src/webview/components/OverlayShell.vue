<script setup lang="ts">
import type { Component } from 'vue';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { IconArrowLeft } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import { useOverlayEscape } from '@/composables/useOverlayEscape';

defineProps<{
  title: string;
  subtitle?: string;
  icon: Component;
  iconClass?: string;
  titleClass?: string;
  statusBadge?: {
    label: string;
    class: string;
    icon?: Component;
    showSpinner?: boolean;
  };
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

useOverlayEscape(() => emit('close'));
</script>

<template>
  <div class="absolute inset-0 z-50 flex flex-col bg-background overflow-hidden">
    <header class="flex items-center gap-3 px-4 py-3 bg-muted border-b border-border/30 shrink-0">
      <Button
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground hover:bg-background shrink-0"
        @click="emit('close')"
      >
        <IconArrowLeft :size="18" />
      </Button>

      <component :is="icon" :size="20" class="shrink-0" :class="iconClass ?? 'text-foreground'" />

      <div class="flex-1 min-w-0">
        <h2 class="text-sm font-medium text-foreground truncate" :class="titleClass">{{ title }}</h2>
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

    <div class="flex-1 overflow-y-auto">
      <slot />
    </div>

    <slot name="footer" />
  </div>
</template>
