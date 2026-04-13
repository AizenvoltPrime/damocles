<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { McpServerStatusInfo } from '@shared/types/mcp';
import { Button } from '@/components/ui/button';
import { IconMcp } from '@/components/icons';

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
    return { label: '', color: '' };
  }

  const enabled = props.servers.filter(s => s.enabled).length;
  const connected = props.servers.filter(s => s.status === 'connected').length;
  const failed = props.servers.filter(s => s.status === 'failed').length;
  const pending = props.servers.filter(s => s.status === 'pending').length;
  const total = props.servers.length;

  if (pending > 0) {
    return {
      label: t('mcpIndicator.connecting', { connected, total }),
      color: 'text-warning',
    };
  }

  if (failed > 0) {
    return {
      label: t('mcpIndicator.withFailures', { connected, total, failed }),
      color: 'text-error',
    };
  }

  if (enabled === 0) {
    return {
      label: t('mcpIndicator.connected', { connected, total }),
      color: 'text-muted-foreground',
    };
  }

  return {
    label: t('mcpIndicator.connected', { connected, total }),
    color: 'text-success',
  };
});

const hasServers = computed(() => props.servers.length > 0);
</script>

<template>
  <Button
    v-if="hasServers"
    variant="ghost"
    size="icon-sm"
    :class="[statusSummary.color, { 'opacity-50 cursor-not-allowed': disabled }]"
    class="hover:bg-muted"
    :title="statusSummary.label"
    :disabled="disabled"
    @click="$emit('click')"
  >
    <IconMcp :size="16" />
  </Button>
</template>
