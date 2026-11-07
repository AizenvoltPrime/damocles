<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ListboxItem, ListboxRoot } from 'reka-ui';
import { GitCompareArrows } from 'lucide-vue-next';
import DockPromptOptions from '../DockPromptOptions.vue';
import DesignChangeList from './DesignChangeList.vue';
import { useDesignStore } from '@/stores/useDesignStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useDockPromptDigits } from '@/composables/useDockPrompt';
import { useAttentionCard } from '@/composables/useAttention';

type Choice = 'replan' | 'finishFirst';

// The version pause (PD-29): the design changed after the plan's approval, and the answer decides how the run starts.
const { t } = useI18n();
const store = useDesignStore();
const { postMessage } = usePlatformBridge();

const current = computed(() => store.versionPrompts[0]);
const cardRef = ref<HTMLElement | null>(null);
useAttentionCard('question', cardRef);

// An approval made before the design's first version recorded none, which core sends as version 0.
const approvedLine = computed(() => {
  const from = current.value?.fromVersion ?? 0;
  return from > 0 ? t('design.versionPrompt.approvedAgainst', { version: from }) : t('design.versionPrompt.approvedUnversioned');
});
const nowLine = computed(() => {
  const prompt = current.value;
  if (!prompt) return '';
  return t(prompt.changes.length > 0 ? 'design.versionPrompt.nowList' : 'design.versionPrompt.now', { version: prompt.toVersion });
});

// Each option names its prompt, so a leaving card's option, rendered for the prompt it showed, never answers the next one.
const choices = computed<{ value: Choice; label: string; promptId: string }[]>(() => {
  const prompt = current.value;
  if (!prompt) return [];
  const from = prompt.fromVersion;
  return [
    { value: 'replan', label: t('design.versionPrompt.replan'), promptId: prompt.promptId },
    { value: 'finishFirst', label: from > 0 ? t('design.versionPrompt.finishFirst', { version: from }) : t('design.versionPrompt.finishFirstUnversioned'), promptId: prompt.promptId },
  ];
});
const selected = ref<Choice>('replan');

function answer(promptId: string, choice: Choice): void {
  const prompt = current.value;
  if (!prompt || prompt.promptId !== promptId) return;
  postMessage({ type: 'resolveDesignVersionDecision', promptId: prompt.promptId, choice });
  store.removeVersionPrompt(prompt.promptId);
  selected.value = 'replan';
}

useDockPromptDigits(cardRef, (digit) => {
  const choice = choices.value[digit - 1];
  if (!choice) return false;
  answer(choice.promptId, choice.value);
  return true;
});
</script>

<template>
  <Transition
    name="t-up"
    mode="out-in"
  >
    <div
      v-if="current"
      :key="current.promptId"
      ref="cardRef"
      class="overflow-hidden rounded-[0.875rem] border border-[color-mix(in_srgb,var(--d-design)_45%,var(--d-border))] bg-(--d-card) text-(--d-text) shadow-(--d-shadow) [--attention-ring:var(--d-design)]"
      role="region"
      :aria-label="t('design.versionPrompt.title')"
      data-dock-prompt
      data-testid="design-version-card"
      :data-design-id="current.designId"
      :data-from-version="current.fromVersion"
      :data-to-version="current.toVersion"
    >
      <div class="flex items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-design)_12%,transparent)] to-transparent px-3 py-2">
        <span
          class="d-ring flex size-6.5 flex-none items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--d-design)_16%,transparent)] text-(--d-design)"
          aria-hidden="true"
        >
          <GitCompareArrows class="size-3.5" />
        </span>
        <div class="min-w-0 flex-1 font-semibold text-pretty">
          {{ t('design.versionPrompt.title') }}
        </div>
      </div>

      <div class="px-3.5 pt-2.5 pb-1 text-12.5">
        <p
          class="text-pretty text-(--d-muted)"
          data-testid="design-version-body"
        >
          {{ `${approvedLine} ${nowLine}` }}
        </p>
        <!-- Scrolls when long; focusable so a keyboard user can scroll it too. -->
        <div
          v-if="current.changes.length > 0"
          class="mt-1.5 max-h-30 overflow-y-auto rounded-md outline-none focus-visible:ring-1 focus-visible:ring-(--d-design)"
          role="region"
          :aria-label="t('design.versionPrompt.changes', { version: current.toVersion })"
          tabindex="0"
          data-testid="design-version-changes"
        >
          <DesignChangeList :changes="current.changes" />
        </div>
      </div>

      <div class="px-1.5 pt-1 pb-1.5">
        <ListboxRoot
          v-model="selected"
          class="flex flex-col outline-none"
          orientation="vertical"
        >
          <DockPromptOptions :aria-label="t('design.versionPrompt.title')">
            <ListboxItem
              v-for="(option, index) in choices"
              :key="option.value"
              :value="option.value"
              class="group flex items-center gap-2.5 rounded-9 px-2.5 py-1.25 transition-colors outline-none data-highlighted:bg-[color-mix(in_srgb,var(--d-design)_14%,transparent)] data-highlighted:text-(--d-design-text)"
              :data-testid="`design-version-${option.value}`"
              @select="answer(option.promptId, option.value)"
            >
              <span
                class="flex size-5 flex-none items-center justify-center rounded-md border border-(--d-border2) font-mono text-11 group-data-highlighted:border-(--d-design)"
                aria-hidden="true"
              >{{ index + 1 }}</span>
              <span class="min-w-0 flex-1 truncate font-medium">{{ option.label }}</span>
            </ListboxItem>
          </DockPromptOptions>
        </ListboxRoot>
      </div>
    </div>
  </Transition>
</template>
