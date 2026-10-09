<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { FileWarning, GitCompare, RotateCcw, Save } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { EditorConflictRequest } from '../../preload/shell-channels';

// The file changed on disk under unsaved edits, or a save was refused for that: nothing discards the text until the user
// picks Compare (a diff tab), Overwrite (main confirms) or Revert. name: the file's name, on its own tab and its Compare tab
// alike; compare: the Compare tab, which offers only Overwrite and Revert (textFileSaveErrorHandler.ts).
defineProps<{ name: string; compare: boolean; busy: boolean }>();
const emit = defineEmits<{ resolve: [action: EditorConflictRequest['action']] }>();
const { t } = useI18n();
</script>

<template>
  <div
    role="alert"
    data-testid="conflict-bar"
    class="conflict-bar flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[color-mix(in_srgb,var(--d-warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--d-warning)_10%,var(--d-bg))] px-3.5 py-1.75"
  >
    <span class="flex size-6 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--d-warning)_18%,transparent)] text-(--d-warning-text)">
      <FileWarning
        aria-hidden="true"
        class="size-3.5"
      />
    </span>
    <p class="min-w-48 flex-1 text-12 text-(--d-text)">
      <!-- One line, so the space between the sentences survives the template's whitespace condensing. -->
      <span class="font-semibold">{{ t('editor.conflict.title', { name }) }}</span> <span class="text-(--d-muted)">{{ t('editor.conflict.detail') }}</span>
    </p>
    <div class="flex shrink-0 gap-1.5">
      <Button
        v-if="!compare"
        size="sm"
        variant="outline"
        data-testid="conflict-compare"
        class="d-press h-6.5 gap-1.5 rounded-7 border-(--d-border2) bg-(--d-card) px-2.5 text-12 hover:border-(--d-accent) hover:bg-(--d-card) [&_svg]:size-3.25"
        :disabled="busy"
        @click="emit('resolve', 'compare')"
      >
        <GitCompare aria-hidden="true" />{{ t('editor.conflict.compare') }}
      </Button>
      <Button
        size="sm"
        variant="outline"
        data-testid="conflict-revert"
        class="d-press h-6.5 gap-1.5 rounded-7 border-(--d-border2) bg-(--d-card) px-2.5 text-12 hover:border-(--d-accent) hover:bg-(--d-card) [&_svg]:size-3.25"
        :disabled="busy"
        @click="emit('resolve', 'revert')"
      >
        <RotateCcw aria-hidden="true" />{{ t('editor.conflict.revert') }}
      </Button>
      <Button
        size="sm"
        data-testid="conflict-overwrite"
        class="d-press h-6.5 gap-1.5 rounded-7 px-2.5 text-12 [&_svg]:size-3.25"
        :disabled="busy"
        @click="emit('resolve', 'overwrite')"
      >
        <Save aria-hidden="true" />{{ t('editor.conflict.overwrite') }}
      </Button>
    </div>
  </div>
</template>
