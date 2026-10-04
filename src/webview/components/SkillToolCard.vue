<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Ban, CircleCheck, CircleX, MessageSquare, Sparkles } from 'lucide-vue-next';
import type { ToolCall } from '@shared/types/session';
import ToolCardFrame from './ToolCardFrame.vue';
import ToolCardNote from './ToolCardNote.vue';

const { t } = useI18n();

const props = defineProps<{
  toolCall: ToolCall;
}>();

const skillName = computed(() => {
  const input = props.toolCall.input;
  return typeof input?.skill === 'string' ? input.skill : t('skillTool.unknownSkill');
});

const skillDescription = computed(() => {
  const metadata = props.toolCall.metadata;
  return typeof metadata?.skillDescription === 'string' ? metadata.skillDescription : undefined;
});

const status = computed(() => props.toolCall.status);

const headerText = computed(() => {
  if (status.value === 'completed') return t('skillTool.executed', { name: skillName.value });
  if (status.value === 'denied') return t('skillTool.denied', { name: skillName.value });
  if (status.value === 'abandoned') return t('skillTool.skipped', { name: skillName.value });
  return t('skillTool.useSkill', { name: skillName.value });
});
</script>

<template>
  <ToolCardFrame
    :icon="Sparkles"
    :name="headerText"
    :status="toolCall.status"
    data-testid="skill-tool-card"
  >
    <p
      v-if="skillDescription"
      class="border-t border-(--d-border) px-3 py-2 text-xs text-(--d-muted) text-pretty"
    >
      {{ skillDescription }}
    </p>
    <ToolCardNote
      v-if="status === 'awaiting_approval'"
      tone="text-(--d-warning)"
      waiting
      :text="t('skillTool.waitingApproval')"
    />
    <ToolCardNote
      v-else-if="status === 'completed'"
      tone="text-(--d-success)"
      :icon="CircleCheck"
      :text="t('skillTool.executedSuccess')"
    />
    <ToolCardNote
      v-else-if="status === 'denied'"
      tone="text-(--d-danger)"
      :icon="toolCall.feedback ? MessageSquare : CircleX"
      :text="toolCall.feedback ? t('skillTool.feedbackSent') : t('skillTool.userDenied')"
      :quote="toolCall.feedback"
    />
    <ToolCardNote
      v-else-if="status === 'abandoned'"
      tone="text-(--d-muted)"
      :icon="Ban"
      :text="t('skillTool.requestSkipped')"
    />
  </ToolCardFrame>
</template>
