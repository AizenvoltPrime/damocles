<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolsSnapshot } from '@shared/types/tools';
import { Button } from '@/components/ui/button';
import { IconLayers } from '@/components/icons';

const { t } = useI18n();

const props = defineProps<{
  snapshot: ToolsSnapshot;
  disabled?: boolean;
}>();

defineEmits<{
  (e: 'click'): void;
}>();

const summary = computed(() => {
  const toggleable = props.snapshot.tools.filter((tool) => tool.toggleable);
  const enabled = toggleable.filter((tool) => tool.enabled).length;
  return {
    label: t('toolsIndicator.summary', { enabled, total: toggleable.length }),
    color: enabled > 0 ? 'text-success' : 'text-muted-foreground',
  };
});
</script>

<template>
  <Button
    variant="ghost"
    size="icon-sm"
    :class="[summary.color, { 'opacity-50 cursor-not-allowed': disabled }]"
    class="hover:bg-muted"
    :title="summary.label"
    :disabled="disabled"
    @click="$emit('click')"
  >
    <IconLayers :size="16" />
  </Button>
</template>
