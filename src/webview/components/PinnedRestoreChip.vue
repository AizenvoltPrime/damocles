<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatMessage } from '@shared/types/session';
import { IconPin } from '@/components/icons';

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
    class="group flex items-center gap-1.5 h-7 rounded-full border border-border bg-muted/95 text-foreground shadow-md overflow-hidden whitespace-nowrap cursor-pointer hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-all motion-safe:duration-200"
    :class="expanded ? 'px-2.5 max-w-[240px]' : 'px-1.5 max-w-[28px]'"
    :aria-label="t('userMessage.showPinnedAria')"
    :title="t('userMessage.showPinnedTitle')"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focus="hovered = true"
    @blur="hovered = false"
    @click="emit('restore')"
  >
    <span class="relative flex items-center shrink-0">
      <IconPin :size="12" class="text-primary" />
      <span
        aria-hidden="true"
        class="absolute -top-0.5 -right-1 h-1.5 w-1.5 rounded-full bg-warning motion-safe:animate-pulse"
      />
    </span>
    <span
      v-if="preview"
      class="text-xs text-muted-foreground overflow-hidden text-ellipsis motion-safe:transition-opacity motion-safe:duration-150"
      :class="expanded ? 'opacity-100' : 'opacity-0'"
    >
      {{ preview }}
    </span>
  </button>
</template>
