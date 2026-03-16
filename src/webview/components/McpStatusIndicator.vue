<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { McpServerStatusInfo } from '@shared/types/mcp';
import { Button } from '@/components/ui/button';
import { IconCheck, IconExclamation } from '@/components/icons';

const { t } = useI18n();

const props = defineProps<{
  servers: McpServerStatusInfo[];
  disabled?: boolean;
}>();

defineEmits<{
  (e: 'click'): void;
}>();

const statusSummary = computed(() => {
  if (props.servers.length === 0) {
    return { icon: null, label: '', color: '', text: '', count: 0 };
  }

  const connected = props.servers.filter(s => s.status === 'connected').length;
  const failed = props.servers.filter(s => s.status === 'failed').length;
  const pending = props.servers.filter(s => s.status === 'pending').length;
  const total = props.servers.length;

  if (pending > 0) {
    return {
      icon: null,
      label: t('mcpIndicator.connecting', { connected, total }),
      color: 'text-warning',
      text: '...',
      count: connected,
    };
  }

  if (failed > 0) {
    return {
      icon: IconExclamation,
      label: t('mcpIndicator.withFailures', { connected, total, failed }),
      color: 'text-error',
      text: '',
      count: connected,
    };
  }

  return {
    icon: IconCheck,
    label: t('mcpIndicator.connected', { connected, total }),
    color: 'text-success',
    text: '',
    count: connected,
  };
});

const hasServers = computed(() => props.servers.length > 0);
</script>

<template>
  <Button
    v-if="hasServers"
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
    <span class="hidden sm:inline opacity-70">{{ statusSummary.count }} {{ t('mcpIndicator.label') }}</span>
  </Button>
</template>
