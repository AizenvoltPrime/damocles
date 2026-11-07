<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight } from 'lucide-vue-next';
import { useSettingsStore } from '@/stores/useSettingsStore';

// The files a rewind to one checkpoint changes: the count, the lines, and the list, whose rows open the checkpoint diff.
const props = defineProps<{
  filesAffected: number;
  files?: Array<{ path: string; displayName: string }> | undefined;
  linesChanged?: { added: number; removed: number } | undefined;
}>();

const emit = defineEmits<{ openRewindDiff: [path: string] }>();

const { t } = useI18n();
const settingsStore = useSettingsStore();
const expanded = ref(false);
const hasFileList = computed(() => !!props.files && props.files.length > 0);
</script>

<template>
  <div class="min-w-0">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        v-if="hasFileList"
        type="button"
        class="flex items-center gap-1 rounded text-(--d-accent) focus:outline-none focus-visible:ring-1 focus-visible:ring-(--d-accent)"
        :aria-expanded="expanded"
        :title="t('rewind.toggleFileList')"
        data-testid="rewind-files-toggle"
        @click="expanded = !expanded"
      >
        <ChevronRight
          class="size-3 transition-transform duration-200 ease-out"
          :class="expanded ? 'rotate-90' : ''"
          aria-hidden="true"
        />
        <span>{{ t('rewind.filesAffected', { n: filesAffected }, filesAffected) }}</span>
      </button>
      <span v-else>{{ t('rewind.filesAffected', { n: filesAffected }, filesAffected) }}</span>
      <template v-if="linesChanged">
        <span class="font-mono text-(--d-success)">{{ t('diff.linesAdded', { n: linesChanged.added }) }}</span>
        <span class="font-mono text-(--d-danger)">{{ t('diff.linesRemoved', { n: linesChanged.removed }) }}</span>
      </template>
    </div>
    <div
      v-if="hasFileList && expanded"
      class="mt-2 max-h-40 overflow-y-auto rounded-lg border border-(--d-border) bg-(--d-bg)"
      data-testid="rewind-file-list"
    >
      <template
        v-for="file in files"
        :key="file.path"
      >
        <button
          v-if="settingsStore.hostCapabilities.diffReview"
          type="button"
          class="w-full truncate px-3 py-1.5 text-left font-mono text-xs text-(--d-text) hover:bg-(--d-hover) focus:outline-none focus-visible:bg-(--d-hover)"
          :title="t('rewind.openDiffTooltip', { path: file.path })"
          @click="emit('openRewindDiff', file.path)"
        >
          {{ file.displayName }}
        </button>
        <div
          v-else
          class="truncate px-3 py-1.5 font-mono text-xs text-(--d-text)"
          :title="file.path"
        >
          {{ file.displayName }}
        </div>
      </template>
    </div>
  </div>
</template>
