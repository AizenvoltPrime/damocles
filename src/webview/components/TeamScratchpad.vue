<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ScratchpadEntry, TeamAgent } from '@shared/types/team';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { IconChevronRight, IconChevronDown } from '@/components/icons';
import { getAgentColor } from '@/composables/useTeamFormatting';
import MarkdownRenderer from './MarkdownRenderer.vue';

const { t } = useI18n();

const props = defineProps<{
  entries: ScratchpadEntry[];
  agents: TeamAgent[];
}>();

const sortedEntries = computed(() =>
  [...props.entries].sort((a, b) => a.timestamp - b.timestamp)
);

const openSections = ref<Set<string>>(new Set());
const initializedSections = ref<Set<string>>(new Set());

function sectionKey(entry: ScratchpadEntry): string {
  return `${entry.section}-${entry.version}`;
}

function isSectionOpen(entry: ScratchpadEntry): boolean {
  const key = sectionKey(entry);
  if (!initializedSections.value.has(key)) {
    initializedSections.value.add(key);
    openSections.value.add(key);
  }
  return openSections.value.has(key);
}

function toggleSection(entry: ScratchpadEntry): void {
  const key = sectionKey(entry);
  const next = new Set(openSections.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  openSections.value = next;
}

function getAuthorColor(agentName: string) {
  const idx = props.agents.findIndex(a => a.name === agentName);
  return getAgentColor(idx);
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
</script>

<template>
  <ScrollArea class="h-full">
    <div class="p-3 space-y-2">
      <template v-if="sortedEntries.length === 0">
        <div class="flex flex-col items-center justify-center py-12 text-foreground/40">
          <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="mb-2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>
          <span class="text-sm">{{ t('team.scratchpad.empty') }}</span>
        </div>
      </template>

      <Collapsible v-for="entry in sortedEntries" :key="sectionKey(entry)" :open="isSectionOpen(entry)">
        <CollapsibleTrigger
          class="flex items-center gap-2 w-full px-2 py-1.5 rounded hover:bg-foreground/5 transition-colors cursor-pointer"
          @click="toggleSection(entry)"
        >
          <component :is="isSectionOpen(entry) ? IconChevronDown : IconChevronRight" :size="12" class="text-foreground/40 shrink-0" />
          <span class="font-mono text-xs text-foreground font-medium">{{ entry.section }}</span>
          <Badge variant="secondary" :class="getAuthorColor(entry.agentName).text" class="text-[10px] px-1.5 py-0 ml-auto">
            {{ entry.agentName }}
          </Badge>
          <span class="text-[10px] text-foreground/30">v{{ entry.version }}</span>
          <span class="text-[10px] text-foreground/30">{{ formatTime(entry.timestamp) }}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div class="px-2 py-2 ml-4 text-xs text-foreground/80 border-l-2 border-border/30">
            <MarkdownRenderer :content="entry.content" />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  </ScrollArea>
</template>
