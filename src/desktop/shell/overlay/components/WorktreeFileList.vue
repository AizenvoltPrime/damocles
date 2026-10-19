<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { visibleText } from '@shared/visible-text';
import { LETTER_TONE } from '@shared/scm/status-letter';
import type { ScmLetter } from '../../../preload/scm-channels';
import FileIcon from '../../components/FileIcon.vue';
import StatusLetter from '../../scm/StatusLetter.vue';

/**
 * A worktree dialog's file list (D33, D61): each path as its file icon, its name and its folder, an optional mark, and its git
 * status letter at the end in its source control colour. The rows tuck in one after another as the dialog opens;
 * indexOffset continues the stagger of the lists above it, so several lists reveal as one sequence.
 */
const props = defineProps<{
  label: string;
  files: readonly { readonly path: string; readonly letter?: ScmLetter | undefined; readonly mark?: string | undefined }[];
  testId?: string;
  indexOffset?: number;
}>();
const { t } = useI18n();

const rows = computed(() => props.files.map((file) => {
  const shown = visibleText(file.path);
  const slash = shown.lastIndexOf('/');
  const tone = file.letter === undefined ? undefined : LETTER_TONE[file.letter];
  return { key: file.path, shownPath: shown, name: shown.slice(slash + 1), folder: slash < 0 ? '' : shown.slice(0, slash), path: file.path, mark: file.mark, letter: file.letter, tone };
}));
</script>

<template>
  <ul
    :aria-label="label"
    :data-testid="testId ?? 'worktree-dialog-files'"
    class="max-h-40 overflow-y-auto rounded-9 border border-(--d-border) bg-(--d-panel) p-1"
  >
    <li
      v-for="(row, index) in rows"
      :key="row.key"
      class="d-row-reveal flex h-6.5 min-w-0 items-center gap-2 rounded-md px-1.75 text-12"
      :style="{ '--reveal-index': (indexOffset ?? 0) + index }"
      :title="row.shownPath"
      data-testid="worktree-dialog-file"
    >
      <FileIcon
        :path="row.path"
        class="size-3.25 shrink-0"
      />
      <!-- The folder gives way four times as fast as the name, so a long name cuts only after its folder has. -->
      <span
        class="min-w-0 shrink truncate"
        dir="ltr"
      >{{ row.name }}</span>
      <span
        v-if="row.folder"
        class="min-w-0 shrink-4 truncate text-11 text-(--d-faint-text)"
        dir="ltr"
      >{{ row.folder }}</span>
      <span
        v-if="row.mark"
        class="ms-auto shrink-0 rounded-full bg-(--d-warning)/15 px-1.5 text-10.5/4 font-medium text-(--d-warning-text)"
        data-testid="worktree-dialog-file-mark"
      >{{ row.mark }}</span>
      <template v-if="row.letter && row.tone">
        <StatusLetter
          aria-hidden="true"
          :class="row.mark ? '' : 'ms-auto'"
          :letter="row.letter"
          :title="t(`worktree.dialog.tone.${row.tone}`)"
          data-testid="worktree-dialog-file-letter"
        />
        <span class="sr-only">{{ t(`worktree.dialog.tone.${row.tone}`) }}</span>
      </template>
    </li>
  </ul>
</template>
