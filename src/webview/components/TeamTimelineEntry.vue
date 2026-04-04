<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TeamMessage, TeamAgent } from '@shared/types/team';
import { getAgentColor } from '@/composables/useTeamFormatting';
import MarkdownRenderer from './MarkdownRenderer.vue';

const { t } = useI18n();

const props = defineProps<{
  message: TeamMessage;
  agents: TeamAgent[];
}>();

const senderIndex = computed(() =>
  props.agents.findIndex(a => a.name === props.message.senderName)
);

const color = computed(() => getAgentColor(senderIndex.value));

const formattedTime = computed(() => {
  const d = new Date(props.message.timestamp);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
});

const recipientLabel = computed(() =>
  props.message.recipientName
    ? t('team.timelineEntry.toAgent', { name: props.message.recipientName })
    : t('team.timelineEntry.toAll')
);
</script>

<template>
  <div class="flex gap-2 py-1.5">
    <div class="flex flex-col items-center pt-1.5">
      <div class="w-2 h-2 rounded-full shrink-0" :class="color.dot" />
      <div class="w-px flex-1 bg-border/30 mt-1" />
    </div>
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-1.5 text-xs">
        <span class="font-medium" :class="color.text">{{ message.senderName }}</span>
        <span class="text-foreground/40">{{ recipientLabel }}</span>
        <span class="text-foreground/30 ml-auto shrink-0">{{ formattedTime }}</span>
      </div>
      <div
        class="mt-1 pl-2 border-l-2 text-xs text-foreground/80 [&_.markdown-p]:my-1"
        :class="color.border"
      >
        <MarkdownRenderer :content="message.content" />
      </div>
    </div>
  </div>
</template>
