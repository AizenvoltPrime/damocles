<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Wrench } from 'lucide-vue-next';
import { enabledToolCount, type ToolsSnapshot } from '@shared/types/tools';

const { t } = useI18n();

const props = defineProps<{
  snapshot: ToolsSnapshot;
  disabled?: boolean;
}>();

defineEmits<{
  (e: 'click'): void;
}>();

const enabled = computed(() => enabledToolCount(props.snapshot));
const label = computed(() => t('chatHeader.tools', { n: enabled.value }, enabled.value));
</script>

<template>
  <button
    type="button"
    class="d-tool-btn px-1.75"
    :title="label"
    :aria-label="label"
    :disabled="disabled"
    data-testid="chat-header-tools"
    @click="$emit('click')"
  >
    <Wrench
      class="size-3.5"
      aria-hidden="true"
    />
    <span
      class="font-mono text-11 tabular-nums"
      aria-hidden="true"
    >{{ enabled }}</span>
  </button>
</template>
