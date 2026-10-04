<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Pin } from 'lucide-vue-next';
import type { ChatMessage } from '@shared/types/session';

const props = defineProps<{
  message: ChatMessage;
}>();

const emit = defineEmits<{
  (e: 'restore'): void;
}>();

const { t } = useI18n();
const hovered = ref(false);

const preview = computed(() => {
  const raw = (props.message.content ?? '').trim().replace(/\s+/g, ' ');
  return raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;
});

const expanded = computed(() => hovered.value && preview.value.length > 0);
</script>

<template>
  <button
    type="button"
    class="flex h-7 items-center gap-1.75 overflow-hidden rounded-full border border-(--d-border2) bg-(--d-card) whitespace-nowrap text-(--d-text) shadow-(--d-shadow) transition-[max-width,padding,background-color] duration-200 ease-out hover:bg-(--d-hover) focus-visible:outline-2 focus-visible:outline-(--d-accent)"
    :class="expanded ? 'max-w-65 px-2.5' : 'max-w-7 px-1.75'"
    :aria-label="t('userMessage.showPinnedAria')"
    :title="t('userMessage.showPinnedTitle')"
    data-testid="pinned-restore-chip"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focus="hovered = true"
    @blur="hovered = false"
    @click="emit('restore')"
  >
    <span class="relative flex flex-none">
      <Pin
        class="size-3 text-(--d-accent)"
        aria-hidden="true"
      />
      <span
        aria-hidden="true"
        class="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-(--d-warning) animate-[d-pulse_1.4s_infinite]"
      />
    </span>
    <span
      v-if="preview"
      class="min-w-0 truncate text-xs text-(--d-muted) transition-opacity duration-150"
      :class="expanded ? 'opacity-100' : 'opacity-0'"
    >{{ preview }}</span>
  </button>
</template>
