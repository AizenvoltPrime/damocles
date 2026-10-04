<script setup lang="ts">
import { ref, computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, NotebookPen } from 'lucide-vue-next';
import type { ScratchpadEntry, TeamAgent } from '@shared/types/team';
import { getAgentColor } from '@/composables/useTeamFormatting';
import { formatClock } from '@/utils/clock';
import MarkdownRenderer from './MarkdownRenderer.vue';

const { t } = useI18n();

const props = defineProps<{
  entries: ScratchpadEntry[];
  agents: TeamAgent[];
}>();

const sortedEntries = computed(() =>
  [...props.entries].sort((a, b) => a.timestamp - b.timestamp)
);

const uid = useId();

// Sections start open, so only the ones the user closed are remembered.
const closedSections = ref<ReadonlySet<string>>(new Set());

function sectionKey(entry: ScratchpadEntry): string {
  return `${entry.section}-${entry.version}`;
}

function isSectionOpen(entry: ScratchpadEntry): boolean {
  return !closedSections.value.has(sectionKey(entry));
}

function toggleSection(entry: ScratchpadEntry): void {
  const key = sectionKey(entry);
  const next = new Set(closedSections.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  closedSections.value = next;
}

function getAuthorColor(agentName: string) {
  return getAgentColor(props.agents.findIndex(a => a.name === agentName));
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      v-if="sortedEntries.length === 0"
      class="flex flex-col items-center gap-2 py-10 text-12.5 text-(--d-faint)"
    >
      <NotebookPen
        class="size-5.5"
        aria-hidden="true"
      />
      {{ t('team.scratchpad.empty') }}
    </div>

    <div
      v-for="(entry, index) in sortedEntries"
      :key="sectionKey(entry)"
      class="overflow-hidden rounded-10 border border-(--d-border) bg-(--d-card)"
      data-testid="team-scratchpad-entry"
    >
      <button
        type="button"
        class="flex h-8.5 w-full min-w-0 items-center gap-2 px-3 text-left text-xs transition-colors hover:bg-(--d-hover)"
        :aria-expanded="isSectionOpen(entry)"
        :aria-controls="`${uid}-${index}`"
        @click="toggleSection(entry)"
      >
        <ChevronRight
          class="size-3.25 flex-none text-(--d-muted) transition-transform duration-200"
          :class="isSectionOpen(entry) && 'rotate-90'"
          aria-hidden="true"
        />
        <span class="min-w-0 truncate font-mono font-semibold">{{ entry.section }}</span>
        <span class="flex-1" />
        <span
          class="flex flex-none items-center gap-1.25 text-11"
          :class="getAuthorColor(entry.agentName).text"
        >
          <span
            class="size-1.5 rounded-full"
            :class="getAuthorColor(entry.agentName).dot"
            aria-hidden="true"
          />{{ entry.agentName }}
        </span>
        <span class="flex-none font-mono text-10.5 text-(--d-faint)">v{{ entry.version }}</span>
        <span class="flex-none font-mono text-10.5 text-(--d-faint)">{{ formatClock(entry.timestamp, undefined, { seconds: true }) }}</span>
      </button>
      <Transition name="t-fade">
        <div
          v-if="isSectionOpen(entry)"
          :id="`${uid}-${index}`"
          class="pt-0 pr-3.5 pb-3 pl-8.25 text-12.5 leading-[1.55]"
        >
          <MarkdownRenderer :content="entry.content" />
        </div>
      </Transition>
    </div>
  </div>
</template>
