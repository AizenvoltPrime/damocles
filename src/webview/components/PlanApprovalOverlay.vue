<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { IconSparkles, IconCheck, IconPencil, IconPaperPlane, IconBolt } from '@/components/icons';
import MarkdownRenderer from './MarkdownRenderer.vue';
import OverlayShell from './OverlayShell.vue';
import { useSessionStore, useSettingsStore } from '@/stores';
import { useContextPercentage } from '@/composables/useContextPercentage';
import { contextWarningBands } from '@/utils/contextBands';

const { t } = useI18n();
const { sessionStats } = storeToRefs(useSessionStore());
const { currentSettings } = storeToRefs(useSettingsStore());

const { totalContext, contextPercentage } = useContextPercentage(sessionStats);

const contextBadgeStyle = computed(() => {
  const { hard, soft, warning } = contextWarningBands(currentSettings.value.autoCompact.triggerPercent);
  if (contextPercentage.value >= hard) return 'bg-rose-500/15 text-rose-400';
  if (contextPercentage.value >= soft) return 'bg-orange-500/15 text-[var(--color-orange)]';
  if (contextPercentage.value >= warning) return 'bg-amber-500/15 text-amber-400';
  return 'bg-emerald-500/15 text-emerald-400';
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
    :icon="IconSparkles"
    icon-class="text-primary"
    @close="emit('dismiss')"
  >
    <template #header-actions>
      <Badge variant="secondary" class="gap-1 tabular-nums shrink-0" :class="contextBadgeStyle" :title="contextTooltip">
        <svg class="w-3 h-3" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="6" cy="6" r="5" fill="currentColor" />
        </svg>
        {{ contextPercentage }}%
      </Badge>
    </template>

    <div class="p-4">
      <MarkdownRenderer :content="planContent" />
    </div>

    <template #footer>
      <footer class="shrink-0 border-t border-border/30 bg-muted p-4 space-y-3">
        <Textarea
          v-model="feedbackText"
          :placeholder="t('planApproval.feedbackPlaceholder')"
          class="resize-none max-h-32"
          @keydown.enter.ctrl="handleSendFeedback"
        />
        <div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="!canSubmitFeedback" @click="handleSendFeedback">
            <IconPaperPlane :size="16" class="mr-2" />
            {{ t('planApproval.sendFeedback') }}
          </Button>
          <Button variant="outline" @click="emit('approve', { approvalMode: 'manual' })">
            <IconPencil :size="16" class="mr-2" />
            {{ t('planApproval.manualApprove') }}
          </Button>
          <Button variant="outline" @click="emit('approve', { approvalMode: 'acceptEdits' })">
            <IconCheck :size="16" class="mr-2" />
            {{ t('planApproval.autoAccept') }}
          </Button>
          <Button @click="emit('approve', { approvalMode: 'acceptEdits', clearContext: true })">
            <IconBolt :size="16" class="mr-2" />
            {{ t('planApproval.clearContextAndAccept') }}
          </Button>
        </div>
      </footer>
    </template>
  </OverlayShell>
</template>
