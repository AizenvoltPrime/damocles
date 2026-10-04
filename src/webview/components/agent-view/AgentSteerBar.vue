<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Send } from 'lucide-vue-next';

/** The footer of a live agent overlay (Chat Panel.dc.html `ovSteer`): a note delivered before the agent's next step. */
defineProps<{
  placeholder: string;
  sending: boolean;
  failed: boolean;
  canSend: boolean;
}>();

const text = defineModel<string>({ required: true });

const emit = defineEmits<{
  (e: 'send'): void;
}>();

const { t } = useI18n();

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  emit('send');
}
</script>

<template>
  <div
    class="flex flex-none flex-col gap-1.5 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5"
    data-testid="agent-steer-bar"
  >
    <div class="flex items-center gap-2">
      <label class="flex h-8.5 min-w-0 flex-1 items-center gap-2 rounded-10 border border-(--d-border2) bg-(--d-input) px-3 focus-within:border-(--d-accent)">
        <Send
          class="size-3.25 flex-none text-(--d-warning)"
          aria-hidden="true"
        />
        <input
          v-model="text"
          type="text"
          class="min-w-0 flex-1 bg-transparent text-12.5 text-(--d-text) outline-none placeholder:text-(--d-faint)"
          :placeholder="placeholder"
          :aria-label="placeholder"
          :readonly="sending"
          data-testid="agent-steer-input"
          @keydown="onKeydown"
        >
      </label>
      <button
        type="button"
        class="d-press flex h-8.5 flex-none items-center gap-1.5 rounded-10 px-3.5 text-12.5 font-semibold transition-colors"
        :class="canSend ? 'bg-(--d-warning) text-(--d-on-warning)' : 'bg-(--d-hover) text-(--d-faint)'"
        :disabled="!canSend"
        :aria-busy="sending || undefined"
        data-testid="agent-steer-send"
        @click="emit('send')"
      >
        {{ t('overlays.agent.steer') }}
      </button>
    </div>
    <p
      v-if="failed"
      class="text-11.5 text-(--d-danger)"
      role="status"
    >
      {{ t('overlays.agent.steerFailed') }}
    </p>
  </div>
</template>
