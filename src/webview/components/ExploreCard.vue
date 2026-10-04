<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import type { ExploreEntry } from '@/stores/useExploreStore';
import { formatModelDisplayName } from '@shared/utils';
import { useI18n } from 'vue-i18n';
import { ChevronRight, Compass } from 'lucide-vue-next';
import { agentStatusChip } from '@/composables/useTeamFormatting';

const { t } = useI18n();

const props = defineProps<{
  explore: ExploreEntry;
}>();

defineEmits<{
  (e: 'expand'): void;
}>();

const elapsedSeconds = ref(0);
let timerInterval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  if (props.explore.status === 'running') {
    updateElapsed();
    timerInterval = setInterval(updateElapsed, 1000);
  } else {
    updateElapsed();
  }
});

onUnmounted(() => {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
});

function updateElapsed(): void {
  const endTime = props.explore.endTime ?? Date.now();
  elapsedSeconds.value = Math.floor((endTime - props.explore.startTime) / 1000);
}

const formattedDuration = computed(() => {
  const elapsed = elapsedSeconds.value;
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
});

const chip = computed(() => agentStatusChip(props.explore.status));

const displayModel = computed(() => formatModelDisplayName(props.explore.model));
</script>

<template>
  <div
    class="cursor-pointer overflow-hidden rounded-xl border bg-(--d-card) text-13 transition-colors duration-200 hover:border-(--d-border2)"
    :class="explore.status === 'running' ? 'border-[color-mix(in_srgb,var(--d-accent)_35%,var(--d-border))]' : explore.status === 'failed' ? 'border-[color-mix(in_srgb,var(--d-danger)_45%,var(--d-border))]' : 'border-(--d-border)'"
    data-testid="explore-card"
    @click="$emit('expand')"
  >
    <div class="flex items-center gap-2.5 px-3 pt-2.25 pb-2">
      <span
        class="flex size-7 flex-none items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--d-info)_14%,transparent)] text-(--d-info)"
        aria-hidden="true"
      >
        <Compass class="size-3.5" />
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-px">
        <span class="truncate font-semibold">{{ explore.description }}</span>
        <span class="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-11 text-(--d-faint)">
          <span class="font-semibold text-(--d-info)">{{ t('explore.kind') }}</span>
          <template v-if="displayModel">
            <span aria-hidden="true">·</span>
            <span class="truncate">{{ displayModel }}</span>
          </template>
        </span>
      </div>
      <span
        class="flex flex-none items-center gap-1.25 rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_13%,transparent)] px-2 py-0.5 text-11 font-medium"
        :class="chip.color"
      >
        <component
          :is="chip.icon"
          class="size-2.75"
          :class="chip.live && 'd-spinning'"
          aria-hidden="true"
        />{{ t(chip.labelKey) }}
      </span>
    </div>
    <div
      v-if="explore.status === 'running' && explore.lastToolName"
      class="-mt-0.5 mr-3 mb-2 ml-12.5 truncate text-xs text-(--d-accent) italic"
    >
      {{ explore.lastToolName }}
    </div>
    <div class="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-(--d-border) py-1.5 pr-3 pl-12.5 font-mono text-11 text-(--d-faint)">
      <span>{{ t('subagentDisplay.tools', { n: explore.toolCount }, explore.toolCount) }}</span>
      <span class="tabular-nums">{{ formattedDuration }}</span>
      <span class="flex-1" />
      <button
        type="button"
        class="flex items-center gap-0.75 rounded-sm font-sans text-(--d-muted) hover:text-(--d-text)"
        :aria-label="t('cards.subagent.open', { name: explore.description })"
        @click.stop="$emit('expand')"
      >
        {{ t('cards.details') }}<ChevronRight
          class="size-2.75"
          aria-hidden="true"
        />
      </button>
    </div>
  </div>
</template>
