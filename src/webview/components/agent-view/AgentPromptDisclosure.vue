<script setup lang="ts">
import { shallowRef, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight } from 'lucide-vue-next';
import MarkdownRenderer from '../MarkdownRenderer.vue';

/** The task an agent was given (Chat Panel.dc.html `av.prompt`): a one-line peek that opens to the full text. */
defineProps<{
  prompt: string;
  from: string;
}>();

const { t } = useI18n();
const open = shallowRef(false);
const bodyId = useId();
</script>

<template>
  <div
    class="overflow-hidden rounded-10 border border-(--d-border) bg-(--d-card)"
    data-testid="agent-prompt"
  >
    <button
      type="button"
      class="flex h-8.5 w-full min-w-0 items-center gap-2 px-3 text-left text-xs transition-colors hover:bg-(--d-hover)"
      :aria-expanded="open"
      :aria-controls="bodyId"
      @click="open = !open"
    >
      <ChevronRight
        class="size-3.25 flex-none text-(--d-muted) transition-transform duration-200"
        :class="open && 'rotate-90'"
        aria-hidden="true"
      />
      <span class="flex-none font-semibold text-(--d-muted)">{{ t('overlays.agent.prompt') }}</span>
      <span class="flex-none whitespace-nowrap text-(--d-faint)">{{ t('overlays.agent.promptFrom', { from }) }}</span>
      <span
        class="min-w-0 flex-1 truncate text-(--d-faint) transition-opacity duration-200"
        :class="open ? 'opacity-0' : 'opacity-100'"
        aria-hidden="true"
      >{{ prompt }}</span>
    </button>
    <Transition name="t-fade">
      <div
        v-if="open"
        :id="bodyId"
        class="pt-0 pr-3.5 pb-3 pl-8.25 text-12.5 text-(--d-muted)"
      >
        <MarkdownRenderer :content="prompt" />
      </div>
    </Transition>
  </div>
</template>
