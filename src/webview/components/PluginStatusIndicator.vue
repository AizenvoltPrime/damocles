<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PluginStatusInfo } from '@shared/types/plugins';
import { Button } from '@/components/ui/button';
import { IconCheck, IconExclamation, IconPuzzle } from '@/components/icons';

const { t } = useI18n();

const props = defineProps<{
  plugins: PluginStatusInfo[];
  disabled?: boolean;
}>();

defineEmits<{
  (e: 'click'): void;
}>();

const statusSummary = computed(() => {
  if (props.plugins.length === 0) {
    return {
      icon: IconPuzzle as Component,
      label: t('pluginIndicator.noPlugins'),
      color: 'text-muted-foreground',
      text: '',
      count: 0,
    };
  }

  const loaded = props.plugins.filter(p => p.status === 'loaded').length;
  const failed = props.plugins.filter(p => p.status === 'failed').length;
  const pending = props.plugins.filter(p => p.status === 'pending').length;
  const idle = props.plugins.filter(p => p.status === 'idle').length;
  const enabled = props.plugins.filter(p => p.enabled).length;
  const total = props.plugins.length;

  if (pending > 0) {
    return {
      icon: null,
      label: t('pluginIndicator.loading', { loaded, enabled }),
      color: 'text-warning',
      text: '...',
      count: enabled,
    };
  }

  if (failed > 0) {
    return {
      icon: IconExclamation as Component,
      label: t('pluginIndicator.withFailures', { loaded, enabled, failed }),
      color: 'text-error',
      text: '',
      count: enabled,
    };
  }

  if (idle > 0 && loaded === 0) {
    return {
      icon: IconPuzzle as Component,
      label: t('pluginIndicator.ready', { enabled }),
      color: 'text-muted-foreground',
      text: '',
      count: enabled,
    };
  }

  return {
    icon: IconCheck as Component,
    label: t('pluginIndicator.loaded', { loaded, total }),
    color: 'text-success',
    text: '',
    count: loaded,
  };
});
</script>

<template>
  <Button
    variant="ghost"
    size="sm"
    class="h-auto py-1 px-2 text-xs hover:bg-muted hover:text-inherit"
    :class="{ 'opacity-50 cursor-not-allowed': disabled }"
    :title="statusSummary.label"
    :disabled="disabled"
    @click="$emit('click')"
  >
    <span
      class="w-4 h-4 flex items-center justify-center rounded-full"
      :class="statusSummary.color"
    >
      <component v-if="statusSummary.icon" :is="statusSummary.icon" :size="12" />
      <span v-else class="text-xs font-bold">{{ statusSummary.text }}</span>
    </span>
    <span class="hidden sm:inline opacity-70">{{ statusSummary.count }} {{ t('pluginIndicator.label') }}</span>
  </Button>
</template>
