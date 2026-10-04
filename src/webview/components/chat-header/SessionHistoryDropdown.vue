<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { History } from 'lucide-vue-next';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import SessionPicker from '@/components/SessionPicker.vue';
import type { StoredSession } from '@shared/types/session';
import { remPx } from '@/composables/useRemPx';

defineProps<{
  sessions: StoredSession[];
  selectedSessionId: string | null;
  selectedSessionName: string | null;
  hasMore: boolean;
  loading: boolean;
}>();

const emit = defineEmits<{
  select: [sessionId: string];
  rename: [sessionId: string, newName: string];
  delete: [sessionId: string];
  tag: [sessionId: string, tag: string | null];
  loadMore: [];
  search: [query: string, offset?: number];
  open: [];
}>();

const { t } = useI18n();
const open = ref(false);
const pickerRef = ref<InstanceType<typeof SessionPicker> | null>(null);

// Escape inside a rename or tag field cancels that edit; the dropdown stays open.
function onEscape(event: KeyboardEvent): void {
  if (pickerRef.value?.isInEditMode) event.preventDefault();
}

function onSelect(sessionId: string): void {
  emit('select', sessionId);
  open.value = false;
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger
      class="d-tool-btn w-7.5 px-0"
      :title="t('chatHeader.history')"
      :aria-label="t('chatHeader.history')"
      data-testid="chat-header-history"
    >
      <History
        class="size-3.75"
        aria-hidden="true"
      />
    </PopoverTrigger>
    <PopoverContent
      side="bottom"
      align="end"
      :side-offset="remPx(0.375)"
      class="w-[min(20rem,calc(100vw-1rem))] rounded-xl border-(--d-border2) bg-(--d-card) p-1.5 text-(--d-text) shadow-(--d-shadow)"
      @escape-key-down="onEscape"
    >
      <SessionPicker
        ref="pickerRef"
        :sessions="sessions"
        :selected-session-id="selectedSessionId"
        :selected-session-name="selectedSessionName"
        :has-more="hasMore"
        :loading="loading"
        @select="onSelect"
        @rename="(id: string, name: string) => emit('rename', id, name)"
        @delete="(id: string) => emit('delete', id)"
        @tag="(id: string, tag: string | null) => emit('tag', id, tag)"
        @load-more="emit('loadMore')"
        @search="(query: string, offset?: number) => emit('search', query, offset)"
        @open="emit('open')"
        @close="open = false"
      />
    </PopoverContent>
  </Popover>
</template>
