<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ExpandedDiff } from '@/stores/useDiffStore';
import { FilePen, FilePlus } from 'lucide-vue-next';
import DiffView from './DiffView.vue';
import OverlayShell from './OverlayShell.vue';
import { useFolderRelativePath } from '@/composables/useFolderRelativePath';
import { buildFileDiff } from '@/utils/parseUnifiedDiff';

const { t } = useI18n();
const relativePath = useFolderRelativePath();

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

const fileDiff = computed(() => buildFileDiff(props.diff.source));

const toolIcon = computed(() => props.diff.tool === 'Write' ? FilePlus : FilePen);
const toolName = computed(() => props.diff.tool === 'Write' ? t('diffOverlay.write') : t('diffOverlay.edit'));
</script>

<template>
  <OverlayShell
    max-width="62.5rem"
    :title="relativePath(diff.filePath)"
    title-class="font-mono"
    :icon="toolIcon"
    data-testid="diff-overlay"
    @close="emit('close')"
  >
    <template #subtitle>
      <div class="flex items-center gap-1.5">
        <span>{{ toolName }}</span>
        <span class="text-(--d-faint)">&bull;</span>
        <span
          class="truncate font-mono"
          :title="diff.filePath"
        >{{ fileName }}</span>
      </div>
    </template>

    <template
      v-if="!fileDiff.omitted"
      #header-actions
    >
      <span
        class="flex-none rounded-full bg-[color-mix(in_srgb,var(--d-success)_14%,transparent)] px-2 font-mono text-11/5 text-(--d-success-text)"
        data-testid="diff-overlay-added"
      >+{{ fileDiff.stats.added }}</span>
      <span
        class="flex-none rounded-full bg-[color-mix(in_srgb,var(--d-danger)_14%,transparent)] px-2 font-mono text-11/5 text-(--d-danger-text)"
        data-testid="diff-overlay-removed"
      >−{{ fileDiff.stats.removed }}</span>
    </template>

    <div class="px-4 pt-3 pb-4">
      <div class="overflow-hidden rounded-lg border border-(--d-border) bg-(--d-code)">
        <DiffView
          :diff="fileDiff"
          :file-name="diff.filePath"
          max-height="none"
        />
      </div>
    </div>
  </OverlayShell>
</template>
