<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { ClipboardList, Check, Pencil, SendHorizontal, Zap } from 'lucide-vue-next';
import MarkdownRenderer from './MarkdownRenderer.vue';
import OverlayShell from './OverlayShell.vue';
import { useSessionStore, useSettingsStore } from '@/stores';
import { useContextPercentage } from '@/composables/useContextPercentage';
import { contextWarningBands } from '@/utils/contextBands';

const { t } = useI18n();
const { sessionStats } = storeToRefs(useSessionStore());
const { currentSettings } = storeToRefs(useSettingsStore());

const { contextPercentage } = useContextPercentage(sessionStats);

const contextBadgeStyle = computed(() => {
  const { hard, soft, warning } = contextWarningBands(currentSettings.value.autoCompact.triggerPercent);
  if (contextPercentage.value >= hard) return 'bg-[color-mix(in_srgb,var(--d-danger)_14%,transparent)] text-(--d-danger-text)';
  if (contextPercentage.value >= soft) return 'bg-[color-mix(in_srgb,var(--d-warning)_15%,transparent)] text-(--d-warning-text)';
  if (contextPercentage.value >= warning) return 'bg-[color-mix(in_srgb,var(--d-warning)_15%,transparent)] text-(--d-warning-text)';
  return 'bg-[color-mix(in_srgb,var(--d-success)_15%,transparent)] text-(--d-success-text)';
});

const contextTooltip = computed(() => {
  const { hard, soft, warning } = contextWarningBands(currentSettings.value.autoCompact.triggerPercent);
  const base = t('stats.contextUsage');
  if (contextPercentage.value >= hard) return `${base} - ${t('context.critical')}`;
  if (contextPercentage.value >= soft) return `${base} - ${t('context.soft')}`;
  if (contextPercentage.value >= warning) return `${base} - ${t('context.warning')}`;
  return base;
});

defineProps<{
  planContent: string;
}>();

const emit = defineEmits<{
  (e: 'approve', options: { approvalMode: 'acceptEdits' | 'manual'; clearContext?: boolean }): void;
  (e: 'feedback', text: string): void;
  (e: 'dismiss'): void;
}>();

const feedbackText = ref('');
const canSubmitFeedback = computed(() => feedbackText.value.trim().length > 0);

function handleSendFeedback() {
  if (canSubmitFeedback.value) {
    emit('feedback', feedbackText.value.trim());
  }
}
</script>

<template>
  <OverlayShell
    :title="t('planApproval.readyToCode')"
    :subtitle="t('planApproval.reviewPlan')"
    :icon="ClipboardList"
    icon-class="text-(--d-accent)"
    max-width="53.75rem"
    :has-draft="canSubmitFeedback"
    @close="emit('dismiss')"
  >
    <template #header-actions>
      <span
        class="flex flex-none items-center gap-1 rounded-full px-2 font-mono text-11/5 tabular-nums"
        :class="contextBadgeStyle"
        :title="contextTooltip"
      >
        <span
          class="size-1.5 rounded-full bg-current"
          aria-hidden="true"
        />{{ contextPercentage }}%
      </span>
    </template>

    <div class="px-4.5 pt-4 pb-5">
      <MarkdownRenderer :content="planContent" />
    </div>

    <template #footer>
      <footer class="flex flex-none flex-col gap-2.5 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-3">
        <label
          class="sr-only"
          for="plan-feedback"
        >{{ t('planApproval.sendFeedback') }}</label>
        <textarea
          id="plan-feedback"
          v-model="feedbackText"
          rows="2"
          class="max-h-30 resize-none rounded-10 border border-(--d-border2) bg-(--d-input) px-3 py-2.25 text-12.5 text-(--d-text) outline-none placeholder:text-(--d-faint) focus:border-(--d-accent)"
          :placeholder="t('planApproval.feedbackPlaceholder')"
          data-testid="plan-feedback"
          @keydown.enter.ctrl.prevent="handleSendFeedback"
          @keydown.enter.meta.prevent="handleSendFeedback"
        />
        <div class="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            class="d-press flex h-8 items-center gap-1.75 rounded-9 border border-(--d-border2) px-3 text-12.5 whitespace-nowrap transition-colors hover:bg-(--d-hover) disabled:cursor-default disabled:opacity-40"
            :disabled="!canSubmitFeedback"
            @click="handleSendFeedback"
          >
            <SendHorizontal
              class="size-3.5"
              aria-hidden="true"
            />{{ t('planApproval.sendFeedback') }}
          </button>
          <button
            type="button"
            class="d-press flex h-8 items-center gap-1.75 rounded-9 border border-(--d-border2) px-3 text-12.5 whitespace-nowrap transition-colors hover:bg-(--d-hover)"
            @click="emit('approve', { approvalMode: 'manual' })"
          >
            <Pencil
              class="size-3.5"
              aria-hidden="true"
            />{{ t('planApproval.manualApprove') }}
          </button>
          <button
            type="button"
            class="d-press flex h-8 items-center gap-1.75 rounded-9 border border-(--d-border2) px-3 text-12.5 whitespace-nowrap transition-colors hover:bg-(--d-hover)"
            @click="emit('approve', { approvalMode: 'acceptEdits' })"
          >
            <Check
              class="size-3.5"
              aria-hidden="true"
            />{{ t('planApproval.autoAccept') }}
          </button>
          <button
            type="button"
            class="d-press flex h-8 items-center gap-1.75 rounded-9 bg-(--d-accent) px-3 text-12.5 font-semibold whitespace-nowrap text-(--d-on-accent) transition-[filter] hover:brightness-110"
            @click="emit('approve', { approvalMode: 'acceptEdits', clearContext: true })"
          >
            <Zap
              class="size-3.5"
              aria-hidden="true"
            />{{ t('planApproval.clearContextAndAccept') }}
          </button>
        </div>
      </footer>
    </template>
  </OverlayShell>
</template>
