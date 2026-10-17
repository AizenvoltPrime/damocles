<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { FolderX, MessageSquarePlus } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';

/** Rule 18: a chat whose worktree was deleted is read-only history; this card takes the composer's place. */
const emit = defineEmits<{ newChat: [] }>();
const { t } = useI18n();
</script>

<template>
  <div
    class="flex items-center gap-2.5 rounded-2xl border border-(--d-border2) bg-(--d-card) py-2.5 ps-3.5 pe-2.5"
    role="status"
    data-testid="worktree-deleted"
  >
    <FolderX
      aria-hidden="true"
      class="size-4 shrink-0 text-(--d-faint)"
    />
    <div class="flex min-w-0 flex-1 flex-col">
      <span class="font-medium">{{ t('worktree.deleted') }}</span>
      <span class="text-11.5 text-(--d-faint-text)">{{ t('worktree.deletedNote') }}</span>
    </div>
    <Button
      type="button"
      class="d-press h-7 shrink-0 gap-1.5 rounded-7 bg-(--d-accent) px-2.75 text-xs font-semibold text-(--d-on-accent) hover:bg-(--d-accent) hover:brightness-110 focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 [&_svg]:size-3.25"
      data-testid="worktree-new-chat-in-project"
      @click="emit('newChat')"
    >
      <MessageSquarePlus aria-hidden="true" />{{ t('worktree.newChatInProject') }}
    </Button>
  </div>
</template>
