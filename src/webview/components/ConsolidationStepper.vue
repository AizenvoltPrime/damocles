<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import {
  IconDatabase,
  IconSparkles,
  IconLayers,
  IconRepeat,
  IconFileText,
  IconCheck,
  IconXCircle,
  IconBan,
} from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import { useConsolidationStore } from '@/stores/useConsolidationStore';
import type { ConsolidationPhaseId } from '@shared/types/consolidation';

const store = useConsolidationStore();
const { phaseStatus, phaseMeta, persistProgress } = storeToRefs(store);

const PHASES: { id: ConsolidationPhaseId; label: string; icon: typeof IconDatabase }[] = [
  { id: 'claim', label: 'Claim', icon: IconDatabase },
  { id: 'extract', label: 'Extract', icon: IconSparkles },
  { id: 'persist', label: 'Persist', icon: IconLayers },
  { id: 'maintain', label: 'Maintain', icon: IconRepeat },
  { id: 'profiles', label: 'Profiles', icon: IconFileText },
];

/** Trailing text per phase: real counts on done rows, reason/summary on skipped/failed rows. */
function trailing(id: ConsolidationPhaseId): string {
  const status = phaseStatus.value[id];
  const meta = phaseMeta.value[id];
  if (id === 'claim' && status === 'done') {
    const n = meta.count ?? 0;
    return `${n} turn${n === 1 ? '' : 's'}`;
  }
  if (id === 'extract') {
    if (status === 'active') return 'reading turns…';
    if (status === 'done') {
      const n = meta.count ?? 0;
      return `${n} found`;
    }
  }
  if (id === 'persist') {
    if (status === 'active') return `${persistProgress.value.done}/${persistProgress.value.total}`;
    if (status === 'done') {
      const n = meta.done ?? 0;
      return `${n} item${n === 1 ? '' : 's'}`;
    }
  }
  if (id === 'maintain' && status === 'done') return meta.summary ?? '';
  if (id === 'profiles' && status === 'done') return 'project · global';
  if (status === 'skipped') return meta.reason ? `skipped — ${meta.reason}` : 'skipped';
  if (status === 'failed') return meta.reason ?? 'failed';
  return '';
}

const rows = computed(() =>
  PHASES.map((p, i) => ({
    ...p,
    status: phaseStatus.value[p.id],
    trailing: trailing(p.id),
    last: i === PHASES.length - 1,
  })),
);
</script>

<template>
  <ul class="space-y-0">
    <li
      v-for="row in rows"
      :key="row.id"
      class="relative flex items-start gap-3 pl-0"
      :aria-current="row.status === 'active' ? 'step' : undefined"
    >
      <!-- Marker + connector gutter (20px) -->
      <div class="relative flex flex-col items-center w-5 shrink-0">
        <div class="flex items-center justify-center h-5 w-5">
          <LoadingSpinner
            v-if="row.status === 'active'"
            :size="14"
            class="text-primary"
          />
          <IconCheck
            v-else-if="row.status === 'done'"
            :size="13"
            class="text-success"
          />
          <IconBan
            v-else-if="row.status === 'skipped'"
            :size="12"
            class="text-muted-foreground/60"
          />
          <IconXCircle
            v-else-if="row.status === 'failed'"
            :size="13"
            class="text-error"
          />
          <span
            v-else
            class="h-2.5 w-2.5 rounded-full border border-muted-foreground/30"
          />
        </div>
        <span
          v-if="!row.last"
          class="w-px flex-1 min-h-[14px] my-0.5"
          :class="row.status === 'done' ? 'bg-success/30' : 'bg-border/60'"
        />
      </div>

      <!-- Label + trailing -->
      <div class="flex-1 min-w-0 flex items-baseline justify-between gap-2 pb-3">
        <span
          class="text-xs"
          :class="{
            'text-primary font-medium': row.status === 'active',
            'text-foreground/90': row.status === 'done',
            'text-muted-foreground/60 italic': row.status === 'skipped',
            'text-error font-medium': row.status === 'failed',
            'text-muted-foreground/50': row.status === 'pending',
          }"
        >{{ row.label }}</span>
        <span
          v-if="row.trailing"
          class="text-[11px] tabular-nums truncate"
          :class="row.status === 'failed' ? 'text-error/80' : 'text-muted-foreground'"
        >{{ row.trailing }}</span>
      </div>
    </li>
  </ul>
</template>
