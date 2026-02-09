<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ExpandedDiff } from '@/stores/useDiffStore';
import { IconPencilSquare, IconPencil } from '@/components/icons';
import DiffView from './DiffView.vue';
import OverlayShell from './OverlayShell.vue';
import { computeDiff, computeNewFileOnlyDiff } from '@/utils/parseUnifiedDiff';

const { t } = useI18n();

const props = defineProps<{
  diff: ExpandedDiff;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const fileName = computed(() => {
  const parts = props.diff.filePath.split(/[/\\]/);
  return parts[parts.length - 1] || props.diff.filePath;
});

const diffStats = computed(() => {
  const result = props.diff.isNewFile || !props.diff.oldContent
    ? computeNewFileOnlyDiff(props.diff.newContent)
    : computeDiff(props.diff.oldContent, props.diff.newContent);

  return result.stats;
});

const toolIcon = computed(() => props.diff.isNewFile ? IconPencil : IconPencilSquare);
const toolName = computed(() => props.diff.isNewFile ? t('diffOverlay.write') : t('diffOverlay.edit'));
</script>

<template>
  <OverlayShell
    :title="diff.filePath"
    title-class="font-mono"
    :icon="toolIcon"
    icon-class="text-primary"
    @close="emit('close')"
  >
    <template #subtitle>
      <div class="flex items-center gap-1.5">
        <span>{{ toolName }}</span>
        <span class="text-muted-foreground/50">&bull;</span>
        <span>{{ fileName }}</span>
        <span v-if="diffStats.added > 0" class="text-success">+{{ diffStats.added }}</span>
        <span v-if="diffStats.removed > 0" class="text-error">-{{ diffStats.removed }}</span>
      </div>
    </template>

    <DiffView
      :old-content="diff.oldContent"
      :new-content="diff.newContent"
      :file-name="diff.filePath"
      :is-new-file="diff.isNewFile"
      :show-header="false"
      max-height="none"
    />
  </OverlayShell>
</template>
