<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TeamMessage, TeamAgent } from '@shared/types/team';
import { getAgentColor } from '@/composables/useTeamFormatting';
import { formatClock } from '@/utils/clock';
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

const formattedTime = computed(() => formatClock(props.message.timestamp, undefined, { seconds: true }));

const recipientLabel = computed(() =>
  props.message.recipientName
    ? t('team.timelineEntry.toAgent', { name: props.message.recipientName })
    : t('team.timelineEntry.toAll')
);
</script>

<template>
  <div
    class="d-arrive grid grid-cols-[0.875rem_minmax(0,1fr)] gap-2.5"
    data-testid="team-timeline-entry"
  >
    <div class="flex flex-col items-center pt-1.5">
      <span
        class="size-2 flex-none rounded-full"
        :class="color.dot"
        aria-hidden="true"
      />
      <span
        class="mt-1 w-px flex-1 bg-(--d-border)"
        aria-hidden="true"
      />
    </div>
    <div class="min-w-0 pb-3.5">
      <div class="flex items-baseline gap-1.5 text-xs">
        <span
          class="font-semibold"
          :class="color.text"
        >{{ message.senderName }}</span>
        <span class="text-(--d-faint)">{{ recipientLabel }}</span>
        <span class="flex-1" />
        <span class="font-mono text-10.5 text-(--d-faint)">{{ formattedTime }}</span>
      </div>
      <MarkdownRenderer
        :content="message.content"
        class="mt-0.75 text-12.5 leading-[1.55] [&_.markdown-p]:my-0"
      />
    </div>
  </div>
</template>
