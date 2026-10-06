<script setup lang="ts">
import { ref, nextTick, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ListboxRoot, ListboxItem } from 'reka-ui';
import DockPromptOptions from './DockPromptOptions.vue';
import { Textarea } from '@/components/ui/textarea';
import { MessageSquare, SendHorizontal, Sparkles } from 'lucide-vue-next';
import { useDockPromptDigits } from '@/composables/useDockPrompt';
import { useAttentionCard } from '@/composables/useAttention';

const { t } = useI18n();

defineProps<{
  visible: boolean;
  skillName: string;
  skillDescription?: string | undefined;
}>();

const emit = defineEmits<{
  (e: 'approve', approved: boolean, options?: { approvalMode?: 'acceptEdits' | 'manual'; customMessage?: string }): void;
}>();

const showCustomInput = ref(false);
const customMessage = ref('');
const selectedValue = ref<string>('yes');
const cardRef = ref<HTMLElement | null>(null);
useAttentionCard('approval', cardRef);
const textareaRef = ref<{ $el?: HTMLElement } | null>(null);

const choices = computed(() => [
  { value: 'yes', label: t('skill.options.yes') },
  { value: 'yes-always', label: t('skill.options.yesDontAsk') },
  { value: 'no', label: t('skill.options.no') },
] as const);

function handleSelect(value: string) {
  switch (value) {
    case 'yes':
      emit('approve', true, { approvalMode: 'manual' });
      resetState();
      break;
    case 'yes-always':
      emit('approve', true, { approvalMode: 'acceptEdits' });
      resetState();
      break;
    case 'no':
      emit('approve', false);
      resetState();
      break;
    case 'custom':
      showCustomInput.value = true;
      nextTick(() => {
        textareaRef.value?.$el?.focus();
      });
      break;
  }
}

function handleCustomSubmit() {
  if (customMessage.value.trim()) {
    emit('approve', false, { customMessage: customMessage.value.trim() });
    resetState();
  }
}

function handleCustomBack() {
  showCustomInput.value = false;
  customMessage.value = '';
}

function resetState() {
  showCustomInput.value = false;
  customMessage.value = '';
  selectedValue.value = 'yes';
}

useDockPromptDigits(cardRef, (digit) => {
  const choice = showCustomInput.value ? undefined : choices.value[digit - 1];
  if (!choice) return false;
  handleSelect(choice.value);
  return true;
});
</script>

<template>
  <div
    v-if="visible"
    ref="cardRef"
    class="overflow-hidden rounded-[0.875rem] border border-[color-mix(in_srgb,var(--d-warning)_45%,transparent)] bg-(--d-card) text-(--d-text) shadow-(--d-shadow) [--attention-ring:var(--d-warning)]"
    role="region"
    :aria-label="t('skill.ariaLabel')"
    data-dock-prompt
    data-testid="skill-card"
  >
    <header class="flex items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-warning)_10%,transparent)] to-transparent px-3 py-2">
      <span
        class="d-ring flex size-6.5 flex-none items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--d-warning)_16%,transparent)] text-(--d-warning)"
        aria-hidden="true"
      >
        <Sparkles class="size-3.5" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="truncate font-semibold">
          {{ t('skill.title', { name: skillName }) }}
        </div>
        <div class="truncate text-xs text-(--d-muted)">
          {{ t('skill.explanation') }}
        </div>
      </div>
    </header>

    <p
      v-if="skillDescription"
      class="px-3.5 pt-2.5 text-12.5 text-pretty text-(--d-muted)"
    >
      {{ skillDescription }}
    </p>

    <div
      v-if="!showCustomInput"
      class="px-1.5 pt-1 pb-1.5"
    >
      <ListboxRoot
        v-model="selectedValue"
        class="flex flex-col outline-none"
        orientation="vertical"
      >
        <DockPromptOptions :aria-label="t('skill.title', { name: skillName })">
          <ListboxItem
            v-for="(option, index) in choices"
            :key="option.value"
            :value="option.value"
            class="group flex items-center gap-2.5 rounded-9 px-2.5 py-1.25 transition-colors outline-none data-highlighted:bg-(--d-accent-soft) data-highlighted:text-(--d-accent-text)"
            @select="handleSelect(option.value)"
          >
            <span
              class="flex size-5 flex-none items-center justify-center rounded-md border border-(--d-border2) font-mono text-11 group-data-highlighted:border-(--d-accent)"
              aria-hidden="true"
            >{{ index + 1 }}</span>
            <span class="min-w-0 flex-1 truncate font-medium">{{ option.label }}</span>
          </ListboxItem>
          <ListboxItem
            value="custom"
            class="mx-1 mt-0.75 flex h-7.5 items-center gap-2 rounded-9 border border-(--d-border) bg-(--d-input) px-2.5 text-12.5 text-(--d-faint) transition-colors outline-none data-highlighted:border-(--d-accent)"
            @select="handleSelect('custom')"
          >
            <MessageSquare
              class="size-3.25 flex-none"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 truncate">{{ t('skill.options.custom') }}</span>
          </ListboxItem>
        </DockPromptOptions>
      </ListboxRoot>
    </div>

    <div
      v-else
      class="flex flex-col gap-2 px-3 pt-2.5 pb-3"
    >
      <Textarea
        ref="textareaRef"
        v-model="customMessage"
        class="max-h-32 min-h-20 resize-none rounded-10 border-(--d-border2) bg-(--d-input) text-12.5 focus:border-(--d-accent)"
        :placeholder="t('skill.customPlaceholder')"
        @keydown.enter.ctrl="handleCustomSubmit"
        @keydown.escape="handleCustomBack"
      />
      <div class="flex justify-end gap-2">
        <button
          type="button"
          class="d-press flex h-7.5 items-center rounded-9 px-3 text-12.5 transition-colors hover:bg-(--d-hover)"
          @click="handleCustomBack"
        >
          {{ t('common.back') }}
        </button>
        <button
          type="button"
          class="d-press flex h-7.5 items-center gap-1.5 rounded-9 bg-(--d-accent) px-3.5 text-12.5 font-semibold text-(--d-on-accent) transition-[filter] hover:brightness-110 disabled:cursor-default disabled:opacity-40 disabled:hover:brightness-100"
          :disabled="!customMessage.trim()"
          @click="handleCustomSubmit"
        >
          <SendHorizontal
            class="size-3.25"
            aria-hidden="true"
          />
          {{ t('permission.sendToClaude') }}
        </button>
      </div>
    </div>
  </div>
</template>
