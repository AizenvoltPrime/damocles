<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Folder, FolderTree } from 'lucide-vue-next';
import { visibleText } from '@shared/visible-text';
import type { TabPlace } from './editor-place';

/**
 * An editor tab's place chip (D31): the worktree's branch leaf, or as much of the branch as tells it from another open
 * worktree's, or "Project folder". Its label is whole or absent: where the tab has no room for it, the chip folds to its icon,
 * and its full name stays in the title and the accessible name.
 */
const props = defineProps<{ place: NonNullable<TabPlace>; folded: boolean }>();
const { t } = useI18n();

const worktree = computed(() => props.place.kind === 'worktree');
const name = computed(() => {
  if (props.place.kind !== 'worktree') return t('worktree.chip.projectFolder');
  return props.place.branch === undefined ? t('worktree.chip.worktree') : t('worktree.chip.tab', { branch: visibleText(props.place.branch) });
});
const label = computed(() => {
  if (props.place.kind !== 'worktree') return t('worktree.chip.projectFolder');
  return props.place.label === undefined ? t('worktree.chip.worktree') : visibleText(props.place.label);
});
</script>

<template>
  <span
    role="img"
    :aria-label="name"
    :title="name"
    data-place-chip
    :data-folded="folded || undefined"
    :data-testid="worktree ? 'editor-tab-worktree' : 'editor-tab-project-folder'"
    class="flex h-4 shrink-0 items-center gap-0.75 rounded-full px-1.25 text-10"
    :class="[worktree ? 'bg-(--d-accent-soft) text-(--d-accent-text)' : 'bg-(--d-hover) text-(--d-muted)', place.kind === 'worktree' && place.label !== undefined ? 'font-mono' : '']"
    :dir="place.kind === 'worktree' && place.label !== undefined ? 'ltr' : undefined"
  >
    <component
      :is="worktree ? FolderTree : Folder"
      aria-hidden="true"
      class="size-2.5 shrink-0"
    />
    <span
      v-if="!folded"
      aria-hidden="true"
      class="shrink-0 whitespace-nowrap"
      data-testid="editor-tab-place-label"
    >{{ label }}</span>
  </span>
</template>
