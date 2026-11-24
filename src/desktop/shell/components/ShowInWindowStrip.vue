<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Eye, Square } from 'lucide-vue-next';
import type { ThemeProposalStrip } from '@shared/themes/agent';
import { Button } from '@/components/ui/button';
import TrustedCheckingNote from '@/components/TrustedCheckingNote.vue';
import { IsolatedText } from '@/components/isolated-text';
import { isolated } from '@shared/bidi-isolate';
import { useTrustedVisibility } from '@/composables/useTrustedVisibility';

// While a chat card's Show in window paints the agent's proposal on the window: trusted UI, so the way out stays readable.
defineProps<{ proposal: ThemeProposalStrip }>();
const emit = defineEmits<{ (e: 'stop'): void }>();

const { t } = useI18n();
const stripRef = ref<HTMLElement | null>(null);
const { isVisible, explain } = useTrustedVisibility(stripRef, true);
</script>

<template>
  <div
    ref="stripRef"
    role="region"
    aria-labelledby="show-in-window-title"
    data-trusted
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color-mix(in_srgb,var(--d-design-fill)_45%,var(--d-border))] bg-(--d-card) py-2 ps-4 pe-3 text-12 text-(--d-text)"
    data-testid="show-in-window-strip"
    :data-prompt-id="proposal.promptId"
  >
    <span
      class="flex size-6.5 flex-none items-center justify-center rounded-8 bg-[color-mix(in_srgb,var(--d-design-fill)_16%,transparent)] text-(--d-design-text)"
      aria-hidden="true"
    >
      <Eye class="size-4" />
    </span>
    <!-- The text scrolls inside its own bounded box, so the strip fits the window whole however long a chat's title is. -->
    <div class="relative min-w-0 flex-[1_1_16rem]">
      <p class="max-h-18 overflow-y-auto text-pretty">
        <strong
          id="show-in-window-title"
          class="font-semibold"
        >{{ t('themes.proposal.title') }}</strong>
        {{ ' ' }}
        <span class="text-(--d-muted)"><IsolatedText :text="proposal.chatTitle ? t('themes.proposal.body', { chat: isolated(proposal.chatTitle) }) : t('themes.proposal.bodyUntitled')" /></span>
      </p>
      <TrustedCheckingNote
        cover
        :shown="explain"
        :text="t('themes.checkingVisible')"
      />
    </div>
    <Button
      type="button"
      variant="outline"
      size="sm"
      class="h-7 gap-1.5 rounded-8 border-(--d-border2) bg-transparent px-3 text-12 aria-disabled:text-(--d-muted) aria-disabled:hover:bg-transparent [&_svg]:size-3"
      data-testid="show-in-window-stop"
      :aria-disabled="!isVisible || undefined"
      @click="emit('stop')"
    >
      <Square aria-hidden="true" />{{ t('themes.proposal.stop') }}
    </Button>
  </div>
</template>
