<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Ban, MessageSquare, MessagesSquare, SendHorizontal } from 'lucide-vue-next';
import type { BtwAside } from '@/stores/useBtwStore';
import { useBtwAsk } from '@/composables/useBtwAsk';
import LoadingSpinner from './LoadingSpinner.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import OverlayShell from './OverlayShell.vue';

const props = defineProps<{
  aside: BtwAside;
}>();
const { t } = useI18n();
const askBtw = useBtwAsk();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'dismiss'): void;
}>();

const followUp = ref('');

const statusBadge = computed(() => {
  if (props.aside.error) return { label: t('common.error'), class: 'd-tone-danger', icon: Ban };
  if (props.aside.isStreaming) return { label: t('btw.streaming'), class: 'd-tone-accent', showSpinner: true };
  return undefined;
});

function ask(): void {
  const question = followUp.value.trim();
  if (!question) return;
  askBtw(question);
  followUp.value = '';
}
</script>

<template>
  <OverlayShell
    :title="t('btw.title')"
    :subtitle="t('btw.subtitle')"
    :icon="MessagesSquare"
    icon-class="text-(--d-info)"
    :status-badge="statusBadge"
    max-width="47.5rem"
    :follow-key="aside.id"
    :has-draft="followUp.trim() !== ''"
    @close="emit('close')"
  >
    <template #header-actions>
      <button
        type="button"
        class="flex h-7.5 flex-none items-center rounded-9 border border-(--d-border2) px-3 text-xs font-medium text-(--d-danger) transition-colors hover:bg-(--d-hover) hover:text-(--d-danger-text)"
        @click="emit('dismiss')"
      >
        {{ t('common.dismiss') }}
      </button>
    </template>

    <div class="space-y-4 px-4.5 pt-4 pb-5">
      <div class="rounded-r-lg border-l-2 border-(--d-border2) bg-(--d-card) px-3 py-2">
        <p class="text-13 text-(--d-muted) italic">
          {{ aside.question }}
        </p>
      </div>

      <div
        v-if="aside.error"
        class="px-1 text-13 text-(--d-danger)"
      >
        {{ aside.error }}
      </div>
      <div
        v-else-if="aside.text"
        class="px-1"
      >
        <MarkdownRenderer :content="aside.text" />
      </div>
      <div
        v-else-if="aside.isStreaming"
        class="flex items-center gap-2 px-1 py-4 text-13 text-(--d-muted)"
      >
        <LoadingSpinner class="size-3.5" />
        <span>{{ t('btw.thinking') }}</span>
      </div>
    </div>

    <template #footer>
      <form
        class="flex flex-none items-center gap-2 border-t border-(--d-border) px-3.5 py-3"
        @submit.prevent="ask"
      >
        <label class="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-10 border border-(--d-border) bg-(--d-input) px-3 focus-within:border-(--d-accent)">
          <MessageSquare
            class="size-3.5 flex-none text-(--d-faint)"
            aria-hidden="true"
          />
          <span class="sr-only">{{ t('overlays.btw.ask') }}</span>
          <input
            v-model="followUp"
            type="text"
            class="min-w-0 flex-1 border-0 bg-transparent text-13 text-(--d-text) outline-none placeholder:text-(--d-faint)"
            :placeholder="t('overlays.btw.placeholder')"
            data-testid="btw-follow-up"
          >
        </label>
        <button
          type="submit"
          class="d-press flex size-9 flex-none items-center justify-center rounded-10 bg-(--d-accent) text-(--d-on-accent) transition-opacity disabled:opacity-40"
          :disabled="!followUp.trim()"
          :aria-label="t('overlays.btw.ask')"
        >
          <SendHorizontal
            class="size-3.75"
            aria-hidden="true"
          />
        </button>
      </form>
    </template>
  </OverlayShell>
</template>
