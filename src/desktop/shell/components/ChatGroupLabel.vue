<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ChatGroup } from '../chat-list';

// A Today / Yesterday / Earlier header of a chat list.
defineProps<{ group: ChatGroup }>();
const { t } = useI18n();
</script>

<template>
  <div
    aria-hidden="true"
    class="px-2 pt-2 pb-0.75 text-10.5 font-medium text-(--d-faint)"
  >
    {{ t(`chats.${group}`) }}
  </div>
</template>
