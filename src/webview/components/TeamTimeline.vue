<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { MessagesSquare } from 'lucide-vue-next';
import type { TeamMessage, TeamAgent } from '@shared/types/team';
import TeamTimelineEntry from './TeamTimelineEntry.vue';

const { t } = useI18n();

const props = defineProps<{
  messages: TeamMessage[];
  agents: TeamAgent[];
}>();

const sortedMessages = computed(() =>
  [...props.messages].sort((a, b) => a.timestamp - b.timestamp)
);

interface TimelineItem {
  type: 'message' | 'separator';
  message?: TeamMessage;
  label?: string;
}

const timelineItems = computed((): TimelineItem[] => {
  const items: TimelineItem[] = [];
  let lastTimestamp = 0;

  for (const msg of sortedMessages.value) {
    if (lastTimestamp && msg.timestamp - lastTimestamp > 30000) {
      const gap = Math.round((msg.timestamp - lastTimestamp) / 1000);
      items.push({ type: 'separator', label: t('team.timeline.gap', { n: gap }) });
    }
    items.push({ type: 'message', message: msg });
    lastTimestamp = msg.timestamp;
  }
  return items;
});
</script>

<template>
  <div class="flex flex-col">
    <div
      v-if="timelineItems.length === 0"
      class="flex flex-col items-center gap-2 py-10 text-12.5 text-(--d-faint)"
    >
      <MessagesSquare
        class="size-5.5"
        aria-hidden="true"
      />
      {{ t('team.timeline.empty') }}
    </div>
    <template
      v-for="(item, idx) in timelineItems"
      :key="item.message?.messageId ?? `sep-${idx}`"
    >
      <div
        v-if="item.type === 'separator'"
        class="flex items-center gap-2 pb-3.5 text-10.5 text-(--d-faint)"
      >
        <span class="h-px flex-1 bg-(--d-border)" />
        <span class="font-mono">{{ item.label }}</span>
        <span class="h-px flex-1 bg-(--d-border)" />
      </div>
      <TeamTimelineEntry
        v-else-if="item.message"
        :message="item.message"
        :agents="agents"
        :style="{ animationDelay: `${Math.min(idx, 12) * 30}ms` }"
      />
    </template>
  </div>
</template>
