<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Pin } from 'lucide-vue-next';
import type { ChatMessage } from '@shared/types/session';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// The header's way back to the pinned prompt the user hid: it sits in the action row, so it covers no message.
const props = defineProps<{ message: ChatMessage }>();
const emit = defineEmits<{ restore: [] }>();
const { t } = useI18n();

const preview = computed(() => {
  const raw = (props.message.content ?? '').trim().replace(/\s+/g, ' ');
  return raw.length > 64 ? `${raw.slice(0, 64)}…` : raw;
});
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <button
        type="button"
        class="d-tool-btn relative w-7.5 px-0"
        :aria-label="t('userMessage.showPinnedAria')"
        data-testid="chat-header-pinned"
        @click="emit('restore')"
      >
        <Pin
          class="size-3.5 text-(--d-accent)"
          aria-hidden="true"
        />
        <span
          aria-hidden="true"
          class="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-(--d-warning) animate-[d-pulse_1.4s_infinite]"
        />
      </button>
    </TooltipTrigger>
    <TooltipContent
      side="bottom"
      data-testid="chat-header-pinned-tooltip"
    >
      <p class="font-medium">
        {{ t('userMessage.showPinnedTitle') }}
      </p>
      <p
        v-if="preview"
        class="mt-0.5 line-clamp-2 text-(--d-muted)"
      >
        {{ preview }}
      </p>
    </TooltipContent>
  </Tooltip>
</template>
