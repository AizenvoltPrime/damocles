<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Ban, CircleCheck, CircleX, Compass, MessageSquare } from 'lucide-vue-next';
import type { ToolCall } from '@shared/types/session';
import ToolCardFrame from './ToolCardFrame.vue';
import ToolCardNote from './ToolCardNote.vue';

const { t } = useI18n();

const props = defineProps<{
  toolCall: ToolCall;
}>();

const status = computed(() => props.toolCall.status);

const headerText = computed(() => {
  if (status.value === 'completed') return t('planModeTool.entered');
  if (status.value === 'denied') return t('planModeTool.declined');
  if (status.value === 'abandoned') return t('planModeTool.skipped');
  return t('planModeTool.enterPlanMode');
});
</script>

<template>
  <ToolCardFrame
    :icon="Compass"
    :name="headerText"
    :status="toolCall.status"
    data-testid="enter-plan-tool-card"
  >
    <ToolCardNote
      v-if="status === 'awaiting_approval'"
      tone="text-(--d-warning)"
      waiting
      :text="t('planModeTool.waitingApproval')"
    />
    <ToolCardNote
      v-else-if="status === 'completed'"
      tone="text-(--d-success)"
      :icon="CircleCheck"
      :text="t('planModeTool.nowExploring')"
    />
    <ToolCardNote
      v-else-if="status === 'denied'"
      tone="text-(--d-danger)"
      :icon="toolCall.feedback ? MessageSquare : CircleX"
      :text="toolCall.feedback ? t('planModeTool.feedbackSent') : t('planModeTool.implementDirectly')"
      :quote="toolCall.feedback"
    />
    <ToolCardNote
      v-else-if="status === 'abandoned'"
      tone="text-(--d-muted)"
      :icon="Ban"
      :text="t('planModeTool.requestSkipped')"
    />
  </ToolCardFrame>
</template>
