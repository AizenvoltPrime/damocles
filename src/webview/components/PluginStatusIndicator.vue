<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PluginStatusInfo } from '@shared/types/plugins';
import { Button } from '@/components/ui/button';
import { IconPuzzle } from '@/components/icons';

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
      label: t('pluginIndicator.noPlugins'),
      color: 'text-muted-foreground',
    };
  }

  const enabled = props.plugins.filter(p => p.enabled).length;
  const loaded = props.plugins.filter(p => p.status === 'loaded').length;
  const failed = props.plugins.filter(p => p.status === 'failed').length;
  const pending = props.plugins.filter(p => p.status === 'pending').length;
  const total = props.plugins.length;

  if (pending > 0) {
    return {
      label: t('pluginIndicator.loading', { loaded, enabled }),
      color: 'text-warning',
    };
  }

  if (failed > 0) {
    return {
      label: t('pluginIndicator.withFailures', { loaded, enabled, failed }),
      color: 'text-error',
    };
  }

  if (enabled === 0) {
    return {
      label: t('pluginIndicator.ready', { enabled }),
      color: 'text-muted-foreground',
    };
  }

  return {
    label: loaded > 0 ? t('pluginIndicator.loaded', { loaded, total }) : t('pluginIndicator.ready', { enabled }),
    color: 'text-success',
  };
});
</script>

<template>
  <Button
    variant="ghost"
    size="icon-sm"
    :class="[statusSummary.color, { 'opacity-50 cursor-not-allowed': disabled }]"
    class="hover:bg-muted"
    :title="statusSummary.label"
    :disabled="disabled"
    @click="$emit('click')"
  >
    <IconPuzzle :size="16" />
  </Button>
</template>
