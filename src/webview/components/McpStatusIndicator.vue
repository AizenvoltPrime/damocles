<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { McpServerStatusInfo } from '@shared/types/mcp';
import { IconMcp } from '@/components/icons';

const { t } = useI18n();

const props = defineProps<{
  servers: McpServerStatusInfo[];
  disabled?: boolean;
}>();

defineEmits<{
  (e: 'click'): void;
}>();

const summary = computed(() => {
  const total = props.servers.length;
  const connected = props.servers.filter((s) => s.status === 'connected').length;
  const failed = props.servers.filter((s) => s.status === 'failed').length;
  const pending = props.servers.filter((s) => s.status === 'pending').length;
  const head = t('chatHeader.mcp', { n: connected }, connected);
  if (pending > 0) return { connected, label: `${head} · ${t('mcpIndicator.connecting', { connected, total })}`, dot: 'bg-(--d-warning) d-pulsing' };
  if (failed > 0) return { connected, label: `${head} · ${t('mcpIndicator.withFailures', { connected, total, failed })}`, dot: 'bg-(--d-danger)' };
  return { connected, label: head, dot: connected > 0 ? 'bg-(--d-success)' : 'bg-(--d-faint)' };
});
</script>

<template>
  <button
    type="button"
    class="d-tool-btn px-1.75"
    :title="summary.label"
    :aria-label="summary.label"
    :disabled="disabled"
    data-testid="chat-header-mcp"
    @click="$emit('click')"
  >
    <IconMcp
      class="size-3.5"
      aria-hidden="true"
    />
    <span
      class="size-1.5 rounded-full"
      :class="summary.dot"
      aria-hidden="true"
    />
    <span
      class="font-mono text-11 tabular-nums"
      aria-hidden="true"
    >{{ summary.connected }}</span>
  </button>
</template>
