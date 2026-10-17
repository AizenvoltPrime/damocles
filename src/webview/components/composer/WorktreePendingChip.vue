<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { FolderTree, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { visibleText } from '@shared/visible-text';

/**
 * D30: the opted-in chat's "Worktree from {branch}" chip in the composer until its first send; removing it cancels the opt-in.
 */
defineProps<{ branch: string; uncommitted?: number | undefined }>();
const emit = defineEmits<{ cancel: [] }>();
const { t } = useI18n();
</script>

<template>
  <div class="flex px-3 pt-2.5">
    <span
      class="inline-flex h-5.5 max-w-full min-w-0 items-center gap-1.25 rounded-full bg-(--d-accent-soft) ps-2 pe-1 text-11.5 whitespace-nowrap text-(--d-accent-text)"
      :title="t('worktree.chipTitle', { branch: visibleText(branch) })"
      data-testid="worktree-chip"
    >
      <FolderTree
        aria-hidden="true"
        class="size-2.75 shrink-0"
      />
      <i18n-t
        keypath="worktree.chip"
        tag="span"
        class="min-w-0 truncate"
        scope="global"
      >
        <template #branch>
          <span
            class="font-mono"
            dir="ltr"
          >{{ visibleText(branch) }}</span>
        </template>
      </i18n-t>
      <span
        v-if="uncommitted"
        class="shrink-0"
        data-testid="worktree-chip-uncommitted"
      >{{ t('worktree.chipUncommitted', { n: uncommitted }) }}</span>
      <!-- The 0.9375rem face keeps the chip's size; the transparent ::before around it makes the 1.5625rem target (WCAG 2.5.8). -->
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        class="relative size-3.75 shrink-0 rounded-full p-0.5 before:absolute before:-inset-1.25 before:rounded-full before:content-[''] text-current opacity-75 transition-opacity hover:bg-(--d-accent-soft) hover:text-current hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-2.75"
        :title="t('worktree.chipRemove')"
        :aria-label="t('worktree.chipRemove')"
        data-testid="worktree-chip-remove"
        @click="emit('cancel')"
      >
        <X aria-hidden="true" />
      </Button>
    </span>
  </div>
</template>
