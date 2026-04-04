<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TeamMessage, TeamAgent } from '@shared/types/team';
import TeamTimelineEntry from './TeamTimelineEntry.vue';
import { ScrollArea } from '@/components/ui/scroll-area';

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
  <ScrollArea class="h-full">
    <div class="p-3 space-y-0">
      <template v-if="timelineItems.length === 0">
        <div class="flex flex-col items-center justify-center py-12 text-foreground/40">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="mb-2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span class="text-sm">{{ t('team.timeline.empty') }}</span>
        </div>
      </template>
      <template v-for="(item, idx) in timelineItems" :key="item.message?.messageId ?? `sep-${idx}`">
        <div v-if="item.type === 'separator'" class="flex items-center gap-2 py-2">
          <div class="flex-1 h-px bg-border/30" />
          <span class="text-[10px] text-foreground/30">{{ item.label }}</span>
          <div class="flex-1 h-px bg-border/30" />
        </div>
        <TeamTimelineEntry
          v-else-if="item.message"
          :message="item.message"
          :agents="agents"
        />
      </template>
    </div>
  </ScrollArea>
</template>
